import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalThreadTargetError,
  chooseConnectorForLocalThread,
  ensureConnectorInventory,
  markConnectorDisconnected,
  recordAgentEvent,
  recordHostSessions
} from "./db.js";
import type { Env } from "./types.js";

test("recordAgentEvent ignores stale events from a connector that lost the lease", async () => {
  const db = agentEventGuardDb({
    leaseOwnerConnectorId: "connector-new",
    state: "leased"
  });

  const event = await recordAgentEvent({ DB: db } as Env, "connector-old", {
    command_id: "command-1",
    kind: "command.finished",
    priority: "P1",
    summary: "Late completion"
  });

  assert.equal(event, undefined);
  assert.equal(db.commandUpdates, 0);
  assert.equal(db.eventInserts, 0);
});

test("recordAgentEvent accepts events from the active lease owner", async () => {
  const db = agentEventGuardDb({
    leaseOwnerConnectorId: "connector-online",
    state: "leased"
  });

  const event = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    kind: "command.finished",
    priority: "P1",
    summary: "Finished"
  });

  assert.equal(event?.kind, "command.finished");
  assert.equal(event?.summary, "Finished");
  assert.equal(db.commandUpdates, 1);
  assert.equal(db.taskUpdates, 1);
  assert.equal(db.eventInserts, 1);
});

test("recordAgentEvent marks failed command tasks as failed", async () => {
  const db = agentEventGuardDb(
    {
      leaseOwnerConnectorId: "connector-online",
      state: "running"
    },
    {
      expectedCommandState: "failed",
      expectedTaskState: "failed"
    }
  );

  const event = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    kind: "command.failed",
    priority: "P1",
    summary: "Failed"
  });

  assert.equal(event?.kind, "command.failed");
  assert.equal(db.commandUpdates, 1);
  assert.equal(db.taskUpdates, 1);
  assert.equal(db.eventInserts, 1);
});

test("markConnectorDisconnected fails active commands and marks connector offline", async () => {
  const db = connectorDisconnectedDb();

  const events = await markConnectorDisconnected({ DB: db } as Env, "connector-online");

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "command.failed");
  assert.equal(events[0]?.seq, 8);
  assert.equal(db.commandFailures, 1);
  assert.equal(db.taskUpdates, 1);
  assert.equal(db.eventInserts, 1);
  assert.equal(db.connectorOfflineUpdates, 1);
});

test("ensureConnectorInventory retires duplicate connectors through disconnect cleanup", async () => {
  const db = duplicateConnectorRetirementDb();

  await ensureConnectorInventory({ DB: db } as Env, "connector-new", {
    connector_name: "mac-studio",
    hostname: "mac-studio.local",
    workspace_root: "/workspace/codex",
    capabilities: ["placeholder_commands"]
  });

  assert.equal(db.commandFailures, 1);
  assert.equal(db.migratedHostSessions, 1);
  assert.equal(db.deletedOldHostSessions, 1);
  assert.equal(db.retiredConnectorTokens, 1);
});

test("recordHostSessions preserves stored sessions outside the latest top-N report", async () => {
  const db = hostSessionsInventoryDb();

  const result = await recordHostSessions(
    { DB: db } as Env,
    "connector-online",
    {
      sessions: [
        {
          session_id: "session-new",
          title: "New session",
          title_source: "metadata",
          cwd: "/workspace/new",
          updated_at: "2026-06-12T11:00:00.000Z"
        }
      ]
    },
    "2026-06-12T11:00:05.000Z"
  );

  assert.equal(result.host_sessions.length, 1);
  assert.equal(result.host_sessions[0]?.session_id, "session-new");
  assert.equal(db.hasSession("session-attached"), true);
  assert.equal(db.hasSession("session-new"), true);
  assert.deepEqual(db.sync, {
    connectorId: "connector-online",
    reported: 1,
    stored: 1
  });
});

