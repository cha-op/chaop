CREATE TABLE host_session_syncs (
  connector_id TEXT PRIMARY KEY,
  synced_at TEXT NOT NULL,
  reported_session_count INTEGER NOT NULL DEFAULT 0,
  stored_session_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE CASCADE
);

CREATE INDEX idx_host_session_syncs_synced_at ON host_session_syncs(synced_at);
