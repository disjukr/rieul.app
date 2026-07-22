CREATE TABLE agent_projects (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  last_opened_at_ms INTEGER
);

CREATE INDEX agent_projects_last_opened_idx
  ON agent_projects(last_opened_at_ms DESC, created_at_ms DESC);

CREATE TABLE agent_task_workspaces (
  task_workspace_id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('empty', 'git_worktree', 'copy')),
  source_project_id TEXT,
  git_base_ref TEXT,
  copy_include_untracked INTEGER
    CHECK (copy_include_untracked IS NULL OR copy_include_untracked IN (0, 1)),
  state_kind TEXT NOT NULL
    CHECK (state_kind IN ('provisioning', 'ready', 'missing', 'cleanup_pending')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (
    (
      source_kind = 'empty'
      AND source_project_id IS NULL
      AND git_base_ref IS NULL
      AND copy_include_untracked IS NULL
    )
    OR
    (
      source_kind = 'git_worktree'
      AND source_project_id IS NOT NULL
      AND copy_include_untracked IS NULL
    )
    OR
    (
      source_kind = 'copy'
      AND source_project_id IS NOT NULL
      AND git_base_ref IS NULL
      AND copy_include_untracked IS NOT NULL
    )
  )
);

CREATE INDEX agent_task_workspaces_source_project_idx
  ON agent_task_workspaces(source_project_id, created_at_ms DESC);

CREATE TABLE agent_sessions (
  session_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  provider_session_id TEXT,
  title TEXT,
  workspace_kind TEXT NOT NULL
    CHECK (workspace_kind IN ('project', 'task')),
  project_id TEXT,
  task_workspace_id TEXT UNIQUE
    REFERENCES agent_task_workspaces(task_workspace_id),
  cwd TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  latest_seq INTEGER NOT NULL DEFAULT 0 CHECK (latest_seq >= 0),
  last_message_preview TEXT,
  creation_request_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (provider_id, provider_session_id),
  CHECK (
    (workspace_kind = 'project' AND project_id IS NOT NULL AND task_workspace_id IS NULL)
    OR
    (workspace_kind = 'task' AND project_id IS NULL AND task_workspace_id IS NOT NULL)
  )
);

CREATE INDEX agent_sessions_catalog_idx
  ON agent_sessions(archived, updated_at_ms DESC, session_id DESC);

CREATE INDEX agent_sessions_project_idx
  ON agent_sessions(workspace_kind, project_id, archived, updated_at_ms DESC, session_id DESC);

CREATE UNIQUE INDEX agent_sessions_creation_request_idx
  ON agent_sessions(creation_request_id);

CREATE TABLE agent_session_catalog_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);

INSERT INTO agent_session_catalog_state(singleton, revision)
VALUES (1, 0);

CREATE TABLE agent_session_catalog_changes (
  revision INTEGER NOT NULL CHECK (revision > 0),
  session_id TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('changed', 'removed')),
  changed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (revision, session_id)
);

CREATE INDEX agent_session_catalog_changes_session_idx
  ON agent_session_catalog_changes(session_id, revision DESC);

CREATE TABLE agent_session_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL,
  state_kind TEXT NOT NULL CHECK (
    state_kind IN (
      'queued',
      'running',
      'awaiting_permission',
      'completed',
      'cancelled',
      'failed'
    )
  ),
  completed_seq INTEGER CHECK (completed_seq > 0),
  stop_reason_kind TEXT CHECK (
    stop_reason_kind IS NULL
    OR stop_reason_kind IN ('end_turn', 'max_tokens', 'refusal', 'cancelled', 'other')
  ),
  stop_reason_other TEXT,
  failure_message TEXT,
  failure_code TEXT,
  failure_retryable INTEGER
    CHECK (failure_retryable IS NULL OR failure_retryable IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (session_id, turn_id),
  UNIQUE (session_id, client_request_id),
  CHECK (
    (
      state_kind IN ('queued', 'running', 'awaiting_permission')
      AND completed_seq IS NULL
      AND stop_reason_kind IS NULL
      AND stop_reason_other IS NULL
      AND failure_message IS NULL
      AND failure_code IS NULL
      AND failure_retryable IS NULL
    )
    OR
    (
      state_kind = 'completed'
      AND completed_seq IS NOT NULL
      AND stop_reason_kind IS NOT NULL
      AND failure_message IS NULL
      AND failure_code IS NULL
      AND failure_retryable IS NULL
    )
    OR
    (
      state_kind = 'cancelled'
      AND completed_seq IS NOT NULL
      AND stop_reason_kind IS NULL
      AND stop_reason_other IS NULL
      AND failure_message IS NULL
      AND failure_code IS NULL
      AND failure_retryable IS NULL
    )
    OR
    (
      state_kind = 'failed'
      AND completed_seq IS NOT NULL
      AND stop_reason_kind IS NULL
      AND stop_reason_other IS NULL
      AND failure_message IS NOT NULL
      AND failure_retryable IS NOT NULL
    )
  ),
  CHECK (
    (stop_reason_kind = 'other' AND stop_reason_other IS NOT NULL)
    OR
    (stop_reason_kind IS NULL AND stop_reason_other IS NULL)
    OR
    (stop_reason_kind != 'other' AND stop_reason_other IS NULL)
  )
);

