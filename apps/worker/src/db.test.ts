import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalThreadTargetError,
  chooseConnectorForLocalThread,
  ensureConnectorInventory,
  listThreadEventsInDb,
  markConnectorDisconnected,
  pendingCommandsForConnector,
  recordAgentEvent,
  recordHostSessionBackfillEvents,
  recordHostSessions
} from "./db.js";
import type { Env } from "./types.js";

test("recordAgentEvent ignores stale events from a connector that lost the lease", async () => {
  const db = agentEventGuardDb({
    leaseOwnerConnectorId: "connector-new",
    state: "leased"
  });

  const result = await recordAgentEvent({ DB: db } as Env, "connector-old", {
    command_id: "command-1",
    kind: "command.finished",
    priority: "P1",
    summary: "Late completion"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.event, undefined);
  assert.equal(db.commandUpdates, 0);
  assert.equal(db.eventInserts, 0);
});

test("recordAgentEvent rejects app-server starts after the attachment is detached", async () => {
  const db = appServerStartAfterDetachDb();

  const result = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    target_host_session_id: "session-old",
    kind: "command.started",
    priority: "P1",
    summary: "Starting"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.dispatch_pending, false);
  assert.equal(result.event, undefined);
  assert.equal(db.commandUpdates, 0);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
});

test("recordAgentEvent keeps explicit targets when stale app-server starts are released", async () => {
  const db = appServerStartAfterDetachDb(
    {
      connector_id: "connector-online",
      session_id: "session-new",
      app_server_present: 1
    },
    { targetConnectorIdSource: "explicit" }
  );

  const result = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    target_host_session_id: "session-old",
    kind: "command.started",
    priority: "P1",
    summary: "Starting"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.dispatch_pending, true);
  assert.equal(result.event, undefined);
  assert.equal(db.commandUpdates, 1);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
});

test("recordAgentEvent releases attached inferred targets to replacement connectors", async () => {
  const db = appServerStartAfterDetachDb({
    connector_id: "connector-replacement",
    session_id: "session-new",
    app_server_present: 1
  });

  const result = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    target_host_session_id: "session-old",
    kind: "command.started",
    priority: "P1",
    summary: "Starting"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.dispatch_pending, true);
  assert.equal(result.event, undefined);
  assert.equal(db.commandUpdates, 1);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
});

test("recordAgentEvent keeps explicit targets bound to the requested connector", async () => {
  const db = appServerStartAfterDetachDb(
    {
      connector_id: "connector-replacement",
      session_id: "session-new",
      app_server_present: 1
    },
    { targetConnectorIdSource: "explicit" }
  );

  const result = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    target_host_session_id: "session-old",
    kind: "command.started",
    priority: "P1",
    summary: "Starting"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.dispatch_pending, false);
  assert.equal(result.event, undefined);
  assert.equal(db.commandUpdates, 0);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
});

test("recordAgentEvent rejects app-server starts after the connector reattaches a different session", async () => {
  const db = appServerStartAfterDetachDb({
    connector_id: "connector-online",
    session_id: "session-new",
    app_server_present: 1
  });

  const result = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    target_host_session_id: "session-old",
    kind: "command.started",
    priority: "P1",
    summary: "Starting"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.dispatch_pending, true);
  assert.equal(result.event, undefined);
  assert.equal(db.commandUpdates, 1);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
});

test("recordAgentEvent rejects app-server starts that differ from the leased target session", async () => {
  const db = appServerStartAfterDetachDb({
    connector_id: "connector-online",
    session_id: "session-new",
    app_server_present: 1
  });

  const result = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    target_host_session_id: "session-new",
    kind: "command.started",
    priority: "P1",
    summary: "Starting"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.dispatch_pending, true);
  assert.equal(result.event, undefined);
  assert.equal(db.commandUpdates, 1);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
});

test("recordAgentEvent accepts app-server starts for the current target session", async () => {
  const db = appServerStartAfterDetachDb({
    connector_id: "connector-online",
    session_id: "session-old",
    app_server_present: 1
  });

  const result = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    target_host_session_id: "session-old",
    kind: "command.started",
    priority: "P1",
    summary: "Starting"
  });

  assert.equal(result.accepted, true);
  assert.equal(result.event?.kind, "command.started");
  assert.equal(db.commandUpdates, 1);
  assert.equal(db.taskUpdates, 1);
  assert.equal(db.eventInserts, 1);
});

