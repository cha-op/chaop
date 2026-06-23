CREATE TABLE IF NOT EXISTS control_plane_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_control_plane_settings_updated
  ON control_plane_settings(updated_at);
