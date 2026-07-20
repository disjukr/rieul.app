-- GENERATED FILE. DO NOT EDIT.
-- Source of truth: migrations/*.sql
-- Regenerate with: deno task db-schema:generate
-- Schema version: 1

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

PRAGMA user_version = 1;
