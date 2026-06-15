ALTER TABLE app_server_instances ADD COLUMN workspace_id TEXT;

ALTER TABLE app_server_instances ADD COLUMN thread_id TEXT;

CREATE INDEX idx_app_server_instances_workspace_state
  ON app_server_instances(workspace_id, state);

CREATE INDEX idx_app_server_instances_thread_state
  ON app_server_instances(thread_id, state);