CREATE UNIQUE INDEX agent_session_turns_active_idx
  ON agent_session_turns(session_id)
  WHERE state_kind IN ('queued', 'running', 'awaiting_permission');

CREATE INDEX agent_session_turns_history_idx
  ON agent_session_turns(session_id, completed_seq DESC, turn_id DESC)
  WHERE completed_seq IS NOT NULL;

CREATE TABLE agent_turn_contexts (
  turn_id TEXT PRIMARY KEY REFERENCES agent_session_turns(turn_id) ON DELETE CASCADE,
  captured_at_ms INTEGER NOT NULL,
  daemon_instance_id TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1))
);

CREATE TABLE agent_turn_context_entities (
  turn_id TEXT NOT NULL REFERENCES agent_turn_contexts(turn_id) ON DELETE CASCADE,
  entity_index INTEGER NOT NULL CHECK (entity_index >= 0),
  role_kind TEXT NOT NULL CHECK (role_kind IN ('primary', 'selected', 'visible', 'related')),
  entity_kind TEXT NOT NULL CHECK (
    entity_kind IN (
      'filesystem_path',
      'terminal_session',
      'process',
      'window',
      'job',
      'schedule',
      'client',
      'other'
    )
  ),
  filesystem_path TEXT,
  terminal_session_id TEXT,
  process_pid INTEGER CHECK (process_pid IS NULL OR process_pid >= 0),
  window_id TEXT,
  job_id TEXT,
  schedule_id TEXT,
  client_id TEXT,
  other_kind TEXT,
  other_id TEXT,
  PRIMARY KEY (turn_id, entity_index),
  CHECK (
    (
      entity_kind = 'filesystem_path'
      AND filesystem_path IS NOT NULL
      AND terminal_session_id IS NULL AND process_pid IS NULL AND window_id IS NULL
      AND job_id IS NULL AND schedule_id IS NULL AND client_id IS NULL
      AND other_kind IS NULL AND other_id IS NULL
    )
    OR
    (
      entity_kind = 'terminal_session'
      AND filesystem_path IS NULL
      AND terminal_session_id IS NOT NULL
      AND process_pid IS NULL AND window_id IS NULL AND job_id IS NULL
      AND schedule_id IS NULL AND client_id IS NULL
      AND other_kind IS NULL AND other_id IS NULL
    )
    OR
    (
      entity_kind = 'process'
      AND filesystem_path IS NULL AND terminal_session_id IS NULL
      AND process_pid IS NOT NULL
      AND window_id IS NULL AND job_id IS NULL AND schedule_id IS NULL
      AND client_id IS NULL AND other_kind IS NULL AND other_id IS NULL
    )
    OR
    (
      entity_kind = 'window'
      AND filesystem_path IS NULL AND terminal_session_id IS NULL AND process_pid IS NULL
      AND window_id IS NOT NULL
      AND job_id IS NULL AND schedule_id IS NULL AND client_id IS NULL
      AND other_kind IS NULL AND other_id IS NULL
    )
    OR
    (
      entity_kind = 'job'
      AND filesystem_path IS NULL AND terminal_session_id IS NULL AND process_pid IS NULL
      AND window_id IS NULL
      AND job_id IS NOT NULL
      AND schedule_id IS NULL AND client_id IS NULL
      AND other_kind IS NULL AND other_id IS NULL
    )
    OR
    (
      entity_kind = 'schedule'
      AND filesystem_path IS NULL AND terminal_session_id IS NULL AND process_pid IS NULL
      AND window_id IS NULL AND job_id IS NULL
      AND schedule_id IS NOT NULL
      AND client_id IS NULL AND other_kind IS NULL AND other_id IS NULL
    )
    OR
    (
      entity_kind = 'client'
      AND filesystem_path IS NULL AND terminal_session_id IS NULL AND process_pid IS NULL
      AND window_id IS NULL AND job_id IS NULL AND schedule_id IS NULL
      AND client_id IS NOT NULL
      AND other_kind IS NULL AND other_id IS NULL
    )
    OR
    (
      entity_kind = 'other'
      AND filesystem_path IS NULL AND terminal_session_id IS NULL AND process_pid IS NULL
      AND window_id IS NULL AND job_id IS NULL AND schedule_id IS NULL AND client_id IS NULL
      AND other_kind IS NOT NULL AND other_id IS NOT NULL
    )
  )
);

