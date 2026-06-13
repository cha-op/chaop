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

test("internal broadcast thread events forwards valid events to browser sockets", async () => {
  const sent: string[] = [];
  const browserSocket = {
    send(message: string) {
      sent.push(message);
    }
  } as unknown as WebSocket;
  const workspace = new WorkspaceDO({
    getWebSockets(tag?: string) {
      assert.equal(tag, "browser");
      return [browserSocket];
    }
  } as unknown as DurableObjectState, {} as Env);

  const response = await workspace.fetch(new Request("https://workspace-do/internal/broadcast-thread-events", {
    method: "POST",
    body: JSON.stringify({
      events: [
        {
          id: "event-1",
          thread_id: "thread-1",
          command_id: "command-1",
          seq: 7,
          kind: "command.failed",
          priority: "P1",
          summary: "Host session detached.",
          created_at: "2026-06-13T10:00:00.000Z"
        },
        { id: "bad-event" }
      ]
    })
  }));
  const body = await response.json() as { broadcasted?: number };

  assert.equal(response.status, 200);
  assert.equal(body.broadcasted, 1);
  assert.equal(sent.length, 1);
  const envelope = JSON.parse(sent[0] ?? "{}") as {
    kind?: string;
    payload?: { event?: { id?: string; summary?: string } };
  };
  assert.equal(envelope.kind, "thread.event");
  assert.equal(envelope.payload?.event?.id, "event-1");
  assert.equal(envelope.payload?.event?.summary, "Host session detached.");
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

test("rejected stale final command events still poll pending work for the connector", async () => {
  const sent: string[] = [];
  const agentSocket = {
    send(message: string) {
      sent.push(message);
    },
    deserializeAttachment() {
      return { socketType: "agent", connectorId: "connector-online", connectedAt: 300 };
    }
  } as unknown as WebSocket;
  const db = staleFinalCommandEventDb();
  const workspace = new WorkspaceDO({} as DurableObjectState, { DB: db } as Env);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.event",
    payload: {
      command_id: "command-1",
      kind: "command.failed",
      priority: "P1",
      summary: "Finished after stale lease"
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
    kind: "command.failed",
    accepted: false
  });
  assert.equal(db.pendingDispatchQueries, 1);
});

test("rejected starts with generated final events still poll pending work for the connector", async () => {
  const sent: string[] = [];
  const agentSocket = {
    send(message: string) {
      sent.push(message);
    },
    deserializeAttachment() {
      return { socketType: "agent", connectorId: "connector-online", connectedAt: 300 };
    }
  } as unknown as WebSocket;
  const db = rejectedStartedEventWithFailedResultDb();
  const workspace = new WorkspaceDO({
    getWebSockets(tag?: string) {
      assert.equal(tag, "browser");
      return [];
    }
  } as unknown as DurableObjectState, { DB: db } as Env);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.event",
    payload: {
      command_id: "command-1",
      kind: "command.started",
      priority: "P1",
      summary: "Starting stale explicit target"
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
  assert.equal(db.explicitFailures, 1);
  assert.equal(db.pendingDispatchQueries, 1);
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

function staleFinalCommandEventDb(): D1Database & { readonly pendingDispatchQueries: number } {
  const counters = { pendingDispatchQueries: 0 };
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
                  target_connector_id_source: "auto",
                  lease_owner_connector_id: "connector-online",
                  state: "failed",
                  lease_target_host_session_id: null
                };
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
            autoAttachmentConnectorId: string,
            hostSessionConnectorId: string,
            executableConnectorId: string
          ) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(targetConnectorId, "connector-online");
            assert.equal(autoAttachmentConnectorId, "connector-online");
            assert.equal(hostSessionConnectorId, "connector-online");
            assert.equal(executableConnectorId, "connector-online");
            return {
              async all() {
                counters.pendingDispatchQueries += 1;
                return { results: [] };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get pendingDispatchQueries() {
      return counters.pendingDispatchQueries;
    }
  } as D1Database & { readonly pendingDispatchQueries: number };
}

function rejectedStartedEventWithFailedResultDb(): D1Database & {
  readonly explicitFailures: number;
  readonly pendingDispatchQueries: number;
} {
  const counters = {
    explicitFailures: 0,
    pendingDispatchQueries: 0
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
                  target_connector_id: "connector-online",
                  target_connector_id_source: "explicit",
                  lease_owner_connector_id: "connector-online",
                  state: "leased",
                  lease_target_host_session_id: "session-old"
                };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /SET state = 'pending'/.test(sql)) {
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

      if (/UPDATE commands/.test(sql) && /SET state = 'failed'/.test(sql)) {
        return {
          bind(now: string, commandId: string, connectorId: string, sessionId: string) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(connectorId, "connector-online");
            assert.equal(sessionId, "session-old");
            return {
              async run() {
                counters.explicitFailures += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/UPDATE tasks/.test(sql)) {
        return {
          bind(now: string, taskId: string) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(taskId, "task-1");
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE threads/.test(sql) && /RETURNING last_seq/.test(sql)) {
        return {
          bind(now: string, threadId: string) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(threadId, "thread-1");
            return {
              async first() {
                return { last_seq: 8 };
              }
            };
          }
        };
      }

      if (/INSERT INTO events/.test(sql)) {
        return {
          bind() {
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      if (/SELECT COUNT\(\*\) AS active_count/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return { active_count: 0 };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql)) {
        return {
          bind(activeCount: number, now: string, connectorId: string) {
            assert.equal(activeCount, 0);
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                return { success: true };
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
            autoAttachmentConnectorId: string,
            hostSessionConnectorId: string,
            executableConnectorId: string
          ) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(targetConnectorId, "connector-online");
            assert.equal(autoAttachmentConnectorId, "connector-online");
            assert.equal(hostSessionConnectorId, "connector-online");
            assert.equal(executableConnectorId, "connector-online");
            return {
              async all() {
                counters.pendingDispatchQueries += 1;
                return { results: [] };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get explicitFailures() {
      return counters.explicitFailures;
    },
    get pendingDispatchQueries() {
      return counters.pendingDispatchQueries;
    }
  } as D1Database & { readonly explicitFailures: number; readonly pendingDispatchQueries: number };
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
        !/SET state = 'leased'/.test(sql) &&
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
        assert.match(sql, /\? OR commands\.target_connector_id IS NULL OR hs\.connector_id = commands\.target_connector_id/);
        return {
          bind(
            clearTargetConnectorId: number,
            clearTargetConnectorIdSource: number,
            updatedAt: string,
            commandId: string,
            connectorId: string,
            targetHostSessionId: string,
            replacementExcludedConnectorId: string,
            replacementExcludedSessionId: string,
            replacementCanIgnoreOldTarget: number
          ) {
            assert.equal(clearTargetConnectorId, 1);
            assert.equal(clearTargetConnectorIdSource, 1);
            assert.equal(replacementCanIgnoreOldTarget, 1);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(connectorId, "connector-stale");
            assert.equal(targetHostSessionId, "session-old");
            assert.equal(replacementExcludedConnectorId, "connector-stale");
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
            autoAttachmentConnectorId: string,
            hostSessionConnectorId: string,
            executableConnectorId: string
          ) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(targetConnectorId, autoAttachmentConnectorId);
            assert.equal(autoAttachmentConnectorId, hostSessionConnectorId);
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
                      target_connector_id_source: "auto",
                      created_at: "2026-06-13T10:00:00.000Z",
                      updated_at: "2026-06-13T10:00:00.000Z",
                      target_host_session_row_id: "host-session-new",
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
            targetHostSessionIdForTarget: string | null,
            targetHostSessionIsAppServerForTarget: number,
            retargetConnectorId: string,
            targetHostSessionIdForSource: string | null,
            targetHostSessionIsAppServerForSource: number,
            connectorId: string,
            leaseUntil: string,
            leaseTargetHostSessionId: string,
            updatedAt: string,
            commandId: string,
            now: string,
            selectedHostSessionIdForNullGuard: string | null,
            selectedHostSessionIdForPresentGuard: string | null,
            selectedHostSessionIdForMatchGuard: string | null,
            targetHostSessionIdForStoredLeaseGuard: string | null,
            targetConnectorId: string,
            targetHostSessionIdForAutoTargetGuard: string | null,
            autoTargetConnectorId: string,
            targetHostSessionIdForCapabilityGuard: string | null,
            capabilityConnectorId: string,
            capabilityHostSessionConnectorId: string
          ) {
            assert.equal(targetHostSessionIdForTarget, "session-new");
            assert.equal(targetHostSessionIsAppServerForTarget, 1);
            assert.equal(retargetConnectorId, "connector-replacement");
            assert.equal(targetHostSessionIdForSource, "session-new");
            assert.equal(targetHostSessionIsAppServerForSource, 1);
            assert.equal(connectorId, "connector-replacement");
            assert.match(leaseUntil, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(leaseTargetHostSessionId, "session-new");
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(selectedHostSessionIdForNullGuard, "host-session-new");
            assert.equal(selectedHostSessionIdForPresentGuard, "host-session-new");
            assert.equal(selectedHostSessionIdForMatchGuard, "host-session-new");
            assert.equal(targetHostSessionIdForStoredLeaseGuard, "host-session-new");
            assert.equal(targetConnectorId, "connector-replacement");
            assert.equal(targetHostSessionIdForAutoTargetGuard, "host-session-new");
            assert.equal(autoTargetConnectorId, "connector-replacement");
            assert.equal(targetHostSessionIdForCapabilityGuard, "host-session-new");
            assert.equal(capabilityConnectorId, "connector-replacement");
            assert.equal(capabilityHostSessionConnectorId, "connector-replacement");
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
