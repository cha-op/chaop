CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'operator',
  created_at TEXT NOT NULL
);

CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'degraded')),
  realtime_mode TEXT NOT NULL CHECK (realtime_mode IN ('realtime', 'summary', 'cost_saving', 'throttled', 'waiting_for_upload')),
  budget_state TEXT NOT NULL CHECK (budget_state IN ('normal', 'conservative', 'throttled', 'hard_limited', 'recovery')),
  logical_agent_count INTEGER NOT NULL DEFAULT 0,
  active_command_count INTEGER NOT NULL DEFAULT 0,
  capabilities_json TEXT,
  workspace_root TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_url TEXT,
  default_branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspace_connectors (
  workspace_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  local_path TEXT NOT NULL,
  can_execute INTEGER NOT NULL DEFAULT 1,
  last_indexed_at TEXT,
  PRIMARY KEY (workspace_id, connector_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE CASCADE
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'idle', 'archived')),
  realtime_mode TEXT NOT NULL CHECK (realtime_mode IN ('realtime', 'summary', 'cost_saving', 'throttled', 'waiting_for_upload')),
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE task_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  colour TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT,
  title TEXT NOT NULL,
  category_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'idle', 'waiting_for_approval', 'waiting_for_input', 'throttled', 'done')),
  connector_id TEXT,
  assigned_agent TEXT,
  realtime_mode TEXT NOT NULL CHECK (realtime_mode IN ('realtime', 'summary', 'cost_saving', 'throttled', 'waiting_for_upload')),
  budget_state TEXT NOT NULL CHECK (budget_state IN ('normal', 'conservative', 'throttled', 'hard_limited', 'recovery')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE SET NULL,
  FOREIGN KEY (category_id) REFERENCES task_categories(id),
  FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE SET NULL
);

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('placeholder', 'codex')),
  prompt TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled')),
  target_connector_id TEXT,
  lease_owner_connector_id TEXT,
  lease_until TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (target_connector_id) REFERENCES connectors(id) ON DELETE SET NULL,
  FOREIGN KEY (lease_owner_connector_id) REFERENCES connectors(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  command_id TEXT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('command.accepted', 'command.started', 'command.output', 'command.finished', 'command.failed', 'approval.requested', 'notice.throttled')),
  priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  summary TEXT NOT NULL,
  payload_r2_key TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(thread_id, seq),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  FOREIGN KEY (command_id) REFERENCES commands(id) ON DELETE SET NULL
);

CREATE TABLE usage_windows (
  id TEXT PRIMARY KEY,
  window_type TEXT NOT NULL CHECK (window_type IN ('daily', 'four_hour', 'burst')),
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  budget_state TEXT NOT NULL CHECK (budget_state IN ('normal', 'conservative', 'throttled', 'hard_limited', 'recovery')),
  used_pct REAL NOT NULL,
  events_received INTEGER NOT NULL DEFAULT 0,
  events_compacted INTEGER NOT NULL DEFAULT 0,
  events_delayed INTEGER NOT NULL DEFAULT 0,
  local_spool_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_connectors_status ON connectors(status);
CREATE INDEX idx_workspaces_updated ON workspaces(updated_at);
CREATE INDEX idx_threads_workspace_updated ON threads(workspace_id, updated_at);
CREATE INDEX idx_tasks_state ON tasks(state, updated_at);
CREATE INDEX idx_tasks_category ON tasks(category_id, updated_at);
CREATE INDEX idx_commands_state ON commands(state, updated_at);
CREATE INDEX idx_events_thread_seq ON events(thread_id, seq);
CREATE INDEX idx_usage_windows_type ON usage_windows(window_type, window_start);
