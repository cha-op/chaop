CREATE TABLE IF NOT EXISTS turn_interaction_resolution_claims (
  interaction_id TEXT PRIMARY KEY,
  request_event_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  response_kind TEXT NOT NULL CHECK (response_kind IN ('approval', 'input')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (request_event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (command_id) REFERENCES commands(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_turn_interaction_resolution_claims_command
  ON turn_interaction_resolution_claims(command_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_turn_interaction_resolution
  ON events(command_id, json_extract(payload_json, '$.interaction_id'))
  WHERE kind IN ('approval.resolved', 'input.received')
    AND command_id IS NOT NULL
    AND payload_json IS NOT NULL;
