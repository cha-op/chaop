PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS _migration_0005_command_task_links;
CREATE TABLE _migration_0005_command_task_links (
  command_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL
);

INSERT INTO _migration_0005_command_task_links (command_id, task_id)
SELECT id, task_id
FROM commands
WHERE task_id IS NOT NULL;

DROP TABLE IF EXISTS _migration_0005_host_session_task_links;
CREATE TABLE _migration_0005_host_session_task_links (
  host_session_id TEXT PRIMARY KEY,
  attached_task_id TEXT NOT NULL
);

INSERT INTO _migration_0005_host_session_task_links (host_session_id, attached_task_id)
SELECT id, attached_task_id
FROM host_sessions
WHERE attached_task_id IS NOT NULL;

CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'idle', 'waiting_for_approval', 'waiting_for_input', 'throttled', 'failed', 'done')),
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
  FROM _migration_0005_command_task_links
  WHERE command_id = commands.id
)
WHERE id IN (
  SELECT command_id
  FROM _migration_0005_command_task_links
);

UPDATE host_sessions
SET attached_task_id = (
  SELECT attached_task_id
  FROM _migration_0005_host_session_task_links
  WHERE host_session_id = host_sessions.id
)
WHERE id IN (
  SELECT host_session_id
  FROM _migration_0005_host_session_task_links
);

DROP TABLE _migration_0005_command_task_links;
DROP TABLE _migration_0005_host_session_task_links;

CREATE INDEX idx_tasks_state ON tasks(state, updated_at);
CREATE INDEX idx_tasks_category ON tasks(category_id, updated_at);
CREATE INDEX idx_tasks_archived ON tasks(archived_at, updated_at);
CREATE INDEX idx_tasks_thread ON tasks(thread_id);