CREATE TABLE agent_turn_context_resources (
  turn_id TEXT NOT NULL REFERENCES agent_turn_contexts(turn_id) ON DELETE CASCADE,
  resource_index INTEGER NOT NULL CHECK (resource_index >= 0),
  role_kind TEXT NOT NULL CHECK (role_kind IN ('primary', 'selected', 'visible', 'related')),
  uri TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  snapshot_mime_type TEXT,
  snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
  PRIMARY KEY (turn_id, resource_index),
  CHECK (
    (snapshot_mime_type IS NULL AND snapshot_json IS NULL)
    OR
    (snapshot_mime_type IS NOT NULL AND snapshot_json IS NOT NULL)
  )
);

CREATE TABLE agent_messages (
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  turn_id TEXT,
  role_kind TEXT NOT NULL
    CHECK (role_kind IN ('user', 'assistant', 'thought', 'system', 'other')),
  role_other TEXT,
  state_kind TEXT NOT NULL CHECK (state_kind IN ('streaming', 'complete')),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, message_id),
  FOREIGN KEY (session_id, turn_id)
    REFERENCES agent_session_turns(session_id, turn_id)
    ON DELETE CASCADE,
  CHECK (
    (role_kind = 'other' AND role_other IS NOT NULL)
    OR
    (role_kind != 'other' AND role_other IS NULL)
  )
);

CREATE INDEX agent_messages_turn_idx
  ON agent_messages(session_id, turn_id, created_at_ms, message_id);

CREATE TABLE agent_message_contents (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  content_index INTEGER NOT NULL CHECK (content_index >= 0),
  content_kind TEXT NOT NULL
    CHECK (content_kind IN ('text', 'image', 'resource_link', 'embedded_text')),
  text_value TEXT,
  mime_type TEXT,
  data BLOB,
  uri TEXT,
  name TEXT,
  PRIMARY KEY (session_id, message_id, content_index),
  FOREIGN KEY (session_id, message_id)
    REFERENCES agent_messages(session_id, message_id)
    ON DELETE CASCADE,
  CHECK (
    (
      content_kind = 'text'
      AND text_value IS NOT NULL
      AND mime_type IS NULL AND data IS NULL AND uri IS NULL AND name IS NULL
    )
    OR
    (
      content_kind = 'image'
      AND text_value IS NULL
      AND mime_type IS NOT NULL AND data IS NOT NULL
      AND uri IS NULL AND name IS NULL
    )
    OR
    (
      content_kind = 'resource_link'
      AND text_value IS NULL AND data IS NULL
      AND uri IS NOT NULL
    )
    OR
    (
      content_kind = 'embedded_text'
      AND text_value IS NOT NULL AND data IS NULL
      AND uri IS NOT NULL AND name IS NULL
    )
  )
);

CREATE TABLE agent_tool_calls (
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other')),
  kind_other TEXT,
  status_kind TEXT NOT NULL CHECK (status_kind IN ('pending', 'running', 'completed', 'failed')),
  failure_message TEXT,
  PRIMARY KEY (session_id, tool_call_id),
  FOREIGN KEY (session_id, turn_id)
    REFERENCES agent_session_turns(session_id, turn_id)
    ON DELETE CASCADE,
  CHECK (
    (kind = 'other' AND kind_other IS NOT NULL)
    OR
    (kind != 'other' AND kind_other IS NULL)
  ),
  CHECK (status_kind = 'failed' OR failure_message IS NULL)
);