test("recordHostSessions preserves attached session workspace during inventory refresh", async () => {
  const db = hostSessionsInventoryDb({ workspaceId: "workspace-other" });

  await recordHostSessions(
    { DB: db } as Env,
    "connector-online",
    {
      sessions: [
        {
          session_id: "session-attached",
          title: "Attached session refresh",
          title_source: "app_server",
          cwd: "/workspace/refreshed",
          updated_at: "2026-06-12T11:00:00.000Z"
        }
      ]
    },
    "2026-06-12T11:00:05.000Z"
  );

  assert.equal(db.workspaceOf("session-attached"), "workspace-api");
  assert.equal(db.titleOf("session-attached"), "Attached session refresh");
});

test("chooseConnectorForLocalThread selects app-server capable connectors", async () => {
  const connectorId = await chooseConnectorForLocalThread(
    { DB: localThreadConnectorDb({ id: "connector-online" }) } as Env,
    { id: "user-1", email: "operator@example.com", name: "Operator" },
    { workspace_id: "workspace-api" }
  );

  assert.equal(connectorId, "connector-online");
});

test("chooseConnectorForLocalThread rejects connectors without app-server support", async () => {
  await assert.rejects(
    () =>
      chooseConnectorForLocalThread(
        { DB: localThreadConnectorDb(null) } as Env,
        { id: "user-1", email: "operator@example.com", name: "Operator" },
        { workspace_id: "workspace-api", connector_id: "connector-placeholder" }
      ),
    LocalThreadTargetError
  );
});

