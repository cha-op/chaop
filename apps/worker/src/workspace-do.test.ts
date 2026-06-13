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

test("agent event ack rejects stale command events", async () => {
  const sent: string[] = [];
  const agentSocket = {
    send(message: string) {
      sent.push(message);
    },
    deserializeAttachment() {
      return { socketType: "agent", connectorId: "connector-online", connectedAt: 300 };
    }
  } as unknown as WebSocket;
  const workspace = new WorkspaceDO({} as DurableObjectState, { DB: staleCommandEventDb() } as Env);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.event",
    payload: {
      command_id: "command-1",
      kind: "command.started",
      priority: "P1",
      summary: "Starting"
    }
  }));

  assert.equal(sent.length, 1);
  const ack = JSON.parse(sent[0] ?? "{}") as {
    kind?: string;
    payload?: { command_id?: string; kind?: string; accepted?: boolean };
  };
  assert.equal(ack.kind, "server.ack");
  assert.deepEqual(ack.payload, {
    command_id: "command-1",
    kind: "command.started",
    accepted: false
  });
});

test("rejected targeted app-server starts trigger pending dispatch to available agents", async () => {
  const staleSent: string[] = [];
  const replacementSent: string[] = [];
  const staleSocket = {
    send(message: string) {
      staleSent.push(message);
    },
    deserializeAttachment() {
      return { socketType: "agent", connectorId: "connector-stale", connectedAt: 100 };
    }
  } as unknown as WebSocket;
  const replacementSocket = {
    send(message: string) {
      replacementSent.push(message);
    },
    deserializeAttachment() {
      return { socketType: "agent", connectorId: "connector-replacement", connectedAt: 200 };
    }
  } as unknown as WebSocket;
  const ctx = {
    getWebSockets(tag?: string) {
      assert.equal(tag, "agent");
      return [staleSocket, replacementSocket];
    }
  } as unknown as DurableObjectState;
  const db = rejectedTargetedStartDispatchDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  await workspace.webSocketMessage(staleSocket, JSON.stringify({
    kind: "agent.event",
    payload: {
      command_id: "command-1",
      target_host_session_id: "session-old",
      kind: "command.started",
      priority: "P1",
      summary: "Starting stale target"
    }
  }));

  assert.equal(staleSent.length, 1);
  const ack = JSON.parse(staleSent[0] ?? "{}") as {
    kind?: string;
    payload?: { command_id?: string; kind?: string; accepted?: boolean };
  };
  assert.equal(ack.kind, "server.ack");
  assert.deepEqual(ack.payload, {
    command_id: "command-1",
    kind: "command.started",
    accepted: false
  });
  assert.equal(replacementSent.length, 1);
  const dispatch = JSON.parse(replacementSent[0] ?? "{}") as {
    kind?: string;
    payload?: { command?: { id?: string }; target_host_session?: { session_id?: string } };
    target?: { type?: string; id?: string };
  };
  assert.equal(dispatch.kind, "command.dispatch");
  assert.equal(dispatch.payload?.command?.id, "command-1");
  assert.equal(dispatch.payload?.target_host_session?.session_id, "session-new");
  assert.deepEqual(dispatch.target, { type: "connector", id: "connector-replacement" });
  assert.equal(db.leaseReleases, 1);
  assert.equal(db.commandLeases, 1);
});