CREATE INDEX agent_tool_calls_turn_idx
  ON agent_tool_calls(session_id, turn_id, tool_call_id);

CREATE TABLE agent_tool_call_locations (
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  location_index INTEGER NOT NULL CHECK (location_index >= 0),
  path TEXT NOT NULL,
  line INTEGER CHECK (line IS NULL OR line > 0),
  PRIMARY KEY (session_id, tool_call_id, location_index),
  FOREIGN KEY (session_id, tool_call_id)
    REFERENCES agent_tool_calls(session_id, tool_call_id)
    ON DELETE CASCADE
);

CREATE TABLE agent_tool_call_contents (
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  content_index INTEGER NOT NULL CHECK (content_index >= 0),
  content_type TEXT NOT NULL CHECK (content_type IN ('content', 'diff', 'terminal_ref')),
  agent_content_kind TEXT CHECK (
    agent_content_kind IS NULL
    OR agent_content_kind IN ('text', 'image', 'resource_link', 'embedded_text')
  ),
  text_value TEXT,
  mime_type TEXT,
  data BLOB,
  uri TEXT,
  name TEXT,
  diff_path TEXT,
  diff_old_path TEXT,
  diff_kind TEXT CHECK (
    diff_kind IS NULL OR diff_kind IN ('add', 'modify', 'delete', 'move')
  ),
  diff_patch TEXT,
  terminal_id TEXT,
  PRIMARY KEY (session_id, tool_call_id, content_index),
  FOREIGN KEY (session_id, tool_call_id)
    REFERENCES agent_tool_calls(session_id, tool_call_id)
    ON DELETE CASCADE,
  CHECK (
    (
      content_type = 'content'
      AND agent_content_kind IS NOT NULL
      AND diff_path IS NULL AND diff_old_path IS NULL
      AND diff_kind IS NULL AND diff_patch IS NULL AND terminal_id IS NULL
    )
    OR
    (
      content_type = 'diff'
      AND agent_content_kind IS NULL
      AND text_value IS NULL AND mime_type IS NULL AND data IS NULL AND uri IS NULL AND name IS NULL
      AND diff_path IS NOT NULL AND diff_kind IS NOT NULL
      AND terminal_id IS NULL
    )
    OR
    (
      content_type = 'terminal_ref'
      AND agent_content_kind IS NULL
      AND text_value IS NULL AND mime_type IS NULL AND data IS NULL AND uri IS NULL AND name IS NULL
      AND diff_path IS NULL AND diff_old_path IS NULL
      AND diff_kind IS NULL AND diff_patch IS NULL
      AND terminal_id IS NOT NULL
    )
  ),
  CHECK (
    content_type != 'content'
    OR
    (
      agent_content_kind = 'text'
      AND text_value IS NOT NULL
      AND mime_type IS NULL AND data IS NULL AND uri IS NULL AND name IS NULL
    )
    OR
    (
      agent_content_kind = 'image'
      AND text_value IS NULL
      AND mime_type IS NOT NULL AND data IS NOT NULL
      AND uri IS NULL AND name IS NULL
    )
    OR
    (
      agent_content_kind = 'resource_link'
      AND text_value IS NULL AND data IS NULL
      AND uri IS NOT NULL
    )
    OR
    (
      agent_content_kind = 'embedded_text'
      AND text_value IS NOT NULL AND data IS NULL
      AND uri IS NOT NULL AND name IS NULL
    )
  )
);

CREATE TABLE agent_permission_requests (
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  permission_request_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('tool_call', 'action')),
  subject_tool_call_id TEXT,
  action_title TEXT,
  action_detail TEXT,
  state_kind TEXT NOT NULL CHECK (state_kind IN ('pending', 'selected', 'cancelled', 'expired')),
  selected_option_id TEXT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, permission_request_id),
  FOREIGN KEY (session_id, turn_id)
    REFERENCES agent_session_turns(session_id, turn_id)
    ON DELETE CASCADE,
  CHECK (
    (
      subject_kind = 'tool_call'
      AND subject_tool_call_id IS NOT NULL
      AND action_title IS NULL AND action_detail IS NULL
    )
    OR
    (
      subject_kind = 'action'
      AND subject_tool_call_id IS NULL
      AND action_title IS NOT NULL
    )
  ),
  CHECK (
    (state_kind = 'selected' AND selected_option_id IS NOT NULL)
    OR
    (state_kind != 'selected' AND selected_option_id IS NULL)
  )
);