test("recordAgentEvent rejects app-server starts without the leased target session", async () => {
  const db = appServerStartAfterDetachDb({
    connector_id: "connector-online",
    session_id: "session-old",
    app_server_present: 1
  });

  const result = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    kind: "command.started",
    priority: "P1",
    summary: "Starting"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.dispatch_pending, false);
  assert.equal(result.event, undefined);
  assert.equal(db.commandUpdates, 0);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
});

test("recordAgentEvent accepts events from the active lease owner", async () => {
  const db = agentEventGuardDb({
    leaseOwnerConnectorId: "connector-online",
    state: "leased"
  });

  const result = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    kind: "command.finished",
    priority: "P1",
    summary: "Finished"
  });

  assert.equal(result.accepted, true);
  assert.equal(result.event?.kind, "command.finished");
  assert.equal(result.event?.summary, "Finished");
  assert.equal(db.commandUpdates, 1);
  assert.equal(db.taskUpdates, 1);
  assert.equal(db.eventInserts, 1);
});

test("recordAgentEvent accepts ordinary codex starts without an app-server lease target", async () => {
  const db = agentEventGuardDb(
    {
      leaseOwnerConnectorId: "connector-online",
      state: "leased"
    },
    {
      expectedCommandState: "running",
      expectedTaskState: "running"
    }
  );

  const result = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    kind: "command.started",
    priority: "P1",
    summary: "Starting"
  });

  assert.equal(result.accepted, true);
  assert.equal(result.event?.kind, "command.started");
  assert.equal(db.commandUpdates, 1);
  assert.equal(db.taskUpdates, 1);
  assert.equal(db.eventInserts, 1);
});

test("recordAgentEvent rejects targeted app-server starts for ordinary codex leases", async () => {
  const db = appServerStartAfterDetachDb(
    {
      connector_id: "connector-online",
      session_id: "session-old",
      app_server_present: 1
    },
    { leaseTargetHostSessionId: null }
  );

  const result = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    target_host_session_id: "session-old",
    kind: "command.started",
    priority: "P1",
    summary: "Starting"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.dispatch_pending, false);
  assert.equal(result.event, undefined);
  assert.equal(db.commandUpdates, 0);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
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

  const result = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    kind: "command.failed",
    priority: "P1",
    summary: "Failed"
  });

  assert.equal(result.accepted, true);
  assert.equal(result.event?.kind, "command.failed");
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

test("pendingCommandsForConnector includes the task-first attached host session target", async () => {
  const db = pendingCommandDispatchDb();

  const dispatches = await pendingCommandsForConnector({ DB: db } as Env, "connector-online");

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0]?.command.id, "command-1");
  assert.equal(dispatches[0]?.target_host_session?.session_id, "session-tree-1");
  assert.equal(dispatches[0]?.target_host_session?.app_server_present, true);
  assert.equal(dispatches[0]?.target_host_session?.cwd, "/workspace/project");
  assert.equal(db.commandLeaseUpdates, 1);
  assert.equal(db.connectorActivityUpdates, 1);
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
          app_server_present: true,
          cwd: "/workspace/refreshed",
          updated_at: "2026-06-12T11:00:00.000Z"
        }
      ]
    },
    "2026-06-12T11:00:05.000Z"
  );

  assert.equal(db.workspaceOf("session-attached"), "workspace-api");
  assert.equal(db.titleOf("session-attached"), "Attached session refresh");
  assert.equal(db.appServerPresentOf("session-attached"), 1);
});

test("recordHostSessions infers app-server presence for legacy app-server reports", async () => {
  const db = hostSessionsInventoryDb({ workspaceId: "workspace-other" });

  await recordHostSessions(
    { DB: db } as Env,
    "connector-online",
    {
      sessions: [
        {
          session_id: "session-attached",
          title: "Legacy app-server title",
          title_source: "app_server",
          cwd: "/workspace/refreshed",
          updated_at: "2026-06-12T11:00:00.000Z"
        }
      ]
    },
    "2026-06-12T11:00:05.000Z"
  );

  assert.equal(db.titleOf("session-attached"), "Legacy app-server title");
  assert.equal(db.appServerPresentOf("session-attached"), 1);
});

