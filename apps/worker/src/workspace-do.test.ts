import assert from "node:assert/strict";
import test from "node:test";
import { hostSessionsMessage, threadEventMessage } from "./workspace-do.js";

test("threadEventMessage wraps agent events for browser realtime consumers", () => {
  const message = threadEventMessage({
    id: "event-1",
    thread_id: "thread-1",
    command_id: "command-1",
    seq: 7,
    kind: "command.output",
    priority: "P2",
    summary: "Codex: done",
    created_at: "2026-06-11T10:00:00.000Z"
  });
  const envelope = JSON.parse(message) as {
    kind: string;
    thread_id?: string;
    command_id?: string;
    payload?: { event?: { id?: string; seq?: number; summary?: string } };
  };

  assert.equal(envelope.kind, "thread.event");
  assert.equal(envelope.thread_id, "thread-1");
  assert.equal(envelope.command_id, "command-1");
  assert.equal(envelope.payload?.event?.id, "event-1");
  assert.equal(envelope.payload?.event?.seq, 7);
  assert.equal(envelope.payload?.event?.summary, "Codex: done");
});

test("hostSessionsMessage wraps connector inventory updates for browser consumers", () => {
  const message = hostSessionsMessage({
    connector_id: "connector-1",
    synced_at: "2026-06-11T10:00:05.000Z",
    snapshot: true,
    host_sessions: [
      {
        id: "host-session-1",
        connector_id: "connector-1",
        hostname: "mac-studio.local",
        workspace_id: "workspace-api",
        session_id: "session-1",
        title: "Metadata title",
        title_source: "metadata",
        cwd: "/Users/you/Program/project",
        updated_at: "2026-06-11T10:00:00.000Z"
      }
    ]
  });
  const envelope = JSON.parse(message) as {
    kind: string;
    payload?: {
      host_sessions?: Array<{ session_id?: string; title_source?: string }>;
      connector_id?: string;
      synced_at?: string;
      snapshot?: boolean;
    };
  };

  assert.equal(envelope.kind, "host_sessions.updated");
  assert.equal(envelope.payload?.connector_id, "connector-1");
  assert.equal(envelope.payload?.synced_at, "2026-06-11T10:00:05.000Z");
  assert.equal(envelope.payload?.snapshot, true);
  assert.equal(envelope.payload?.host_sessions?.[0]?.session_id, "session-1");
  assert.equal(envelope.payload?.host_sessions?.[0]?.title_source, "metadata");
});
