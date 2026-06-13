import assert from "node:assert/strict";
import test from "node:test";
import type { BootstrapPayload, HostSessionSummary } from "@chaop/protocol";
import {
  localThreadConnectorId,
  localThreadConnectors,
  localThreadWorkspaceId,
  mergeBootstrapPayload
} from "./state.ts";

test("mergeBootstrapPayload keeps current host sessions after newer server sync", () => {
  const currentSession = hostSession("session-old");
  const current = payload({
    host_sessions: [currentSession],
    host_session_syncs: [sync("connector-1", "2026-06-12T10:00:00.000Z", 1, 1)]
  });
  const incoming = payload({
    host_sessions: [],
    host_session_syncs: [sync("connector-1", "2026-06-12T10:01:00.000Z", 0, 0)]
  });

  const merged = mergeBootstrapPayload(current, incoming);

  assert.deepEqual(merged.host_sessions, [currentSession]);
});

test("mergeBootstrapPayload keeps realtime host sessions newer than bootstrap sync", () => {
  const currentSession = hostSession("session-new");
  const current = payload({
    host_sessions: [currentSession],
    host_session_syncs: [sync("connector-1", "2026-06-12T10:02:00.000Z", 1, 1)]
  });
  const incoming = payload({
    host_sessions: [],
    host_session_syncs: [sync("connector-1", "2026-06-12T10:01:00.000Z", 0, 0)]
  });

  const merged = mergeBootstrapPayload(current, incoming);

  assert.deepEqual(merged.host_sessions, [currentSession]);
});

test("localThreadWorkspaceId uses the selected thread workspace", () => {
  const data = payload({
    workspaces: [
      workspace("workspace-api"),
      workspace("workspace-docs")
    ],
    threads: [
      thread("thread-api", "workspace-api"),
      thread("thread-docs", "workspace-docs")
    ]
  });

  assert.equal(localThreadWorkspaceId(data, "thread-docs"), "workspace-docs");
});

test("localThreadWorkspaceId falls back to the first workspace", () => {
  const data = payload({
    workspaces: [
      workspace("workspace-api"),
      workspace("workspace-docs")
    ],
    threads: [thread("thread-docs", "workspace-docs")]
  });

  assert.equal(localThreadWorkspaceId(data, "missing-thread"), "workspace-api");
});

test("localThreadConnectors filters connectors by workspace", () => {
  const data = payload({
    connectors: [
      connector("connector-a", ["app_server_threads"]),
      connector("connector-b", ["app_server_threads"])
    ],
    workspaces: [
      workspace("workspace-api", ["connector-a"]),
      workspace("workspace-docs", ["connector-b"])
    ]
  });

  assert.deepEqual(
    localThreadConnectors(data, "workspace-docs").map((item) => item.id),
    ["connector-b"]
  );
});

test("localThreadConnectors only includes app-server capable connectors", () => {
  const data = payload({
    connectors: [
      connector("connector-a", ["placeholder_commands"]),
      connector("connector-b", ["app_server_threads"])
    ],
    workspaces: [
      workspace("workspace-api", ["connector-a", "connector-b"])
    ]
  });

  assert.deepEqual(
    localThreadConnectors(data, "workspace-api").map((item) => item.id),
    ["connector-b"]
  );
});

test("localThreadConnectors skips offline app-server connectors", () => {
  const data = payload({
    connectors: [
      connector("connector-a", ["app_server_threads"], "offline"),
      connector("connector-b", ["app_server_threads"], "degraded")
    ],
    workspaces: [
      workspace("workspace-api", ["connector-a", "connector-b"])
    ]
  });

  assert.deepEqual(
    localThreadConnectors(data, "workspace-api").map((item) => item.id),
    ["connector-b"]
  );
});

test("localThreadConnectorId drops stale connector selections", () => {
  const data = payload({
    connectors: [
      connector("connector-a", ["app_server_threads"]),
      connector("connector-b", ["app_server_threads"])
    ],
    workspaces: [
      workspace("workspace-api", ["connector-a"]),
      workspace("workspace-docs", ["connector-b"])
    ]
  });

  assert.equal(localThreadConnectorId(data, "workspace-docs", "connector-a"), undefined);
  assert.equal(localThreadConnectorId(data, "workspace-docs", "connector-b"), "connector-b");
});

function payload(overrides: Partial<BootstrapPayload> = {}): BootstrapPayload {
  return {
    user: {
      id: "user-1",
      email: "operator@example.com",
      name: "operator"
    },
    connectors: [],
    workspaces: [],
    threads: [],
    tasks: [],
    host_sessions: [],
    host_session_syncs: [],
    task_categories: [],
    running_commands: [],
    events: [],
    budget: {
      state: "normal",
      daily_used_pct: 0,
      four_hour_used_pct: 0,
      burst_used_pct: 0,
      delayed_event_count: 0,
      compacted_event_count: 0,
      local_spool_bytes: 0
    },
    server_time: "2026-06-12T10:00:00.000Z",
    ...overrides
  };
}

function connector(
  id: string,
  capabilities: string[] = [],
  status: "online" | "offline" | "degraded" = "online"
) {
  return {
    id,
    name: id,
    hostname: `${id}.local`,
    status,
    capabilities,
    logical_agent_count: 1,
    active_command_count: 0,
    realtime_mode: "realtime" as const,
    budget_state: "normal" as const
  };
}

function workspace(id: string, connectorIds: string[] = []) {
  return {
    id,
    name: id,
    connector_ids: connectorIds,
    active_thread_count: 0
  };
}

function thread(id: string, workspaceId: string) {
  return {
    id,
    workspace_id: workspaceId,
    title: id,
    state: "active" as const,
    last_seq: 0,
    updated_at: "2026-06-12T10:00:00.000Z",
    realtime_mode: "realtime" as const
  };
}

function hostSession(sessionId: string): HostSessionSummary {
  return {
    id: `host-session-${sessionId}`,
    connector_id: "connector-1",
    hostname: "mac-studio.local",
    workspace_id: "workspace-api",
    session_id: sessionId,
    title: "Session",
    title_source: "metadata",
    cwd: "/Users/you/Program/project",
    updated_at: "2026-06-12T10:00:00.000Z"
  };
}

function sync(
  connectorId: string,
  syncedAt: string,
  reportedSessionCount: number,
  storedSessionCount: number
) {
  return {
    connector_id: connectorId,
    synced_at: syncedAt,
    reported_session_count: reportedSessionCount,
    stored_session_count: storedSessionCount
  };
}
