import assert from "node:assert/strict";
import test from "node:test";
import type { BootstrapPayload, HostSessionSummary, TaskArchiveResponse } from "@chaop/protocol";
import {
  archiveSyncNotice,
  archiveSyncWarning,
  codexCliFallbackAvailable,
  commandExecutionModeForRequest,
  commandModeLabel,
  commandTypeForMode,
  historyBackfillNotice,
  localThreadConnectorId,
  localThreadConnectors,
  localThreadWorkspaceId,
  MANAGED_APP_SERVER_UNAVAILABLE,
  managedAppServerCommandAvailable,
  mergeBootstrapPayload,
  normaliseCommandMode
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

test("command mode labels keep UI modes separate from protocol types", () => {
  assert.equal(commandModeLabel("placeholder"), "Placeholder");
  assert.equal(commandModeLabel("app_server"), "App-server");
  assert.equal(commandModeLabel("codex_cli_fallback"), "CLI fallback");
  assert.equal(commandTypeForMode("placeholder"), "placeholder");
  assert.equal(commandTypeForMode("app_server"), "codex");
  assert.equal(commandTypeForMode("codex_cli_fallback"), "codex");
  assert.equal(commandExecutionModeForRequest("placeholder"), undefined);
  assert.equal(commandExecutionModeForRequest("app_server"), "app_server");
  assert.equal(commandExecutionModeForRequest("codex_cli_fallback"), "codex_cli_fallback");
  assert.equal(MANAGED_APP_SERVER_UNAVAILABLE, "No managed app-server connector is online.");
});

test("managedAppServerCommandAvailable requires an attached app-server session and capable connector", () => {
  const attachedSession = {
    ...hostSession("session-app-server"),
    connector_id: "connector-a",
    attached_thread_id: "thread-api",
    app_server_present: true
  };
  const data = payload({
    connectors: [connector("connector-a", ["codex_app_server_exec"])],
    threads: [thread("thread-api", "workspace-api")],
    host_sessions: [attachedSession]
  });

  assert.equal(managedAppServerCommandAvailable(data, "thread-api"), true);
  assert.equal(
    managedAppServerCommandAvailable(
      {
        ...data,
        connectors: [connector("connector-a", ["codex_exec"])]
      },
      "thread-api"
    ),
    false
  );
  assert.equal(
    managedAppServerCommandAvailable(
      {
        ...data,
        host_sessions: [{ ...attachedSession, app_server_present: false }]
      },
      "thread-api"
    ),
    false
  );
});

test("codexCliFallbackAvailable is scoped to online workspace connectors", () => {
  const data = payload({
    connectors: [
      connector("connector-a", ["codex_exec"]),
      connector("connector-b", ["codex_exec"], "offline")
    ],
    workspaces: [
      workspace("workspace-api", ["connector-a"]),
      workspace("workspace-docs", ["connector-b"])
    ]
  });

  assert.equal(codexCliFallbackAvailable(data, "workspace-api"), true);
  assert.equal(codexCliFallbackAvailable(data, "workspace-docs"), false);
  assert.equal(codexCliFallbackAvailable(data, "missing-workspace"), false);
});

test("normaliseCommandMode drops unavailable app-server and hidden CLI fallback modes", () => {
  const data = payload({
    connectors: [connector("connector-a", ["codex_exec"])],
    workspaces: [workspace("workspace-api", ["connector-a"])],
    threads: [thread("thread-api", "workspace-api")]
  });

  assert.equal(normaliseCommandMode("app_server", data, "thread-api", { showCliFallback: true }), "placeholder");
  assert.equal(
    normaliseCommandMode("codex_cli_fallback", data, "thread-api", { showCliFallback: false }),
    "placeholder"
  );
  assert.equal(
    normaliseCommandMode("codex_cli_fallback", data, "thread-api", { showCliFallback: true }),
    "codex_cli_fallback"
  );
});

test("historyBackfillNotice summarises imported history", () => {
  assert.equal(
    historyBackfillNotice({
      attempted: true,
      imported_event_count: 2
    }),
    "Attached. Imported 2 history events."
  );
});

test("historyBackfillNotice calls out truncated backfill", () => {
  assert.equal(
    historyBackfillNotice({
      attempted: true,
      imported_event_count: 30,
      truncated: true
    }),
    "Attached. Imported 30 history events; older history was truncated."
  );
});

test("historyBackfillNotice handles empty and failed backfills", () => {
  assert.equal(
    historyBackfillNotice({
      attempted: true,
      imported_event_count: 0
    }),
    "Attached. History backfill found no importable events."
  );
  assert.equal(
    historyBackfillNotice({
      attempted: false,
      imported_event_count: 0
    }),
    undefined
  );
  assert.equal(
    historyBackfillNotice({
      attempted: true,
      imported_event_count: 0,
      error: "Connector timed out"
    }),
    undefined
  );
  assert.equal(historyBackfillNotice(undefined), undefined);
});

test("archiveSyncNotice summarises successful app-server sync", () => {
  assert.equal(
    archiveSyncNotice(
      "Archive",
      archiveResponse({
        attempted: true,
        connector_id: "connector-1",
        session_id: "session-1",
        archived: true
      })
    ),
    "Archive completed. App-server sync completed."
  );
});

test("archiveSyncNotice stays quiet for D1-only or failed sync paths", () => {
  assert.equal(archiveSyncNotice("Archive", archiveResponse()), undefined);
  assert.equal(
    archiveSyncNotice(
      "Archive",
      archiveResponse({
        attempted: false,
        connector_id: "connector-1",
        session_id: "session-1",
        archived: true
      })
    ),
    undefined
  );
  assert.equal(
    archiveSyncNotice(
      "Unarchive",
      archiveResponse({
        attempted: true,
        connector_id: "connector-1",
        session_id: "session-1",
        archived: false,
        error: "Connector is offline"
      })
    ),
    undefined
  );
});

test("archiveSyncWarning reports app-server sync failures", () => {
  assert.equal(
    archiveSyncWarning(
      "Unarchive",
      archiveResponse({
        attempted: true,
        connector_id: "connector-1",
        session_id: "session-1",
        archived: false,
        error: "Connector is offline"
      })
    ),
    "Unarchive completed, but app-server sync did not: Connector is offline"
  );
  assert.equal(
    archiveSyncWarning(
      "Archive",
      archiveResponse({
        attempted: true,
        connector_id: "connector-1",
        session_id: "session-1",
        archived: true
      })
    ),
    undefined
  );
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

function archiveResponse(archive_sync?: TaskArchiveResponse["archive_sync"]): TaskArchiveResponse {
  return {
    task: {
      id: "task-1",
      workspace_id: "workspace-api",
      thread_id: "thread-1",
      title: "Task",
      category_id: "category-1",
      state: "idle",
      realtime_mode: "realtime",
      budget_state: "normal",
      updated_at: "2026-06-12T10:00:00.000Z"
    },
    archive_sync
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