test("recordHostSessions keeps app-server presence independent from title source", async () => {
  const db = hostSessionsInventoryDb({ workspaceId: "workspace-other" });

  await recordHostSessions(
    { DB: db } as Env,
    "connector-online",
    {
      sessions: [
        {
          session_id: "session-attached",
          title: "Metadata title from app-server inventory",
          title_source: "metadata",
          app_server_present: true,
          cwd: "/workspace/refreshed",
          updated_at: "2026-06-12T11:00:00.000Z"
        }
      ]
    },
    "2026-06-12T11:00:05.000Z"
  );

  assert.equal(db.titleOf("session-attached"), "Metadata title from app-server inventory");
  assert.equal(db.appServerPresentOf("session-attached"), 1);

  await recordHostSessions(
    { DB: db } as Env,
    "connector-online",
    {
      sessions: [
        {
          session_id: "session-attached",
          title: "History title after archive",
          title_source: "history",
          cwd: "/workspace/refreshed",
          updated_at: "2026-06-12T11:00:10.000Z"
        }
      ]
    },
    "2026-06-12T11:00:05.000Z"
  );

  assert.equal(db.titleOf("session-attached"), "History title after archive");
  assert.equal(db.appServerPresentOf("session-attached"), 1);
});

test("recordHostSessionBackfillEvents imports events idempotently", async () => {
  const db = hostSessionBackfillDb();
  const hostSession = {
    id: "host-session-1",
    connector_id: "connector-online",
    hostname: "mac-studio.local",
    workspace_id: "workspace-api",
    session_id: "session-1",
    title: "Session",
    title_source: "metadata" as const,
    cwd: "/workspace/project",
    updated_at: "2026-06-12T10:00:00.000Z",
    attached_task_id: "task-1",
    attached_thread_id: "thread-1"
  };
  const events = [
    {
      kind: "command.output" as const,
      priority: "P3" as const,
      summary: "2026-06-12 10:00 - User: Inspect failure",
      idempotency_key: "rollout:session-1:1",
      created_at: "2026-06-12T10:00:00.000Z"
    }
  ];

  const first = await recordHostSessionBackfillEvents({ DB: db } as Env, hostSession, events);
  const second = await recordHostSessionBackfillEvents({ DB: db } as Env, hostSession, events);

  assert.equal(first.length, 1);
  assert.equal(first[0]?.seq, 1);
  assert.equal(second.length, 0);
  assert.equal(db.eventInserts, 1);
  assert.equal(db.sequenceUpdates, 1);
});

test("recordHostSessionBackfillEvents does not return events ignored during insert", async () => {
  const db = hostSessionBackfillDb({ ignoreInserts: true });
  const hostSession = {
    id: "host-session-1",
    connector_id: "connector-online",
    hostname: "mac-studio.local",
    workspace_id: "workspace-api",
    session_id: "session-1",
    title: "Session",
    title_source: "metadata" as const,
    cwd: "/workspace/project",
    updated_at: "2026-06-12T10:00:00.000Z",
    attached_task_id: "task-1",
    attached_thread_id: "thread-1"
  };
  const events = [
    {
      kind: "command.output" as const,
      priority: "P3" as const,
      summary: "2026-06-12 10:00 - User: Inspect failure",
      idempotency_key: "rollout:session-1:1",
      created_at: "2026-06-12T10:00:00.000Z"
    }
  ];

  const imported = await recordHostSessionBackfillEvents({ DB: db } as Env, hostSession, events);

  assert.equal(imported.length, 0);
  assert.equal(db.eventInserts, 0);
  assert.equal(db.sequenceUpdates, 1);
});

