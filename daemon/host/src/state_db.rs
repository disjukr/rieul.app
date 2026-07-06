use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use rusqlite::Connection;
use wgo_daemon_core::rpc::{
    JobInfo, JobOutputState, JobOutputStream, JobRunReason, JobStatus, ScheduleInfo,
};

const SCHEMA_VERSION: i32 = 1;

const INITIAL_SCHEMA: &str = r#"
CREATE TABLE command_schedules (
  schedule_id TEXT PRIMARY KEY,
  model BLOB NOT NULL,
  rrule_set TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX command_schedules_archived_idx
  ON command_schedules(archived, enabled, updated_at_ms);

CREATE TABLE command_jobs (
  job_id TEXT PRIMARY KEY,
  model BLOB NOT NULL,
  reason_kind TEXT NOT NULL,
  schedule_id TEXT REFERENCES command_schedules(schedule_id) ON DELETE CASCADE,
  status_kind TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER
);

CREATE INDEX command_jobs_status_idx
  ON command_jobs(status_kind, created_at_ms);

CREATE INDEX command_jobs_schedule_idx
  ON command_jobs(schedule_id, created_at_ms);

CREATE TABLE command_job_output_state (
  job_id TEXT NOT NULL REFERENCES command_jobs(job_id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  oldest_seq INTEGER NOT NULL,
  latest_seq INTEGER NOT NULL,
  retained_bytes INTEGER NOT NULL,
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  max_bytes INTEGER,
  PRIMARY KEY (job_id, stream)
);

CREATE TABLE command_job_output_chunks (
  job_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  seq INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (job_id, stream, seq),
  FOREIGN KEY (job_id, stream)
    REFERENCES command_job_output_state(job_id, stream)
    ON DELETE CASCADE
);
"#;

pub struct DaemonStateDb {
    path: PathBuf,
    connection: Connection,
}

impl DaemonStateDb {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create daemon state directory {}", parent.display()))?;
        }

        let mut connection = Connection::open(path)
            .with_context(|| format!("open daemon state database {}", path.display()))?;
        configure_connection(&connection)?;
        migrate(&mut connection)?;
        Ok(Self {
            path: path.to_path_buf(),
            connection,
        })
    }

    pub fn open_in_memory_for_tests() -> Result<Self> {
        let mut connection =
            Connection::open_in_memory().context("open in-memory daemon state database")?;
        configure_connection(&connection)?;
        migrate(&mut connection)?;
        Ok(Self {
            path: PathBuf::from(":memory:"),
            connection,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn schema_version(&self) -> Result<i32> {
        schema_version(&self.connection)
    }

    pub fn load_schedules(&self) -> Result<Vec<ScheduleInfo>> {
        let mut statement = self
            .connection
            .prepare("SELECT model FROM command_schedules ORDER BY created_at_ms")
            .context("prepare schedule load")?;
        let rows = statement
            .query_map([], |row| row.get::<_, Vec<u8>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("load schedule rows")?;
        rows.into_iter()
            .map(|bytes| ScheduleInfo::decode(&bytes).context("decode stored schedule"))
            .collect()
    }

    pub fn load_jobs(&self) -> Result<Vec<JobInfo>> {
        let mut statement = self
            .connection
            .prepare("SELECT model FROM command_jobs ORDER BY created_at_ms")
            .context("prepare job load")?;
        let rows = statement
            .query_map([], |row| row.get::<_, Vec<u8>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("load job rows")?;
        rows.into_iter()
            .map(|bytes| JobInfo::decode(&bytes).context("decode stored job"))
            .collect()
    }

    pub fn save_schedule(&self, schedule: &ScheduleInfo) -> Result<()> {
        self.connection
            .execute(
                r#"
                INSERT INTO command_schedules (
                  schedule_id, model, rrule_set, enabled, archived,
                  created_at_ms, updated_at_ms
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(schedule_id) DO UPDATE SET
                  model = excluded.model,
                  rrule_set = excluded.rrule_set,
                  enabled = excluded.enabled,
                  archived = excluded.archived,
                  updated_at_ms = excluded.updated_at_ms
                "#,
                (
                    &schedule.schedule_id,
                    schedule.encode(),
                    &schedule.rrule_set,
                    bool_to_i64(schedule.enabled),
                    bool_to_i64(schedule.archived),
                    schedule.created_at_ms as i64,
                    schedule.updated_at_ms as i64,
                ),
            )
            .context("save schedule")?;
        Ok(())
    }

    pub fn delete_schedule(&self, schedule_id: &str) -> Result<bool> {
        let removed = self
            .connection
            .execute(
                "DELETE FROM command_schedules WHERE schedule_id = ?1",
                [schedule_id],
            )
            .context("delete schedule")?;
        Ok(removed > 0)
    }

    pub fn save_job(&self, job: &JobInfo) -> Result<()> {
        self.connection
            .execute(
                r#"
                INSERT INTO command_jobs (
                  job_id, model, reason_kind, schedule_id, status_kind,
                  created_at_ms, started_at_ms, finished_at_ms
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(job_id) DO UPDATE SET
                  model = excluded.model,
                  reason_kind = excluded.reason_kind,
                  schedule_id = excluded.schedule_id,
                  status_kind = excluded.status_kind,
                  started_at_ms = excluded.started_at_ms,
                  finished_at_ms = excluded.finished_at_ms
                "#,
                (
                    &job.job_id,
                    job.encode(),
                    job_reason_kind(&job.reason),
                    job_schedule_id(&job.reason),
                    job_status_kind(&job.status),
                    job.created_at_ms as i64,
                    job.started_at_ms.map(|value| value as i64),
                    job.finished_at_ms.map(|value| value as i64),
                ),
            )
            .context("save job")?;
        Ok(())
    }

    pub fn delete_job(&self, job_id: &str) -> Result<bool> {
        let removed = self
            .connection
            .execute("DELETE FROM command_jobs WHERE job_id = ?1", [job_id])
            .context("delete job")?;
        Ok(removed > 0)
    }

    pub fn save_job_output_state(
        &self,
        job_id: &str,
        stream: JobOutputStream,
        state: &JobOutputState,
    ) -> Result<()> {
        self.connection
            .execute(
                r#"
                INSERT INTO command_job_output_state (
                  job_id, stream, enabled, oldest_seq, latest_seq,
                  retained_bytes, truncated, max_bytes
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
                ON CONFLICT(job_id, stream) DO UPDATE SET
                  enabled = excluded.enabled,
                  oldest_seq = excluded.oldest_seq,
                  latest_seq = excluded.latest_seq,
                  retained_bytes = excluded.retained_bytes,
                  truncated = excluded.truncated
                "#,
                (
                    job_id,
                    job_output_stream_name(stream),
                    bool_to_i64(state.enabled),
                    state.oldest_seq as i64,
                    state.latest_seq as i64,
                    state.retained_bytes as i64,
                    bool_to_i64(state.truncated),
                ),
            )
            .context("save job output state")?;
        Ok(())
    }

    pub fn append_job_output_chunk(
        &self,
        job_id: &str,
        stream: JobOutputStream,
        seq: u64,
        bytes: &[u8],
        created_at_ms: u64,
    ) -> Result<()> {
        self.connection
            .execute(
                r#"
                INSERT OR REPLACE INTO command_job_output_chunks
                  (job_id, stream, seq, bytes, created_at_ms)
                VALUES (?1, ?2, ?3, ?4, ?5)
                "#,
                (
                    job_id,
                    job_output_stream_name(stream),
                    seq as i64,
                    bytes,
                    created_at_ms as i64,
                ),
            )
            .context("append job output chunk")?;
        Ok(())
    }
}

fn configure_connection(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            PRAGMA journal_mode = WAL;
            "#,
        )
        .context("configure daemon state database")
}

fn migrate(connection: &mut Connection) -> Result<()> {
    let version = schema_version(connection)?;
    if version > SCHEMA_VERSION {
        bail!(
            "daemon state database schema version {version} is newer than supported version {SCHEMA_VERSION}"
        );
    }
    if version == SCHEMA_VERSION {
        return Ok(());
    }

    let tx = connection
        .transaction()
        .context("start daemon state database migration")?;
    if version == 0 {
        tx.execute_batch(INITIAL_SCHEMA)
            .context("create daemon state database schema")?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)
        .context("set daemon state database schema version")?;
    tx.commit()
        .context("commit daemon state database migration")?;
    Ok(())
}

fn schema_version(connection: &Connection) -> Result<i32> {
    connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .context("read daemon state database schema version")
}

fn bool_to_i64(value: bool) -> i64 {
    if value { 1 } else { 0 }
}

fn job_reason_kind(reason: &JobRunReason) -> &'static str {
    match reason {
        JobRunReason::Manual => "manual",
        JobRunReason::Schedule { .. } => "schedule",
    }
}

fn job_schedule_id(reason: &JobRunReason) -> Option<&str> {
    match reason {
        JobRunReason::Manual => None,
        JobRunReason::Schedule { schedule_id, .. } => Some(schedule_id.as_str()),
    }
}

fn job_status_kind(status: &JobStatus) -> &'static str {
    match status {
        JobStatus::Running => "running",
        JobStatus::Exited { .. } => "exited",
    }
}

fn job_output_stream_name(stream: JobOutputStream) -> &'static str {
    match stream {
        JobOutputStream::Stdout => "stdout",
        JobOutputStream::Stderr => "stderr",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_database_and_creates_schema() {
        let db = DaemonStateDb::open_in_memory_for_tests().unwrap();

        assert_eq!(db.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(table_exists(&db.connection, "command_schedules"));
        assert!(table_exists(&db.connection, "command_jobs"));
        assert!(table_exists(&db.connection, "command_job_output_state"));
        assert!(table_exists(&db.connection, "command_job_output_chunks"));
    }

    #[test]
    fn creates_parent_directory_for_file_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("daemon-state.sqlite3");

        let db = DaemonStateDb::open(&path).unwrap();

        assert_eq!(db.path(), path.as_path());
        assert_eq!(db.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(path.exists());
    }

    #[test]
    fn enables_foreign_keys() {
        let db = DaemonStateDb::open_in_memory_for_tests().unwrap();
        let enabled: i32 = db
            .connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();

        assert_eq!(enabled, 1);
    }

    #[test]
    fn rejects_newer_schema_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon-state.sqlite3");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
                .unwrap();
        }

        let err = match DaemonStateDb::open(&path) {
            Ok(_) => panic!("newer schema version should be rejected"),
            Err(err) => err,
        };

        assert!(err.to_string().contains("newer than supported"));
    }

    fn table_exists(connection: &Connection, table_name: &str) -> bool {
        connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = ?1
                )",
                [table_name],
                |row| row.get::<_, i32>(0),
            )
            .unwrap()
            == 1
    }
}