CREATE INDEX agent_permission_requests_turn_idx
  ON agent_permission_requests(session_id, turn_id, created_at_ms, permission_request_id);

CREATE TABLE agent_permission_options (
  session_id TEXT NOT NULL,
  permission_request_id TEXT NOT NULL,
  option_index INTEGER NOT NULL CHECK (option_index >= 0),
  option_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('allow_once', 'allow_always', 'reject_once', 'reject_always', 'other')),
  kind_other TEXT,
  PRIMARY KEY (session_id, permission_request_id, option_id),
  UNIQUE (session_id, permission_request_id, option_index),
  FOREIGN KEY (session_id, permission_request_id)
    REFERENCES agent_permission_requests(session_id, permission_request_id)
    ON DELETE CASCADE,
  CHECK (
    (kind = 'other' AND kind_other IS NOT NULL)
    OR
    (kind != 'other' AND kind_other IS NULL)
  )
);

CREATE TABLE agent_turn_plans (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_id),
  FOREIGN KEY (session_id, turn_id)
    REFERENCES agent_session_turns(session_id, turn_id)
    ON DELETE CASCADE
);

CREATE TABLE agent_plan_entries (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  entry_index INTEGER NOT NULL CHECK (entry_index >= 0),
  content TEXT NOT NULL,
  priority_kind TEXT NOT NULL CHECK (priority_kind IN ('low', 'medium', 'high')),
  status_kind TEXT NOT NULL CHECK (status_kind IN ('pending', 'in_progress', 'completed')),
  PRIMARY KEY (session_id, turn_id, entry_id),
  UNIQUE (session_id, turn_id, entry_index),
  FOREIGN KEY (session_id, turn_id)
    REFERENCES agent_turn_plans(session_id, turn_id)
    ON DELETE CASCADE
);

CREATE TABLE agent_session_config_values (
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  config_id TEXT NOT NULL,
  value_kind TEXT NOT NULL CHECK (value_kind IN ('string', 'boolean')),
  string_value TEXT,
  boolean_value INTEGER CHECK (boolean_value IS NULL OR boolean_value IN (0, 1)),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, config_id),
  CHECK (
    (value_kind = 'string' AND string_value IS NOT NULL AND boolean_value IS NULL)
    OR
    (value_kind = 'boolean' AND string_value IS NULL AND boolean_value IS NOT NULL)
  )
);

CREATE TABLE agent_terminals (
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  terminal_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT,
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  oldest_output_seq INTEGER NOT NULL CHECK (oldest_output_seq >= 0),
  latest_output_seq INTEGER NOT NULL CHECK (latest_output_seq >= 0),
  retained_bytes INTEGER NOT NULL CHECK (retained_bytes >= 0),
  max_bytes INTEGER CHECK (max_bytes IS NULL OR max_bytes >= 0),
  exited INTEGER NOT NULL CHECK (exited IN (0, 1)),
  exit_code INTEGER,
  exit_signal TEXT,
  PRIMARY KEY (session_id, terminal_id),
  FOREIGN KEY (session_id, turn_id)
    REFERENCES agent_session_turns(session_id, turn_id)
    ON DELETE CASCADE,
  CHECK (exited = 1 OR (exit_code IS NULL AND exit_signal IS NULL))
);

CREATE INDEX agent_terminals_turn_idx
  ON agent_terminals(session_id, turn_id, terminal_id);

CREATE TABLE agent_terminal_args (
  session_id TEXT NOT NULL,
  terminal_id TEXT NOT NULL,
  arg_index INTEGER NOT NULL CHECK (arg_index >= 0),
  value TEXT NOT NULL,
  PRIMARY KEY (session_id, terminal_id, arg_index),
  FOREIGN KEY (session_id, terminal_id)
    REFERENCES agent_terminals(session_id, terminal_id)
    ON DELETE CASCADE
);

CREATE TABLE agent_terminal_output_chunks (
  session_id TEXT NOT NULL,
  terminal_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  text TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, terminal_id, seq),
  FOREIGN KEY (session_id, terminal_id)
    REFERENCES agent_terminals(session_id, terminal_id)
    ON DELETE CASCADE
);
