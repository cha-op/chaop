import assert from "node:assert/strict";
import test from "node:test";
import { agentSocketsForConnector, hasPeerAgentSocket, hostSessionsMessage, threadEventMessage, WorkspaceDO } from "./workspace-do.js";
import type { Env } from "./types.js";

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

test("hasPeerAgentSocket ignores the socket that is closing", () => {
  const closingSocket = {} as WebSocket;
  const peerSocket = {} as WebSocket;
  const ctx = {
    getWebSockets(tag?: string) {
      assert.equal(tag, "agent:connector-1");
      return [closingSocket, peerSocket];
    }
  };

  assert.equal(hasPeerAgentSocket(ctx, "connector-1", closingSocket), true);
  assert.equal(hasPeerAgentSocket(ctx, "connector-1", peerSocket), true);
});

test("hasPeerAgentSocket returns false when the closing socket is the only agent socket", () => {
  const closingSocket = {} as WebSocket;
  const ctx = {
    getWebSockets(tag?: string) {
      assert.equal(tag, "agent:connector-1");
      return [closingSocket];
    }
  };

  assert.equal(hasPeerAgentSocket(ctx, "connector-1", closingSocket), false);
});

test("agentSocketsForConnector prefers the newest agent socket", () => {
  const oldSocket = socketWithAttachment({ connectedAt: 100 });
  const freshSocket = socketWithAttachment({ connectedAt: 300 });
  const legacySocket = socketWithAttachment({});
  const ctx = {
    getWebSockets(tag?: string) {
      assert.equal(tag, "agent:connector-1");
      return [oldSocket, legacySocket, freshSocket];
    }
  };

  assert.deepEqual(agentSocketsForConnector(ctx, "connector-1"), [freshSocket, oldSocket, legacySocket]);
});

test("sync thread archive dispatches to the selected agent socket and resolves the result", async () => {
  const sent: string[] = [];
  const agentSocket = {
    send(message: string) {
      sent.push(message);
    },
    deserializeAttachment() {
      return { socketType: "agent", connectorId: "connector-online", connectedAt: 300 };
    }
  } as unknown as WebSocket;
  const ctx = {
    getWebSockets(tag?: string) {
      assert.equal(tag, "agent:connector-online");
      return [agentSocket];
    }
  } as unknown as DurableObjectState;
  const workspace = new WorkspaceDO(ctx, {} as Env);

  const responsePromise = workspace.fetch(new Request("https://workspace-do/internal/sync-thread-archive", {
    method: "POST",
    body: JSON.stringify({
      connector_id: "connector-online",
      request_id: "archive-1",
      session_id: "session-1",
      archived: true
    })
  }));

  await waitFor(() => sent.length === 1);
  assert.equal(sent.length, 1);
  const dispatch = JSON.parse(sent[0] ?? "{}") as {
    kind?: string;
    payload?: { request_id?: string; session_id?: string; archived?: boolean };
    target?: { type?: string; id?: string };
  };
  assert.equal(dispatch.kind, "thread.archive_sync");
  assert.equal(dispatch.payload?.request_id, "archive-1");
  assert.equal(dispatch.payload?.session_id, "session-1");
  assert.equal(dispatch.payload?.archived, true);
  assert.deepEqual(dispatch.target, { type: "connector", id: "connector-online" });

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "thread.archive_sync_result",
    payload: { request_id: "archive-1", ok: true, synced: true }
  }));

  const response = await responsePromise;
  const body = await response.json() as { ok?: boolean; synced?: boolean };
  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true, synced: true });

  assert.equal(sent.length, 2);
  const ack = JSON.parse(sent[1] ?? "{}") as {
    kind?: string;
    payload?: { kind?: string; request_id?: string };
  };
  assert.equal(ack.kind, "server.ack");
  assert.deepEqual(ack.payload, { kind: "thread.archive_sync_result", request_id: "archive-1" });
});

function socketWithAttachment(attachment: unknown): WebSocket {
  return {
    deserializeAttachment() {
      return attachment;
    }
  } as unknown as WebSocket;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
