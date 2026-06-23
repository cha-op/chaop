CREATE TABLE budget_telemetry_samples (
  id TEXT PRIMARY KEY,
  sample_type TEXT NOT NULL,
  sampled_at TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  d1_rows_written_daily INTEGER,
  d1_rows_read_daily INTEGER,
  worker_requests_daily INTEGER,
  durable_object_requests_daily INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_budget_telemetry_samples_type_sampled_at
  ON budget_telemetry_samples(sample_type, sampled_at);
