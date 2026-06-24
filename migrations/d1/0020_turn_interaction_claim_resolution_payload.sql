ALTER TABLE turn_interaction_resolution_claims
  ADD COLUMN resolution_summary TEXT;

ALTER TABLE turn_interaction_resolution_claims
  ADD COLUMN resolution_payload_json TEXT;
