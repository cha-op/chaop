import assert from "node:assert/strict";
import test from "node:test";
import type {
  AppServerInstanceSummary,
  BootstrapPayload,
  HostSessionSummary,
  TaskArchiveResponse
} from "@chaop/protocol";
import {
  appServerInstanceStateLabel,
  appServerInstancesForConnector,
  appServerInstancesForDisplay,
  archiveSyncNotice,
  archiveSyncWarning,
  codexCliFallbackAvailable,
  commandExecutionModeForRequest,
  commandModeLabel,
  commandTypeForMode,
  defaultCommandMode,
  historyBackfillNotice,
  localThreadConnectorId,
  localThreadConnectors,
  localThreadWorkspaceId,
  MANAGED_APP_SERVER_UNAVAILABLE,
  managedAppServerCommandAvailable,
  mergeBootstrapPayload,
  mergeAppServerInstances,
  mergeConnectorSummaries,
  normaliseCommandMode,
  primaryAppServerInstanceForConnector
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

test("mergeBootstrapPayload keeps newer app-server instance state over stale bootstrap", () => {
  const currentInstance = appServerInstance("app-server-1", "degraded", "2026-06-12T10:02:00.000Z");
  const incomingInstance = appServerInstance("app-server-1", "healthy", "2026-06-12T10:01:00.000Z");
  const current = payload({ app_server_instances: [currentInstance] });
  const incoming = payload({ app_server_instances: [incomingInstance] });

  const merged = mergeBootstrapPayload(current, incoming);

  assert.deepEqual(merged.app_server_instances, [currentInstance]);
});

test("mergeBootstrapPayload removes app-server instances omitted from bootstrap snapshot", () => {
  const current = payload({
    app_server_instances: [
      appServerInstance("app-server-a", "healthy", "2026-06-12T10:02:00.000Z"),
      appServerInstance("app-server-b", "stopped", "2026-06-12T10:02:00.000Z")
    ]
  });
  const incoming = payload({
    app_server_instances: [
      appServerInstance("app-server-a", "healthy", "2026-06-12T10:01:00.000Z")
    ]
  });

  const merged = mergeBootstrapPayload(current, incoming);

  assert.deepEqual(merged.app_server_instances, [current.app_server_instances[0]]);
});

test("mergeBootstrapPayload normalises legacy bootstrap without app-server instances", () => {
  const incoming = payload();
  delete (incoming as Partial<BootstrapPayload>).app_server_instances;

  const merged = mergeBootstrapPayload(undefined, incoming);

  assert.deepEqual(merged.app_server_instances, []);
});

test("mergeBootstrapPayload keeps current app-server instances when legacy bootstrap omits the field", () => {
  const currentInstance = appServerInstance("app-server-1", "healthy", "2026-06-12T10:02:00.000Z");
  const current = payload({ app_server_instances: [currentInstance] });
  const incoming = payload();
  delete (incoming as Partial<BootstrapPayload>).app_server_instances;

  const merged = mergeBootstrapPayload(current, incoming);

  assert.deepEqual(merged.app_server_instances, [currentInstance]);
});

test("mergeAppServerInstances applies connector snapshots without dropping incoming rows", () => {
  const retained = appServerInstance("app-server-retained", "healthy", "2026-06-12T10:00:00.000Z", "connector-2");
  const replaced = appServerInstance("app-server-old", "healthy", "2026-06-12T10:00:00.000Z", "connector-1");
  const incoming = appServerInstance("app-server-new", "degraded", "2026-06-12T10:01:00.000Z", "connector-1");

  const merged = mergeAppServerInstances([retained, replaced], [incoming], { snapshotConnectorId: "connector-1" });

  assert.deepEqual(merged, [retained, incoming]);
});

test("mergeAppServerInstances keeps newer rows from stale connector snapshots", () => {
  const retained = appServerInstance("app-server-retained", "healthy", "2026-06-12T10:00:00.000Z", "connector-2");
  const current = appServerInstance("app-server-current", "degraded", "2026-06-12T10:02:00.000Z", "connector-1");
  const omitted = appServerInstance("app-server-omitted", "healthy", "2026-06-12T10:02:00.000Z", "connector-1");
  const staleIncoming = appServerInstance("app-server-current", "healthy", "2026-06-12T10:01:00.000Z", "connector-1");

  const merged = mergeAppServerInstances([retained, current, omitted], [staleIncoming], { snapshotConnectorId: "connector-1" });

  assert.deepEqual(merged, [retained, current]);
});

test("appServerInstancesForConnector filters and sorts operator-visible instance state", () => {
  const healthyBusy = {
    ...appServerInstance("app-server-healthy-busy", "healthy", "2026-06-12T10:03:00.000Z", "connector-1"),
    active_turn_count: 3
  };
  const degraded = appServerInstance("app-server-degraded", "degraded", "2026-06-12T10:01:00.000Z", "connector-1");
  const healthyIdle = appServerInstance("app-server-healthy-idle", "healthy", "2026-06-12T10:04:00.000Z", "connector-1");
  const otherConnector = appServerInstance("app-server-other", "stopped", "2026-06-12T10:05:00.000Z", "connector-2");
  const laterConnectorDegraded = appServerInstance(
    "app-server-later-connector-degraded",
    "degraded",
    "2026-06-12T10:06:00.000Z",
    "connector-3"
  );
  const data = payload({
    app_server_instances: [healthyIdle, otherConnector, healthyBusy, degraded, laterConnectorDegraded]
  });

  const instances = appServerInstancesForConnector(data, "connector-1");

  assert.deepEqual(
    instances.map((instance) => instance.id),
    ["app-server-degraded", "app-server-healthy-busy", "app-server-healthy-idle"]
  );
  assert.equal(primaryAppServerInstanceForConnector(data, "connector-1"), degraded);
  assert.equal(primaryAppServerInstanceForConnector(data, "missing-connector"), undefined);
  assert.deepEqual(
    appServerInstancesForDisplay(data).map((instance) => instance.id),
    [
      "app-server-later-connector-degraded",
      "app-server-degraded",
      "app-server-other",
      "app-server-healthy-busy",
      "app-server-healthy-idle"
    ]
  );
});

test("appServerInstanceStateLabel uses operator-facing state text", () => {
  assert.equal(appServerInstanceStateLabel("healthy"), "healthy");
  assert.equal(appServerInstanceStateLabel("restarting"), "restarting");
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

test("mergeConnectorSummaries replaces known connectors and keeps existing order", () => {
  const merged = mergeConnectorSummaries(
    [
      connector("connector-a", ["placeholder_commands"]),
      connector("connector-b", ["app_server_threads"])
    ],
    [
      connector("connector-a", ["codex_app_server_exec"]),
      connector("connector-c", ["app_server_threads"])
    ]
  );

  assert.deepEqual(
    merged.map((item) => [item.id, item.capabilities]),
    [
      ["connector-a", ["codex_app_server_exec"]],
      ["connector-b", ["app_server_threads"]],
      ["connector-c", ["app_server_threads"]]
    ]
  );
});

test("mergeBootstrapPayload keeps newer realtime connector state over stale bootstrap", () => {
  const current = payload({
    connectors: [
      connector(
        "connector-a",
        [],
        "offline",
        "2026-06-12T10:01:00.000Z"
      )
    ]
  });
  const incoming = payload({
    connectors: [
      connector(
        "connector-a",
        ["codex_app_server_exec"],
        "online",
        "2026-06-12T10:00:00.000Z"
      )
    ]
  });

  const merged = mergeBootstrapPayload(current, incoming);

  assert.equal(merged.connectors[0]?.status, "offline");
  assert.deepEqual(merged.connectors[0]?.capabilities, []);
});

test("mergeBootstrapPayload removes connectors omitted from bootstrap snapshot", () => {
  const current = payload({
    connectors: [
      connector("connector-a", ["codex_app_server_exec"], "online"),
      connector("connector-b", ["app_server_threads"], "online")
    ]
  });
  const incoming = payload({
    connectors: [
      connector("connector-a", ["codex_app_server_exec"], "online")
    ]
  });

  const merged = mergeBootstrapPayload(current, incoming);

  assert.deepEqual(merged.connectors.map((item) => item.id), ["connector-a"]);
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

test("localThreadConnectors skips unavailable app-server connectors", () => {
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
    []
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
        connectors: [connector("connector-a", ["codex_app_server_exec"], "degraded")]
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

test("defaultCommandMode prefers managed app-server when it is available", () => {
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

  assert.equal(defaultCommandMode(data, "thread-api"), "app_server");
  assert.equal(defaultCommandMode(data, "missing-thread"), "placeholder");
  assert.equal(defaultCommandMode(undefined, "thread-api"), "placeholder");
});

test("codexCliFallbackAvailable is scoped to online workspace connectors", () => {
  const data = payload({
    connectors: [
      connector("connector-a", ["codex_exec"]),
      connector("connector-b", ["codex_exec"], "offline"),
      connector("connector-c", ["codex_exec"], "degraded")
    ],
    workspaces: [
      workspace("workspace-api", ["connector-a"]),
      workspace("workspace-docs", ["connector-b"]),
      workspace("workspace-ops", ["connector-c"])
    ]
  });

  assert.equal(codexCliFallbackAvailable(data, "workspace-api"), true);
  assert.equal(codexCliFallbackAvailable(data, "workspace-docs"), false);
  assert.equal(codexCliFallbackAvailable(data, "workspace-ops"), false);
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

test("normaliseCommandMode promotes placeholder only for implicit managed app-server defaults", () => {
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

  assert.equal(
    normaliseCommandMode("placeholder", data, "thread-api", {
      showCliFallback: false,
      preferManagedAppServer: true
    }),
    "app_server"
  );
  assert.equal(
    normaliseCommandMode("placeholder", data, "thread-api", {
      showCliFallback: false,
      preferManagedAppServer: false
    }),
    "placeholder"
  );
  assert.equal(
    normaliseCommandMode("codex_cli_fallback", data, "thread-api", {
      showCliFallback: false,
      preferManagedAppServer: true
    }),
    "app_server"
  );
  assert.equal(
    normaliseCommandMode("codex_cli_fallback", data, "thread-api", {
      showCliFallback: true,
      preferManagedAppServer: true
    }),
    "app_server"
  );
  assert.equal(
    normaliseCommandMode(
      "codex_cli_fallback",
      payload({
        connectors: [connector("connector-a", ["codex_exec"])],
        workspaces: [workspace("workspace-api", ["connector-a"])],
        threads: [thread("thread-api", "workspace-api")]
      }),
      "thread-api",
      {
        showCliFallback: true,
        preferManagedAppServer: true
      }
    ),
    "placeholder"
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
    app_server_instances: [],
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

function appServerInstance(
  id: string,
  state: AppServerInstanceSummary["state"],
  updatedAt: string,
  connectorId = "connector-1"
): AppServerInstanceSummary {
  return {
    id,
    connector_id: connectorId,
    instance_key: "default",
    scope: "connector",
    endpoint_type: "managed",
    state,
    active_turn_count: 0,
    generation: 1,
    last_seen_at: updatedAt,
    state_changed_at: updatedAt,
    updated_at: updatedAt
  };
}

function connector(
  id: string,
  capabilities: string[] = [],
  status: "online" | "offline" | "degraded" = "online",
  updatedAt?: string
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
    budget_state: "normal" as const,
    updated_at: updatedAt
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
