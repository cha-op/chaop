CREATE TABLE IF NOT EXISTS turn_interaction_resolution_claims_v2 (
  interaction_id TEXT NOT NULL,
  request_event_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  response_kind TEXT NOT NULL CHECK (response_kind IN ('approval', 'input')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (command_id, interaction_id),
  FOREIGN KEY (request_event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (command_id) REFERENCES commands(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO turn_interaction_resolution_claims_v2 (
  interaction_id, request_event_id, command_id, response_kind, created_at
)
SELECT interaction_id, request_event_id, command_id, response_kind, created_at
FROM turn_interaction_resolution_claims;

DROP TABLE turn_interaction_resolution_claims;

ALTER TABLE turn_interaction_resolution_claims_v2
  RENAME TO turn_interaction_resolution_claims;

CREATE INDEX IF NOT EXISTS idx_turn_interaction_resolution_claims_command
  ON turn_interaction_resolution_claims(command_id, created_at);