function staleCommandEventDb(): D1Database {
  return {
    prepare(sql: string) {
      if (/SELECT id, workspace_id, thread_id, task_id, type, target_connector_id, target_connector_id_source,\s+lease_owner_connector_id, state/.test(sql)) {
        return {
          bind(commandId: string) {
            assert.equal(commandId, "command-1");
            return {
              async first() {
                return {
                  id: "command-1",
                  workspace_id: "workspace-api",
                  thread_id: "thread-1",
                  task_id: "task-1",
                  type: "codex",
                  target_connector_id: "connector-online",
                  target_connector_id_source: "auto",
                  lease_owner_connector_id: null,
                  state: "failed"
                };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    }
  } as D1Database;
}

function rejectedTargetedStartDispatchDb(): D1Database & {
  readonly leaseReleases: number;
  readonly commandLeases: number;
} {
  const counters = {
    leaseReleases: 0,
    commandLeases: 0
  };
  return {
    prepare(sql: string) {
      if (/SELECT id, workspace_id, thread_id, task_id, type, target_connector_id, target_connector_id_source,\s+lease_owner_connector_id, state/.test(sql)) {
        return {
          bind(commandId: string) {
            assert.equal(commandId, "command-1");
            return {
              async first() {
                return {
                  id: "command-1",
                  workspace_id: "workspace-api",
                  thread_id: "thread-1",
                  task_id: "task-1",
                  type: "codex",
                  target_connector_id: null,
                  target_connector_id_source: "attached",
                  lease_owner_connector_id: "connector-stale",
                  state: "leased",
                  lease_target_host_session_id: "session-old"
                };
              }
            };
          }
        };
      }

      if (
        /UPDATE commands/.test(sql) &&
        /EXISTS \(\s+SELECT 1\s+FROM host_sessions hs/.test(sql) &&
        !/SET state = 'pending'/.test(sql)
      ) {
        return {
          bind() {
            return {
              async run() {
                return { meta: { changes: 0 } };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /SET state = 'pending'/.test(sql)) {
        assert.match(sql, /target_connector_id = CASE WHEN \? THEN NULL ELSE target_connector_id END/);
        assert.match(sql, /target_connector_id_source = CASE WHEN \? THEN 'auto' ELSE target_connector_id_source END/);
        assert.match(sql, /lease_target_host_session_id = \?/);
        assert.match(sql, /EXISTS \(\s+SELECT 1\s+FROM host_sessions hs/);
        assert.match(sql, /hs\.session_id <> \?/);
        return {
          bind(
            clearTargetConnectorId: number,
            clearTargetConnectorIdSource: number,
            updatedAt: string,
            commandId: string,
            connectorId: string,
            targetHostSessionId: string,
            replacementExcludedSessionId: string
          ) {
            assert.equal(clearTargetConnectorId, 1);
            assert.equal(clearTargetConnectorIdSource, 1);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(connectorId, "connector-stale");
            assert.equal(targetHostSessionId, "session-old");
            assert.equal(replacementExcludedSessionId, "session-old");
            return {
              async run() {
                counters.leaseReleases += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/FROM commands cmd/.test(sql) && /LEFT JOIN host_sessions hs/.test(sql)) {
        return {
          bind(
            now: string,
            targetConnectorId: string,
            hostSessionConnectorId: string,
            executableConnectorId: string
          ) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(targetConnectorId, hostSessionConnectorId);
            assert.equal(hostSessionConnectorId, executableConnectorId);
            return {
              async all() {
                if (targetConnectorId !== "connector-replacement") {
                  return { results: [] };
                }
                return {
                  results: [
                    {
                      id: "command-1",
                      workspace_id: "workspace-api",
                      thread_id: "thread-1",
                      task_id: "task-1",
                      type: "codex",
                      prompt: "Continue on the replacement session",
                      state: "pending",
                      target_connector_id: null,
                      created_at: "2026-06-13T10:00:00.000Z",
                      updated_at: "2026-06-13T10:00:00.000Z",
                      target_host_session_id: "session-new",
                      target_host_session_app_server_present: 1,
                      target_host_session_cwd: "/workspace/project"
                    }
                  ]
                };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /SET state = 'leased'/.test(sql)) {
        return {
          bind(
            connectorId: string,
            leaseUntil: string,
            leaseTargetHostSessionId: string,
            updatedAt: string,
            commandId: string,
            now: string
          ) {
            assert.equal(connectorId, "connector-replacement");
            assert.match(leaseUntil, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(leaseTargetHostSessionId, "session-new");
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            return {
              async run() {
                counters.commandLeases += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/SELECT COUNT\(\*\) AS active_count/.test(sql)) {
        return {
          bind(connectorId: string) {
            return {
              async first() {
                return { active_count: connectorId === "connector-replacement" ? 1 : 0 };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /active_command_count/.test(sql)) {
        return {
          bind(activeCount: number, updatedAt: string, connectorId: string) {
            assert.equal(activeCount, connectorId === "connector-replacement" ? 1 : 0);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get leaseReleases() {
      return counters.leaseReleases;
    },
    get commandLeases() {
      return counters.commandLeases;
    }
  } as D1Database & typeof counters;
}

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
