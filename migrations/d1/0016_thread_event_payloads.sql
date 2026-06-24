PRAGMA foreign_keys = OFF;

CREATE TABLE events_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  command_id TEXT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'command.accepted',
    'command.started',
    'command.output',
    'command.finished',
    'command.failed',
    'approval.requested',
    'approval.resolved',
    'input.requested',
    'input.received',
    'notice.throttled'
  )),
  priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  summary TEXT NOT NULL,
  payload_json TEXT,
  payload_r2_key TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(thread_id, seq),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  FOREIGN KEY (command_id) REFERENCES commands(id) ON DELETE SET NULL
);

INSERT INTO events_new (
  id,
  workspace_id,
  thread_id,
  command_id,
  seq,
  kind,
  priority,
  summary,
  payload_r2_key,
  idempotency_key,
  created_at
)
SELECT
  id,
  workspace_id,
  thread_id,
  command_id,
  seq,
  kind,
  priority,
  summary,
  payload_r2_key,
  idempotency_key,
  created_at
FROM events;

DROP INDEX IF EXISTS idx_events_thread_seq;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE INDEX idx_events_thread_seq ON events(thread_id, seq);

PRAGMA foreign_keys = ON;
