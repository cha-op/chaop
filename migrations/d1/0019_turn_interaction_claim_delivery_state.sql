ALTER TABLE turn_interaction_resolution_claims
  ADD COLUMN response_json TEXT;

ALTER TABLE turn_interaction_resolution_claims
  ADD COLUMN delivered_at TEXT;
