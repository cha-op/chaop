ALTER TABLE tasks ADD COLUMN archived_at TEXT;

PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS _migration_0003_command_task_links;
CREATE TABLE _migration_0003_command_task_links (
  command_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL
);

INSERT INTO _migration_0003_command_task_links (command_id, task_id)
SELECT id, task_id
FROM commands
WHERE task_id IS NOT NULL;

INSERT OR IGNORE INTO threads (id, workspace_id, title, state, realtime_mode, last_seq, created_at, updated_at)
SELECT
  'thread-' || id,
  workspace_id,
  title,
  CASE WHEN state = 'running' THEN 'active' ELSE 'idle' END,
  realtime_mode,
  0,
  created_at,
  updated_at
FROM tasks
WHERE thread_id IS NULL;

UPDATE tasks
SET thread_id = 'thread-' || id
WHERE thread_id IS NULL;

CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'idle', 'waiting_for_approval', 'waiting_for_input', 'throttled', 'done')),
  connector_id TEXT,
  assigned_agent TEXT,
  realtime_mode TEXT NOT NULL CHECK (realtime_mode IN ('realtime', 'summary', 'cost_saving', 'throttled', 'waiting_for_upload')),
  budget_state TEXT NOT NULL CHECK (budget_state IN ('normal', 'conservative', 'throttled', 'hard_limited', 'recovery')),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES task_categories(id),
  FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE SET NULL
);

INSERT INTO tasks_new (
  id, workspace_id, thread_id, title, category_id, state, connector_id, assigned_agent,
  realtime_mode, budget_state, archived_at, created_at, updated_at
)
SELECT
  id, workspace_id, thread_id, title, category_id, state, connector_id, assigned_agent,
  realtime_mode, budget_state, archived_at, created_at, updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

UPDATE commands
SET task_id = (
  SELECT task_id
  FROM _migration_0003_command_task_links
  WHERE command_id = commands.id
)
WHERE id IN (
  SELECT command_id
  FROM _migration_0003_command_task_links
);

DROP TABLE _migration_0003_command_task_links;

CREATE INDEX idx_tasks_state ON tasks(state, updated_at);
CREATE INDEX idx_tasks_category ON tasks(category_id, updated_at);
CREATE INDEX idx_tasks_archived ON tasks(archived_at, updated_at);
CREATE INDEX idx_tasks_thread ON tasks(thread_id);

CREATE TABLE host_sessions (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL CHECK (title_source IN ('metadata', 'app_server', 'history', 'fallback')),
  cwd TEXT,
  attached_task_id TEXT,
  attached_thread_id TEXT,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connector_id, session_id),
  FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (attached_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (attached_thread_id) REFERENCES threads(id) ON DELETE SET NULL
);

CREATE INDEX idx_host_sessions_connector_updated ON host_sessions(connector_id, updated_at);
CREATE INDEX idx_host_sessions_attached ON host_sessions(attached_task_id, attached_thread_id);