test("listThreadEventsInDb returns a thread tail by seq independent of global event age", async () => {
  const events = await listThreadEventsInDb({ DB: threadEventsDb() } as Env, "thread-1");

  assert.deepEqual(
    events.map((event) => [event.id, event.seq, event.created_at]),
    [
      ["event-backfill-old-1", 1, "2026-06-12T10:00:00.000Z"],
      ["event-backfill-old-2", 2, "2026-06-12T10:01:00.000Z"]
    ]
  );
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
                  lease_owner_connector_id: command.leaseOwnerConnectorId,
                  state: command.state,
                  lease_target_host_session_id: null
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

function appServerStartAfterDetachDb(currentTarget?: {
  connector_id: string;
  session_id: string;
  app_server_present: number;
}, options: {
  leaseTargetHostSessionId?: string | null;
  targetConnectorIdSource?: "explicit" | "attached" | "auto";
} = {}) {
  const leaseTargetHostSessionId =
    options.leaseTargetHostSessionId === undefined ? "session-old" : options.leaseTargetHostSessionId;
  const targetConnectorIdSource = options.targetConnectorIdSource ?? "attached";
  const counters = {
    commandUpdates: 0,
    taskUpdates: 0,
    eventInserts: 0
  };
  let releasedLease = false;
  const db = {
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
                  target_connector_id_source: targetConnectorIdSource,
                  lease_owner_connector_id: "connector-online",
                  state: "leased",
                  lease_target_host_session_id: leaseTargetHostSessionId
                };
              }
            };
          }
        };
      }

      if (/SELECT capabilities_json/.test(sql) && /FROM connectors/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return { capabilities_json: JSON.stringify(["codex_app_server_exec"]) };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /SET state = 'pending'/.test(sql)) {
        assert.match(sql, /target_connector_id = CASE WHEN \? THEN NULL ELSE target_connector_id END/);
        assert.match(sql, /target_connector_id_source = CASE WHEN \? THEN 'auto' ELSE target_connector_id_source END/);
        assert.match(sql, /lease_owner_connector_id = NULL/);
        assert.match(sql, /lease_until = NULL/);
        assert.match(sql, /lease_target_host_session_id = NULL/);
        assert.match(sql, /state = 'leased'/);
        assert.match(sql, /lease_target_host_session_id IS NOT NULL/);
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
            ownerConnectorId: string,
            targetHostSessionId: string | null,
            replacementExcludedSessionId: string | null,
            replacementCanIgnoreOldTarget: number
          ) {
            const shouldClearImplicitTarget = targetConnectorIdSource === "attached" ? 1 : 0;
            assert.equal(clearTargetConnectorId, shouldClearImplicitTarget);
            assert.equal(clearTargetConnectorIdSource, shouldClearImplicitTarget);
            assert.equal(replacementCanIgnoreOldTarget, shouldClearImplicitTarget);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(ownerConnectorId, "connector-online");
            assert.equal(targetHostSessionId, leaseTargetHostSessionId);
            assert.equal(replacementExcludedSessionId, leaseTargetHostSessionId);
            const replacementMatchesTarget = Boolean(
              currentTarget && (targetConnectorIdSource === "attached" || currentTarget.connector_id === "connector-online")
            );
            const changes =
              leaseTargetHostSessionId !== null &&
              replacementMatchesTarget &&
              currentTarget &&
              currentTarget.session_id !== leaseTargetHostSessionId &&
              currentTarget.app_server_present === 1
                ? 1
                : 0;
            return {
              async run() {
                releasedLease = changes > 0;
                counters.commandUpdates += changes;
                return { meta: { changes } };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql)) {
        assert.match(sql, /EXISTS \(\s+SELECT 1\s+FROM host_sessions hs/);
        assert.match(sql, /lease_target_host_session_id IS NOT NULL/);
        assert.match(sql, /lease_target_host_session_id = \?/);
        assert.match(sql, /hs\.session_id = \?/);
        assert.match(sql, /hs2\.updated_at DESC,\s+hs2\.id DESC/);
        return {
          bind(
            nextState: string,
            connectorId: string,
            updatedAt: string,
            commandId: string,
            ownerConnectorId: string,
            eventTargetHostSessionId: string | null,
            workspaceId: string,
            taskIdPresent: string | null,
            taskId: string | null,
            threadIdPresent: string | null,
            threadId: string | null,
            taskIdNullCheck: string | null,
            taskIdForExists: string | null,
            taskIdForOrder: string | null,
            taskIdForOrderMatch: string | null,
            targetConnectorId: string,
            targetHostSessionId: string | null
          ) {
            assert.equal(nextState, "running");
            assert.equal(connectorId, "connector-online");
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(ownerConnectorId, "connector-online");
            assert.equal(workspaceId, "workspace-api");
            assert.equal(taskIdPresent, "task-1");
            assert.equal(taskId, "task-1");
            assert.equal(threadIdPresent, "thread-1");
            assert.equal(threadId, "thread-1");
            assert.equal(taskIdNullCheck, "task-1");
            assert.equal(taskIdForExists, "task-1");
            assert.equal(taskIdForOrder, "task-1");
            assert.equal(taskIdForOrderMatch, "task-1");
            assert.equal(targetConnectorId, "connector-online");
            const changes =
              leaseTargetHostSessionId !== null &&
              leaseTargetHostSessionId === eventTargetHostSessionId &&
              currentTarget?.connector_id === targetConnectorId &&
              currentTarget.session_id === targetHostSessionId &&
              currentTarget.app_server_present === 1
                ? 1
                : 0;
            return {
              async run() {
                counters.commandUpdates += changes;
                return { meta: { changes } };
              }
            };
          }
        };
      }

      if (/UPDATE tasks/.test(sql)) {
        return {
          bind() {
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

      if (/UPDATE connectors/.test(sql) && /last_seen_at/.test(sql)) {
        return {
          bind(lastSeenAt: string, updatedAt: string, connectorId: string) {
            assert.match(lastSeenAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
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
                return { active_count: releasedLease ? 0 : 1 };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /active_command_count/.test(sql)) {
        return {
          bind(activeCount: number, updatedAt: string, connectorId: string) {
            assert.equal(activeCount, releasedLease ? 0 : 1);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
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
                      app_server_present: 1,
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

function pendingCommandDispatchDb() {
  const counters = {
    commandLeaseUpdates: 0,
    connectorActivityUpdates: 0
  };
  const db = {
    prepare(sql: string) {
      if (/FROM commands cmd/.test(sql) && /LEFT JOIN host_sessions hs/.test(sql)) {
        assert.match(sql, /hs\.session_id AS target_host_session_id/);
        assert.match(sql, /ON hs\.id = COALESCE\(/);
        assert.match(sql, /cmd\.task_id IS NOT NULL\s+AND hs_task\.attached_task_id = cmd\.task_id/);
        assert.match(sql, /cmd\.thread_id IS NOT NULL\s+AND hs_thread\.attached_thread_id = cmd\.thread_id/);
        assert.match(sql, /OR NOT EXISTS \(\s+SELECT 1\s+FROM host_sessions hst/);
        assert.match(sql, /hst\.workspace_id = cmd\.workspace_id\s+AND hst\.attached_task_id = cmd\.task_id/);
        assert.doesNotMatch(sql, /CASE\s+WHEN cmd\.task_id IS NOT NULL/);
        assert.match(sql, /ORDER BY hs_task\.updated_at DESC,\s+hs_task\.id DESC/);
        assert.match(sql, /ORDER BY hs_thread\.updated_at DESC,\s+hs_thread\.id DESC/);
        assert.match(sql, /hs\.connector_id IS NULL OR hs\.connector_id = \?/);
        assert.match(sql, /codex_app_server_exec/);
        assert.match(sql, /c\.capabilities_json LIKE/);
        return {
          bind(
            now: string,
            targetConnectorId: string,
            hostSessionConnectorId: string,
            executableConnectorId: string
          ) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(targetConnectorId, "connector-online");
            assert.equal(hostSessionConnectorId, "connector-online");
            assert.equal(executableConnectorId, "connector-online");
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
                      prompt: "Summarise this thread",
                      state: "pending",
                      target_connector_id: "connector-online",
                      created_at: "2026-06-13T10:00:00.000Z",
                      updated_at: "2026-06-13T10:00:00.000Z",
                      target_host_session_id: "session-tree-1",
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
            leaseTargetHostSessionId: string | null,
            updatedAt: string,
            commandId: string,
            now: string
          ) {
            assert.equal(connectorId, "connector-online");
            assert.match(leaseUntil, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(leaseTargetHostSessionId, "session-tree-1");
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            return {
              async run() {
                counters.commandLeaseUpdates += 1;
                return { meta: { changes: 1 } };
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
                return { active_count: 1 };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /active_command_count/.test(sql)) {
        return {
          bind(activeCount: number, updatedAt: string, connectorId: string) {
            assert.equal(activeCount, 1);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.connectorActivityUpdates += 1;
                return { success: true };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get commandLeaseUpdates() {
      return counters.commandLeaseUpdates;
    },
    get connectorActivityUpdates() {
      return counters.connectorActivityUpdates;
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
    app_server_present: number;
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
        app_server_present: 0,
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
    },
    appServerPresentOf(sessionId: string) {
      return sessions.get(sessionId)?.app_server_present;
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
            appServerPresent: number,
            cwd: string | null,
            discoveredAt: string,
            updatedAt: string
          ) {
            assert.equal(connectorId, "connector-online");
            assert.equal(hostname, "mac-studio.local");
            assert.equal(workspaceId, selectedWorkspaceId);
            assert.ok(appServerPresent === 0 || appServerPresent === 1);
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
                  app_server_present: existing?.app_server_present || appServerPresent,
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
    },
    appServerPresentOf(sessionId: string) {
      return counters.appServerPresentOf(sessionId);
    }
  };

  return db as D1Database & typeof counters;
}

function hostSessionBackfillDb(
  options: { ignoreInserts?: boolean | undefined } = {}
): D1Database & { readonly eventInserts: number; readonly sequenceUpdates: number } {
  const inserted = new Set<string>();
  const counters = {
    eventInserts: 0,
    sequenceUpdates: 0
  };
  const db = {
    prepare(sql: string) {
      if (/SELECT id, workspace_id, title, state, last_seq, updated_at, realtime_mode/.test(sql)) {
        return {
          bind(threadId: string) {
            assert.equal(threadId, "thread-1");
            return {
              async first() {
                return {
                  id: "thread-1",
                  workspace_id: "workspace-api",
                  title: "Session",
                  state: "idle",
                  last_seq: 0,
                  updated_at: "2026-06-12T10:00:00.000Z",
                  realtime_mode: "realtime"
                };
              }
            };
          }
        };
      }

      if (/SELECT id FROM events WHERE id = \? LIMIT 1/.test(sql)) {
        return {
          bind(eventId: string) {
            return {
              async first() {
                return inserted.has(eventId) ? { id: eventId } : null;
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
                counters.sequenceUpdates += 1;
                return { last_seq: counters.sequenceUpdates };
              }
            };
          }
        };
      }

      if (/INSERT OR IGNORE INTO events/.test(sql)) {
        return {
          bind(
            eventId: string,
            workspaceId: string,
            threadId: string,
            seq: number,
            kind: string,
            priority: string,
            summary: string,
            idempotencyKey: string,
            createdAt: string
          ) {
            assert.match(eventId, /^event-backfill-session-1-/);
            assert.equal(workspaceId, "workspace-api");
            assert.equal(threadId, "thread-1");
            assert.equal(seq, 1);
            assert.equal(kind, "command.output");
            assert.equal(priority, "P3");
            assert.equal(summary, "2026-06-12 10:00 - User: Inspect failure");
            assert.equal(idempotencyKey, "rollout:session-1:1");
            assert.equal(createdAt, "2026-06-12T10:00:00.000Z");
            return {
              async run() {
                if (options.ignoreInserts) {
                  return { success: true, meta: { changes: 0 } };
                }
                inserted.add(eventId);
                counters.eventInserts += 1;
                return { success: true, meta: { changes: 1 } };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get eventInserts() {
      return counters.eventInserts;
    },
    get sequenceUpdates() {
      return counters.sequenceUpdates;
    }
  };

  return db as D1Database & { readonly eventInserts: number; readonly sequenceUpdates: number };
}

function threadEventsDb(): D1Database {
  return {
    prepare(sql: string) {
      if (/SELECT id, workspace_id, title, state, last_seq, updated_at, realtime_mode/.test(sql)) {
        return {
          bind(threadId: string) {
            assert.equal(threadId, "thread-1");
            return {
              async first() {
                return {
                  id: "thread-1",
                  workspace_id: "workspace-api",
                  title: "Attached history",
                  state: "idle",
                  last_seq: 2,
                  updated_at: "2026-06-13T10:00:00.000Z",
                  realtime_mode: "realtime"
                };
              }
            };
          }
        };
      }

      if (/FROM events/.test(sql) && /WHERE thread_id = \?/.test(sql) && /ORDER BY seq DESC/.test(sql)) {
        return {
          bind(threadId: string, limit: number) {
            assert.equal(threadId, "thread-1");
            assert.equal(limit, 100);
            return {
              async all() {
                return {
                  results: [
                    {
                      id: "event-backfill-old-2",
                      thread_id: "thread-1",
                      command_id: null,
                      seq: 2,
                      kind: "command.output",
                      priority: "P3",
                      summary: "Old backfill event 2",
                      created_at: "2026-06-12T10:01:00.000Z"
                    },
                    {
                      id: "event-backfill-old-1",
                      thread_id: "thread-1",
                      command_id: null,
                      seq: 1,
                      kind: "command.output",
                      priority: "P3",
                      summary: "Old backfill event 1",
                      created_at: "2026-06-12T10:00:00.000Z"
                    }
                  ]
                };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    }
  } as unknown as D1Database;
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
