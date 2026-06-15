CREATE TABLE app_server_instances_next (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  instance_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('connector', 'workspace', 'thread')),
  workspace_id TEXT,
  thread_id TEXT,
  placement_key TEXT NOT NULL,
  endpoint_type TEXT NOT NULL CHECK (endpoint_type IN ('managed', 'external')),
  state TEXT NOT NULL CHECK (state IN ('healthy', 'degraded', 'draining', 'restarting', 'stopped')),
  active_turn_count INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  status_summary TEXT,
  last_error TEXT,
  report_fingerprint TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  state_changed_at TEXT NOT NULL,
  summary_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connector_id, instance_key, placement_key),
  FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE CASCADE
);

INSERT INTO app_server_instances_next (
  id, connector_id, instance_key, scope, workspace_id, thread_id, placement_key,
  endpoint_type, state, active_turn_count, generation, status_summary, last_error,
  report_fingerprint, last_seen_at, state_changed_at, summary_changed_at,
  created_at, updated_at
)
SELECT
  id, connector_id, instance_key, scope, NULL, NULL, 'connector',
  endpoint_type, state, active_turn_count, generation, status_summary, last_error,
  report_fingerprint, last_seen_at, state_changed_at, summary_changed_at,
  created_at, updated_at
FROM app_server_instances;

DROP TABLE app_server_instances;

ALTER TABLE app_server_instances_next RENAME TO app_server_instances;

CREATE INDEX idx_app_server_instances_connector_state
  ON app_server_instances(connector_id, state);

CREATE INDEX idx_app_server_instances_state_updated
  ON app_server_instances(state, updated_at);

CREATE INDEX idx_app_server_instances_last_seen
  ON app_server_instances(last_seen_at);

CREATE INDEX idx_app_server_instances_workspace_state
  ON app_server_instances(workspace_id, state);

CREATE INDEX idx_app_server_instances_thread_state
  ON app_server_instances(thread_id, state);
