import assert from "node:assert/strict";
import test from "node:test";
import type { BootstrapPayload, HostSessionSummary } from "@chaop/protocol";
import { localThreadWorkspaceId, mergeBootstrapPayload } from "./state.ts";

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

function workspace(id: string) {
  return {
    id,
    name: id,
    connector_ids: [],
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
