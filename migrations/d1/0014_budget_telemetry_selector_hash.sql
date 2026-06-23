ALTER TABLE budget_telemetry_samples
  ADD COLUMN selector_hash TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX idx_budget_telemetry_samples_type_selector_sampled_at
  ON budget_telemetry_samples(sample_type, selector_hash, sampled_at);
