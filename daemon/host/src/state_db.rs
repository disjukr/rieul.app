use std::fs;
use std::path::{Path, PathBuf};

use crate::db_schema::{MIGRATIONS, SCHEMA_VERSION};
use anyhow::{bail, Context, Result};
use rieul_daemon_core::rpc::{
    JobInfo, JobOutputState, JobOutputStream, JobRunReason, JobStatus, ScheduleInfo,
};
use rusqlite::{Connection, OptionalExtension};

pub struct DaemonStateDb {
    path: PathBuf,
    connection: Connection,
}

pub struct StoredJobOutput {
    pub state: JobOutputState,
    pub chunks: Vec<StoredJobOutputChunk>,
}

pub struct StoredJobOutputChunk {
    pub seq: u64,
    pub bytes: Vec<u8>,
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

    pub fn load_job_output(
        &self,
        job_id: &str,
        stream: JobOutputStream,
    ) -> Result<Option<StoredJobOutput>> {
        let stream = job_output_stream_name(stream);
        let state = self
            .connection
            .query_row(
                r#"
                SELECT enabled, oldest_seq, latest_seq, retained_bytes, truncated
                FROM command_job_output_state
                WHERE job_id = ?1 AND stream = ?2
                "#,
                (job_id, stream),
                |row| {
                    Ok(JobOutputState {
                        enabled: i64_to_bool(row.get::<_, i64>(0)?),
                        oldest_seq: row.get::<_, i64>(1)? as u64,
                        latest_seq: row.get::<_, i64>(2)? as u64,
                        retained_bytes: row.get::<_, i64>(3)? as u64,
                        truncated: i64_to_bool(row.get::<_, i64>(4)?),
                    })
                },
            )
            .optional()
            .context("load job output state")?;
        let Some(state) = state else {
            return Ok(None);
        };

        let mut statement = self
            .connection
            .prepare(
                r#"
                SELECT seq, bytes
                FROM command_job_output_chunks
                WHERE job_id = ?1 AND stream = ?2
                ORDER BY seq
                "#,
            )
            .context("prepare job output chunks load")?;
        let chunks = statement
            .query_map((job_id, stream), |row| {
                Ok(StoredJobOutputChunk {
                    seq: row.get::<_, i64>(0)? as u64,
                    bytes: row.get::<_, Vec<u8>>(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("load job output chunks")?;

        Ok(Some(StoredJobOutput { state, chunks }))
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
        let stream = job_output_stream_name(stream);
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
                    stream,
                    bool_to_i64(state.enabled),
                    state.oldest_seq as i64,
                    state.latest_seq as i64,
                    state.retained_bytes as i64,
                    bool_to_i64(state.truncated),
                ),
            )
            .context("save job output state")?;
        if state.oldest_seq > 0 {
            self.connection
                .execute(
                    r#"
                    DELETE FROM command_job_output_chunks
                    WHERE job_id = ?1 AND stream = ?2 AND seq < ?3
                    "#,
                    (job_id, stream, state.oldest_seq as i64),
                )
                .context("prune old job output chunks")?;
        } else {
            self.connection
                .execute(
                    r#"
                    DELETE FROM command_job_output_chunks
                    WHERE job_id = ?1 AND stream = ?2
                    "#,
                    (job_id, stream),
                )
                .context("prune disabled job output chunks")?;
        }
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
                SELECT ?1, ?2, ?3, ?4, ?5
                WHERE EXISTS (
                  SELECT 1
                  FROM command_job_output_state
                  WHERE job_id = ?1
                    AND stream = ?2
                    AND enabled != 0
                    AND oldest_seq > 0
                    AND ?3 >= oldest_seq
                    AND ?3 <= latest_seq
                )
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
    for migration in MIGRATIONS.iter().skip(version as usize) {
        tx.execute_batch(migration.sql)
            .with_context(|| format!("apply daemon state database migration {}", migration.name))?;
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
    if value {
        1
    } else {
        0
    }
}

fn i64_to_bool(value: i64) -> bool {
    value != 0
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
        assert!(table_exists(&db.connection, "agent_projects"));
        assert!(table_exists(&db.connection, "agent_task_workspaces"));
        assert!(table_exists(&db.connection, "agent_sessions"));
        assert!(table_exists(&db.connection, "agent_session_catalog_state"));
        assert!(table_exists(
            &db.connection,
            "agent_session_catalog_changes"
        ));
        assert!(table_exists(&db.connection, "agent_session_turns"));
        assert!(table_exists(&db.connection, "agent_turn_contexts"));
        assert!(table_exists(&db.connection, "agent_turn_context_entities"));
        assert!(table_exists(&db.connection, "agent_turn_context_resources"));
        assert!(table_exists(&db.connection, "agent_messages"));
        assert!(table_exists(&db.connection, "agent_message_contents"));
        assert!(table_exists(&db.connection, "agent_tool_calls"));
        assert!(table_exists(&db.connection, "agent_tool_call_locations"));
        assert!(table_exists(&db.connection, "agent_tool_call_contents"));
        assert!(table_exists(&db.connection, "agent_permission_requests"));
        assert!(table_exists(&db.connection, "agent_permission_options"));
        assert!(table_exists(&db.connection, "agent_turn_plans"));
        assert!(table_exists(&db.connection, "agent_plan_entries"));
        assert!(table_exists(&db.connection, "agent_session_config_values"));
        assert!(table_exists(&db.connection, "agent_terminals"));
        assert!(table_exists(&db.connection, "agent_terminal_args"));
        assert!(table_exists(&db.connection, "agent_terminal_output_chunks"));
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

    #[test]
    fn migrates_existing_v1_database_to_agent_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon-state.sqlite3");
        {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch(MIGRATIONS[0].sql).unwrap();
            connection.pragma_update(None, "user_version", 1).unwrap();
        }

        let db = DaemonStateDb::open(&path).unwrap();

        assert_eq!(db.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(table_exists(&db.connection, "agent_sessions"));
        assert!(table_exists(&db.connection, "agent_session_turns"));
    }

    #[test]
    fn removing_agent_project_preserves_session_reference() {
        let db = DaemonStateDb::open_in_memory_for_tests().unwrap();
        db.connection
            .execute(
                "INSERT INTO agent_projects (
                    project_id, title, root_path, created_at_ms
                ) VALUES (?1, ?2, ?3, ?4)",
                ("project-1", "Project", "/project", 1_i64),
            )
            .unwrap();
        db.connection
            .execute(
                "INSERT INTO agent_sessions (
                    session_id, provider_id, workspace_kind, project_id, cwd,
                    archived, created_at_ms, updated_at_ms
                ) VALUES (?1, ?2, 'project', ?3, ?4, 0, ?5, ?5)",
                ("session-1", "agent-1", "project-1", "/project", 1_i64),
            )
            .unwrap();

        db.connection
            .execute(
                "DELETE FROM agent_projects WHERE project_id = ?1",
                ["project-1"],
            )
            .unwrap();

        let project_id = db
            .connection
            .query_row(
                "SELECT project_id FROM agent_sessions WHERE session_id = ?1",
                ["session-1"],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(project_id, "project-1");
    }

    #[test]
    fn normalized_agent_state_cascades_with_session() {
        let db = DaemonStateDb::open_in_memory_for_tests().unwrap();
        db.connection
            .execute_batch(
                r#"
                INSERT INTO agent_sessions (
                  session_id, provider_id, workspace_kind, project_id, cwd,
                  archived, created_at_ms, updated_at_ms
                ) VALUES ('session-1', 'agent-1', 'project', 'project-1', '/project', 0, 1, 1);

                INSERT INTO agent_session_turns (
                  turn_id, session_id, client_request_id, state_kind,
                  completed_seq, stop_reason_kind, created_at_ms,
                  finished_at_ms, updated_at_ms
                ) VALUES (
                  'turn-1', 'session-1', 'request-1', 'completed',
                  1, 'end_turn', 1, 2, 2
                );

                INSERT INTO agent_turn_contexts (
                  turn_id, captured_at_ms, daemon_instance_id, surface_id, truncated
                ) VALUES ('turn-1', 1, 'daemon-1', 'daemon.process.detail', 0);

                INSERT INTO agent_turn_context_entities (
                  turn_id, entity_index, role_kind, entity_kind, filesystem_path
                ) VALUES ('turn-1', 0, 'primary', 'filesystem_path', '/project');

                INSERT INTO agent_turn_context_resources (
                  turn_id, resource_index, role_kind, uri, name,
                  snapshot_mime_type, snapshot_json
                ) VALUES (
                  'turn-1', 0, 'primary', 'rieul://process/1', 'Process 1',
                  'application/json', '{"pid":1}'
                );

                INSERT INTO agent_messages (
                  session_id, message_id, turn_id, role_kind, state_kind, created_at_ms
                ) VALUES ('session-1', 'message-1', 'turn-1', 'assistant', 'complete', 1);

                INSERT INTO agent_message_contents (
                  session_id, message_id, content_index, content_kind, text_value
                ) VALUES ('session-1', 'message-1', 0, 'text', 'done');

                INSERT INTO agent_tool_calls (
                  session_id, tool_call_id, turn_id, title, kind, status_kind
                ) VALUES ('session-1', 'tool-1', 'turn-1', 'Read file', 'read', 'completed');

                INSERT INTO agent_tool_call_locations (
                  session_id, tool_call_id, location_index, path, line
                ) VALUES ('session-1', 'tool-1', 0, '/project/file.txt', 1);

                INSERT INTO agent_tool_call_contents (
                  session_id, tool_call_id, content_index, content_type,
                  diff_path, diff_kind, diff_patch
                ) VALUES (
                  'session-1', 'tool-1', 0, 'diff',
                  '/project/file.txt', 'modify', '@@ -1 +1 @@'
                );

                INSERT INTO agent_permission_requests (
                  session_id, permission_request_id, turn_id, subject_kind,
                  action_title, state_kind, selected_option_id, created_at_ms
                ) VALUES (
                  'session-1', 'permission-1', 'turn-1', 'action',
                  'Continue', 'selected', 'allow', 1
                );

                INSERT INTO agent_permission_options (
                  session_id, permission_request_id, option_index,
                  option_id, title, kind
                ) VALUES (
                  'session-1', 'permission-1', 0, 'allow', 'Allow', 'allow_once'
                );

                INSERT INTO agent_turn_plans (session_id, turn_id)
                VALUES ('session-1', 'turn-1');

                INSERT INTO agent_plan_entries (
                  session_id, turn_id, entry_id, entry_index,
                  content, priority_kind, status_kind
                ) VALUES (
                  'session-1', 'turn-1', 'entry-1', 0,
                  'Inspect state', 'medium', 'completed'
                );

                INSERT INTO agent_session_config_values (
                  session_id, config_id, value_kind, boolean_value, updated_at_ms
                ) VALUES ('session-1', 'thinking', 'boolean', 1, 1);

                INSERT INTO agent_terminals (
                  session_id, terminal_id, turn_id, command, truncated,
                  oldest_output_seq, latest_output_seq, retained_bytes,
                  exited, exit_code
                ) VALUES (
                  'session-1', 'terminal-1', 'turn-1', 'echo', 0,
                  1, 1, 3, 1, 0
                );

                INSERT INTO agent_terminal_args (
                  session_id, terminal_id, arg_index, value
                ) VALUES ('session-1', 'terminal-1', 0, 'hi');

                INSERT INTO agent_terminal_output_chunks (
                  session_id, terminal_id, seq, text, created_at_ms
                ) VALUES ('session-1', 'terminal-1', 1, 'hi\n', 1);

                DELETE FROM agent_sessions WHERE session_id = 'session-1';
                "#,
            )
            .unwrap();

        for table in [
            "agent_session_turns",
            "agent_turn_contexts",
            "agent_turn_context_entities",
            "agent_turn_context_resources",
            "agent_messages",
            "agent_message_contents",
            "agent_tool_calls",
            "agent_tool_call_locations",
            "agent_tool_call_contents",
            "agent_permission_requests",
            "agent_permission_options",
            "agent_turn_plans",
            "agent_plan_entries",
            "agent_session_config_values",
            "agent_terminals",
            "agent_terminal_args",
            "agent_terminal_output_chunks",
        ] {
            assert_eq!(table_row_count(&db.connection, table), 0, "{table}");
        }
    }

    #[test]
    fn prunes_output_chunks_older_than_retained_state() {
        let db = DaemonStateDb::open_in_memory_for_tests().unwrap();
        let job = test_job();
        db.save_job(&job).unwrap();
        db.save_job_output_state(
            &job.job_id,
            JobOutputStream::Stdout,
            &JobOutputState {
                enabled: true,
                oldest_seq: 1,
                latest_seq: 3,
                retained_bytes: 3,
                truncated: false,
            },
        )
        .unwrap();
        db.append_job_output_chunk(&job.job_id, JobOutputStream::Stdout, 1, b"a", 1)
            .unwrap();
        db.append_job_output_chunk(&job.job_id, JobOutputStream::Stdout, 2, b"b", 2)
            .unwrap();
        db.append_job_output_chunk(&job.job_id, JobOutputStream::Stdout, 3, b"c", 3)
            .unwrap();

        db.save_job_output_state(
            &job.job_id,
            JobOutputStream::Stdout,
            &JobOutputState {
                enabled: true,
                oldest_seq: 3,
                latest_seq: 3,
                retained_bytes: 1,
                truncated: true,
            },
        )
        .unwrap();

        let remaining = output_chunk_seqs(&db, &job.job_id, "stdout");
        assert_eq!(remaining, vec![3]);
    }

    #[test]
    fn ignores_output_chunks_not_retained_by_state() {
        let db = DaemonStateDb::open_in_memory_for_tests().unwrap();
        let job = test_job();
        db.save_job(&job).unwrap();
        db.save_job_output_state(
            &job.job_id,
            JobOutputStream::Stdout,
            &JobOutputState {
                enabled: true,
                oldest_seq: 0,
                latest_seq: 1,
                retained_bytes: 0,
                truncated: true,
            },
        )
        .unwrap();

        db.append_job_output_chunk(&job.job_id, JobOutputStream::Stdout, 1, b"evicted", 1)
            .unwrap();

        let remaining = output_chunk_seqs(&db, &job.job_id, "stdout");
        assert!(remaining.is_empty());
    }

    #[test]
    fn loads_persisted_output_state_and_chunks() {
        let db = DaemonStateDb::open_in_memory_for_tests().unwrap();
        let job = test_job();
        db.save_job(&job).unwrap();
        db.save_job_output_state(
            &job.job_id,
            JobOutputStream::Stdout,
            &JobOutputState {
                enabled: true,
                oldest_seq: 2,
                latest_seq: 3,
                retained_bytes: 2,
                truncated: true,
            },
        )
        .unwrap();
        db.append_job_output_chunk(&job.job_id, JobOutputStream::Stdout, 2, b"b", 2)
            .unwrap();
        db.append_job_output_chunk(&job.job_id, JobOutputStream::Stdout, 3, b"c", 3)
            .unwrap();

        let output = db
            .load_job_output(&job.job_id, JobOutputStream::Stdout)
            .unwrap()
            .expect("stored output");

        assert_eq!(output.state.oldest_seq, 2);
        assert_eq!(output.state.latest_seq, 3);
        assert!(output.state.truncated);
        assert_eq!(
            output
                .chunks
                .into_iter()
                .map(|chunk| (chunk.seq, chunk.bytes))
                .collect::<Vec<_>>(),
            vec![(2, b"b".to_vec()), (3, b"c".to_vec())]
        );
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

    fn output_chunk_seqs(db: &DaemonStateDb, job_id: &str, stream: &str) -> Vec<i64> {
        let mut statement = db
            .connection
            .prepare(
                "SELECT seq FROM command_job_output_chunks
                WHERE job_id = ?1 AND stream = ?2
                ORDER BY seq",
            )
            .unwrap();
        statement
            .query_map((job_id, stream), |row| row.get::<_, i64>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    fn table_row_count(connection: &Connection, table_name: &str) -> i64 {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table_name}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn test_job() -> JobInfo {
        JobInfo {
            job_id: "job-test".to_string(),
            title: None,
            launch: rieul_daemon_core::rpc::CommandLaunchSpec {
                command: "test".to_string(),
                args: Vec::new(),
                cwd: None,
                env: None,
                stdin: None,
                elevated: None,
            },
            created_at_ms: 1,
            started_at_ms: Some(1),
            finished_at_ms: None,
            status: JobStatus::Running,
            reason: JobRunReason::Manual,
            log: rieul_daemon_core::rpc::JobLogState {
                stdout: JobOutputState {
                    enabled: true,
                    oldest_seq: 0,
                    latest_seq: 0,
                    retained_bytes: 0,
                    truncated: false,
                },
                stderr: JobOutputState {
                    enabled: false,
                    oldest_seq: 0,
                    latest_seq: 0,
                    retained_bytes: 0,
                    truncated: false,
                },
            },
        }
    }
}