function agentEventGuardDb(command: {
  leaseOwnerConnectorId: string;
  state: "leased" | "running" | "succeeded";
}, options: {
  expectedCommandState?: string;
  expectedTaskState?: string;
} = {}) {
  const expectedCommandState = options.expectedCommandState ?? "succeeded";
  const expectedTaskState = options.expectedTaskState ?? "done";
  const counters = {
    commandUpdates: 0,
    taskUpdates: 0,
    eventInserts: 0
  };
  const db = {
    prepare(sql: string) {
      if (/SELECT id, workspace_id, thread_id, task_id, target_connector_id, lease_owner_connector_id, state/.test(sql)) {
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
                  target_connector_id: null,
                  lease_owner_connector_id: command.leaseOwnerConnectorId,
                  state: command.state
                };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /lease_owner_connector_id = \?/.test(sql) && /state IN \('leased', 'running'\)/.test(sql)) {
        return {
          bind(
            nextState: string,
            connectorId: string,
            updatedAt: string,
            commandId: string,
            ownerConnectorId: string
          ) {
            assert.equal(nextState, expectedCommandState);
            assert.equal(connectorId, "connector-online");
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(ownerConnectorId, "connector-online");
            return {
              async run() {
                counters.commandUpdates += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/UPDATE tasks/.test(sql)) {
        return {
          bind(taskState: string, connectorId: string, updatedAt: string, taskId: string) {
            assert.equal(taskState, expectedTaskState);
            assert.equal(connectorId, "connector-online");
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(taskId, "task-1");
            return {
              async run() {
                counters.taskUpdates += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/SELECT last_seq/.test(sql)) {
        throw new Error("appendEvent must allocate event sequence with UPDATE ... RETURNING");
      }

      if (/UPDATE threads/.test(sql) && /RETURNING last_seq/.test(sql)) {
        return {
          bind(updatedAt: string, threadId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(threadId, "thread-1");
            return {
              async first() {
                return { last_seq: 1 };
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
                counters.eventInserts += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE threads/.test(sql) || /UPDATE connectors/.test(sql)) {
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

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get commandUpdates() {
      return counters.commandUpdates;
    },
    get taskUpdates() {
      return counters.taskUpdates;
    },
    get eventInserts() {
      return counters.eventInserts;
    }
  };

  return db as D1Database & typeof counters;
}

function connectorDisconnectedDb() {
  const counters = {
    commandFailures: 0,
    taskUpdates: 0,
    eventInserts: 0,
    connectorOfflineUpdates: 0
  };
  const db = {
    prepare(sql: string) {
      if (/FROM commands/.test(sql) && /lease_owner_connector_id = \?/.test(sql) && /state IN \('leased', 'running'\)/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async all() {
                return {
                  results: [
                    {
                      id: "command-1",
                      workspace_id: "workspace-api",
                      thread_id: "thread-1",
                      task_id: "task-1",
                      type: "codex",
                      prompt: "continue",
                      state: "running",
                      target_connector_id: "connector-online",
                      created_at: "2026-06-12T10:00:00.000Z",
                      updated_at: "2026-06-12T10:00:01.000Z"
                    }
                  ]
                };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /state = 'failed'/.test(sql)) {
        return {
          bind(updatedAt: string, commandId: string, connectorId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.commandFailures += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/UPDATE tasks/.test(sql)) {
        return {
          bind(updatedAt: string, taskId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(taskId, "task-1");
            return {
              async run() {
                counters.taskUpdates += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE threads/.test(sql) && /RETURNING last_seq/.test(sql)) {
        return {
          bind(updatedAt: string, threadId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
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
          bind(
            eventId: string,
            workspaceId: string,
            threadId: string,
            commandId: string,
            seq: number,
            kind: string,
            priority: string,
            summary: string
          ) {
            assert.match(eventId, /^event-/);
            assert.equal(workspaceId, "workspace-api");
            assert.equal(threadId, "thread-1");
            assert.equal(commandId, "command-1");
            assert.equal(seq, 8);
            assert.equal(kind, "command.failed");
            assert.equal(priority, "P1");
            assert.equal(summary, "Connector disconnected before the command completed.");
            return {
              async run() {
                counters.eventInserts += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /status = 'offline'/.test(sql)) {
        return {
          bind(updatedAt: string, connectorId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.connectorOfflineUpdates += 1;
                return { success: true };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get commandFailures() {
      return counters.commandFailures;
    },
    get taskUpdates() {
      return counters.taskUpdates;
    },
    get eventInserts() {
      return counters.eventInserts;
    },
    get connectorOfflineUpdates() {
      return counters.connectorOfflineUpdates;
    }
  };

  return db as D1Database & typeof counters;
}

function duplicateConnectorRetirementDb() {
  const counters = {
    commandFailures: 0,
    eventInserts: 0,
    migratedHostSessions: 0,
    deletedOldHostSessions: 0,
    retiredConnectorTokens: 0
  };
  const db = {
    prepare(sql: string) {
      if (/SELECT id\s+FROM connectors\s+WHERE id <> \? AND name = \? AND hostname = \?/.test(sql)) {
        return {
          bind(connectorId: string, name: string, hostname: string) {
            assert.equal(connectorId, "connector-new");
            assert.equal(name, "mac-studio");
            assert.equal(hostname, "mac-studio.local");
            return {
              async all() {
                return { results: [{ id: "connector-old" }] };
              }
            };
          }
        };
      }

      if (/FROM commands/.test(sql) && /lease_owner_connector_id = \?/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-old");
            return {
              async all() {
                return {
                  results: [
                    {
                      id: "command-old",
                      workspace_id: "workspace-api",
                      thread_id: "thread-old",
                      task_id: "task-old",
                      type: "placeholder",
                      prompt: "continue",
                      state: "running",
                      target_connector_id: "connector-old",
                      created_at: "2026-06-12T10:00:00.000Z",
                      updated_at: "2026-06-12T10:00:01.000Z"
                    }
                  ]
                };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /state = 'failed'/.test(sql)) {
        return {
          bind(updatedAt: string, commandId: string, connectorId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-old");
            assert.equal(connectorId, "connector-old");
            return {
              async run() {
                counters.commandFailures += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/UPDATE tasks/.test(sql) && /state = 'failed'/.test(sql)) {
        return {
          bind(updatedAt: string, taskId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(taskId, "task-old");
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
          bind(updatedAt: string, threadId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(threadId, "thread-old");
            return {
              async first() {
                return { last_seq: 9 };
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
                counters.eventInserts += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /token_hash = CASE/.test(sql)) {
        return {
          bind(updatedAt: string, connectorId: string, name: string, hostname: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-new");
            assert.equal(name, "mac-studio");
            assert.equal(hostname, "mac-studio.local");
            return {
              async run() {
                counters.retiredConnectorTokens += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /status = 'offline'/.test(sql)) {
        return {
          bind(updatedAt: string, connectorId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-old");
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      if (/SELECT id, connector_id, hostname, workspace_id, session_id/.test(sql) && /FROM host_sessions/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-old");
            return {
              async all() {
                return {
                  results: [
                    {
                      id: "host-session-old",
                      connector_id: "connector-old",
                      hostname: "mac-studio.local",
                      workspace_id: "workspace-api",
                      session_id: "session-1",
                      title: "Attached session",
                      title_source: "history",
                      cwd: "/workspace/project",
                      attached_task_id: "task-old",
                      attached_thread_id: "thread-old",
                      updated_at: "2026-06-12T10:00:00.000Z"
                    }
                  ]
                };
              }
            };
          }
        };
      }

      if (/INSERT INTO host_sessions/.test(sql)) {
        return {
          bind(hostSessionId: string, connectorId: string, hostname: string) {
            assert.equal(hostSessionId, "host-session-session-1-connector-new");
            assert.equal(connectorId, "connector-new");
            assert.equal(hostname, "mac-studio.local");
            return {
              async run() {
                counters.migratedHostSessions += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/DELETE FROM host_sessions/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-old");
            return {
              async run() {
                counters.deletedOldHostSessions += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (
        /INSERT INTO task_categories/.test(sql) ||
        /INSERT INTO workspaces/.test(sql) ||
        /INSERT INTO workspace_connectors/.test(sql) ||
        /INSERT INTO threads/.test(sql) ||
        /INSERT INTO tasks/.test(sql)
      ) {
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

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get commandFailures() {
      return counters.commandFailures;
    },
    get migratedHostSessions() {
      return counters.migratedHostSessions;
    },
    get deletedOldHostSessions() {
      return counters.deletedOldHostSessions;
    },
    get retiredConnectorTokens() {
      return counters.retiredConnectorTokens;
    }
  };

  return db as D1Database & typeof counters;
}

function hostSessionsInventoryDb(options: { workspaceId?: string } = {}) {
  const selectedWorkspaceId = options.workspaceId ?? "workspace-api";
  type StoredHostSession = {
    id: string;
    connector_id: string;
    hostname: string;
    workspace_id: string;
    session_id: string;
    title: string;
    title_source: string;
    cwd: string | null;
    attached_task_id: string | null;
    attached_thread_id: string | null;
    updated_at: string;
  };

  const sessions = new Map<string, StoredHostSession>([
    [
      "session-attached",
      {
        id: "host-session-attached",
        connector_id: "connector-online",
        hostname: "mac-studio.local",
        workspace_id: "workspace-api",
        session_id: "session-attached",
        title: "Attached session",
        title_source: "history",
        cwd: "/workspace/attached",
        attached_task_id: "task-attached",
        attached_thread_id: "thread-attached",
        updated_at: "2026-06-12T10:00:00.000Z"
      }
    ]
  ]);
  const counters = {
    sync: undefined as { connectorId: string; reported: number; stored: number } | undefined,
    hasSession(sessionId: string) {
      return sessions.has(sessionId);
    },
    workspaceOf(sessionId: string) {
      return sessions.get(sessionId)?.workspace_id;
    },
    titleOf(sessionId: string) {
      return sessions.get(sessionId)?.title;
    }
  };

  const db = {
    prepare(sql: string) {
      if (/SELECT hostname/.test(sql) && /FROM connectors/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return { hostname: "mac-studio.local" };
              }
            };
          }
        };
      }

      if (/SELECT workspace_id/.test(sql) && /FROM workspace_connectors/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return { workspace_id: selectedWorkspaceId };
              }
            };
          }
        };
      }

      if (/INSERT INTO host_sessions/.test(sql)) {
        return {
          bind(
            id: string,
            connectorId: string,
            hostname: string,
            workspaceId: string,
            sessionId: string,
            title: string,
            titleSource: string,
            cwd: string | null,
            discoveredAt: string,
            updatedAt: string
          ) {
            assert.equal(connectorId, "connector-online");
            assert.equal(hostname, "mac-studio.local");
            assert.equal(workspaceId, selectedWorkspaceId);
            assert.equal(discoveredAt, "2026-06-12T11:00:05.000Z");
            assert.match(
              sql,
              /CASE\s+WHEN host_sessions\.attached_task_id IS NOT NULL OR host_sessions\.attached_thread_id IS NOT NULL/
            );
            return {
              async run() {
                const existing = sessions.get(sessionId);
                sessions.set(sessionId, {
                  id,
                  connector_id: connectorId,
                  hostname,
                  workspace_id:
                    existing?.attached_task_id || existing?.attached_thread_id
                      ? existing.workspace_id
                      : workspaceId,
                  session_id: sessionId,
                  title,
                  title_source: titleSource,
                  cwd,
                  attached_task_id: existing?.attached_task_id ?? null,
                  attached_thread_id: existing?.attached_thread_id ?? null,
                  updated_at: updatedAt
                });
                return { success: true };
              }
            };
          }
        };
      }

      if (/SELECT hs\.id, hs\.connector_id/.test(sql) && /FROM host_sessions hs/.test(sql)) {
        return {
          bind(sessionId: string, connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return sessions.get(sessionId);
              }
            };
          }
        };
      }

      if (/DELETE FROM host_sessions/.test(sql)) {
        throw new Error("recordHostSessions must not delete sessions from partial inventory reports");
      }

      if (/INSERT INTO host_session_syncs/.test(sql)) {
        return {
          bind(connectorId: string, syncedAt: string, reported: number, stored: number) {
            assert.equal(syncedAt, "2026-06-12T11:00:05.000Z");
            return {
              async run() {
                counters.sync = { connectorId, reported, stored };
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /last_seen_at/.test(sql)) {
        return {
          bind(lastSeenAt: string, updatedAt: string, connectorId: string) {
            assert.equal(lastSeenAt, "2026-06-12T11:00:05.000Z");
            assert.equal(updatedAt, "2026-06-12T11:00:05.000Z");
            assert.equal(connectorId, "connector-online");
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
    get sync() {
      return counters.sync;
    },
    hasSession(sessionId: string) {
      return counters.hasSession(sessionId);
    },
    workspaceOf(sessionId: string) {
      return counters.workspaceOf(sessionId);
    },
    titleOf(sessionId: string) {
      return counters.titleOf(sessionId);
    }
  };

  return db as D1Database & typeof counters;
}

function localThreadConnectorDb(row: { id: string } | null): D1Database {
  return {
    prepare(sql: string) {
      if (/INSERT INTO users/.test(sql)) {
        return {
          bind(userId: string, email: string, name: string) {
            assert.equal(userId, "user-1");
            assert.equal(email, "operator@example.com");
            assert.equal(name, "Operator");
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      if (/SELECT id FROM workspaces/.test(sql)) {
        return {
          bind(workspaceId: string) {
            assert.equal(workspaceId, "workspace-api");
            return {
              async first() {
                return { id: workspaceId };
              }
            };
          }
        };
      }

      if (/SELECT c\.id/.test(sql) && /app_server_threads/.test(sql)) {
        assert.match(sql, /workspace_connectors/);
        assert.match(sql, /wc\.can_execute = 1/);
        assert.match(sql, /c\.status <> 'offline'/);
        assert.match(sql, /capabilities_json LIKE/);
        return {
          bind(first: string, second?: string) {
            if (second !== undefined) {
              assert.equal(first, "connector-placeholder");
              assert.equal(second, "workspace-api");
            } else {
              assert.equal(first, "workspace-api");
            }
            return {
              async first() {
                return row;
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    }
  } as unknown as D1Database;
}
