import assert from "node:assert/strict";
import test from "node:test";
import { threadEventMessage } from "./workspace-do.js";

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
