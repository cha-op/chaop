import assert from "node:assert/strict";
import test from "node:test";
import type {
  AppServerInstanceSummary,
  BootstrapPayload,
  CommandSummary,
  HostSessionSummary,
  TaskArchiveResponse,
  ThreadEvent
} from "@chaop/protocol";
import {
  appServerInstanceForHostSession,
  appServerInstancePlacementLabel,
  appServerInstanceStateLabel,
  appServerInstancesForConnector,
  appServerInstancesForDisplay,
  archiveSyncNotice,
  archiveSyncWarning,
  budgetPctLabel,
  budgetSourceLabel,
  codexCliFallbackAvailable,
  commandExecutionModeForRequest,
  commandModeLabel,
  commandTypeForMode,
  defaultCommandMode,
  dogfoodReadinessPreflight,
  historyBackfillNotice,
  localThreadConnectorId,
  localThreadConnectors,
  localThreadWorkspaceId,
  MANAGED_APP_SERVER_UNAVAILABLE,
  managedAppServerCommandAvailable,
  mergeBootstrapPayload,
  mergeAppServerInstances,
  mergeConnectorSummaries,
  mergeHostSessions,
  normaliseCommandMode,
  primaryAppServerInstanceForConnector,
  safetyActionBlocked,
  safetyActionReason,
  threadTurnsForDisplay,
  TURN_INTERACTION_OTHER_SELECT_VALUE,
  turnInteractionAnswerForSelectValue,
  turnInteractionOptionSelectValue,
  turnInteractionQuestionSelectValue,
  type PendingTurnInteractionQuestion
} from "./state.ts";

test("turn interaction select helpers keep answer values separate from UI sentinel values", () => {
  const sentinelAnswer = "__chaop_other__";
  const question: PendingTurnInteractionQuestion = {
    id: "question-1",
    header: "Mode",
    question: "Choose a mode",
    is_other: true,
    is_secret: false,
    options: [
      { label: "Normal", description: "Use normal mode" },
      { label: sentinelAnswer, description: "Use the literal sentinel text" }
    ]
  };

  assert.equal(
    turnInteractionQuestionSelectValue(question, sentinelAnswer, false),
    turnInteractionOptionSelectValue(1)
  );
  assert.deepEqual(turnInteractionAnswerForSelectValue(question, turnInteractionOptionSelectValue(1)), {
    answer: sentinelAnswer,
    otherSelected: false
  });
  assert.deepEqual(turnInteractionAnswerForSelectValue(question, TURN_INTERACTION_OTHER_SELECT_VALUE), {
    answer: "",
    otherSelected: true
  });
});

test("turn interaction select helpers ignore other sentinel when custom answers are not allowed", () => {
  const question: PendingTurnInteractionQuestion = {
    id: "question-1",
    header: "Mode",
    question: "Choose a mode",
    is_other: false,
    is_secret: false,
    options: [{ label: "Normal", description: "Use normal mode" }]
  };

  assert.deepEqual(turnInteractionAnswerForSelectValue(question, TURN_INTERACTION_OTHER_SELECT_VALUE), {
    answer: "",
    otherSelected: false
  });
  assert.equal(turnInteractionQuestionSelectValue(question, "Normal", true), turnInteractionOptionSelectValue(0));
});

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

test("mergeHostSessions keeps newer attached state over stale realtime inventory", () => {
  const attachedSession = hostSession("session-app-server", {
    app_server_present: true,
    attached_task_id: "task-api",
    attached_thread_id: "thread-api",
    updated_at: "2026-06-12T10:02:00.000Z"
  });
  const staleInventorySession = hostSession("session-app-server", {
    app_server_present: false,
    updated_at: "2026-06-12T10:01:00.000Z"
  });

  const merged = mergeHostSessions([staleInventorySession], [attachedSession], {
    snapshotConnectorId: "connector-1"
  });

  assert.deepEqual(merged, [attachedSession]);
});

test("mergeHostSessions removes omitted connector sessions from realtime snapshots", () => {
  const reportedSession = hostSession("session-reported", {
    updated_at: "2026-06-12T10:02:00.000Z"
  });
  const omittedSession = hostSession("session-omitted", {
    updated_at: "2026-06-12T10:02:00.000Z"
  });
  const otherConnectorSession = hostSession("session-other-connector", {
    connector_id: "connector-2",
    updated_at: "2026-06-12T10:02:00.000Z"
  });

  const merged = mergeHostSessions([reportedSession], [omittedSession, otherConnectorSession], {
    snapshotConnectorId: "connector-1"
  });

  assert.deepEqual(merged, [reportedSession, otherConnectorSession]);
});

test("mergeHostSessions preserves omitted connector sessions from non-snapshot updates", () => {
  const reportedSession = hostSession("session-reported", {
    updated_at: "2026-06-12T10:02:00.000Z"
  });
  const omittedSession = hostSession("session-omitted", {
    updated_at: "2026-06-12T10:02:00.000Z"
  });

  const merged = mergeHostSessions([reportedSession], [omittedSession]);

  assert.deepEqual(merged, [reportedSession, omittedSession]);
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

test("mergeBootstrapPayload normalises legacy bootstrap without safety", () => {
  const incoming = payload();
  delete (incoming as Partial<BootstrapPayload>).safety;

  const merged = mergeBootstrapPayload(undefined, incoming);

  assert.equal(merged.safety.state, "normal");
  assert.equal(merged.safety.paused, false);
  assert.equal(merged.safety.generated_at, incoming.server_time);
  assert.equal(merged.safety.actions.every((guard) => guard.state === "allowed"), true);
  assert.equal(safetyActionBlocked(merged, "command_create"), false);
});

test("mergeBootstrapPayload keeps current safety when legacy bootstrap omits the field", () => {
  const current = payload({
    safety: {
      ...safety(),
      state: "hard_limited",
      paused: true,
      paused_reason: "operator stop",
      summary: "Emergency pause active."
    }
  });
  const incoming = payload();
  delete (incoming as Partial<BootstrapPayload>).safety;

  const merged = mergeBootstrapPayload(current, incoming);

  assert.equal(merged.safety.state, "hard_limited");
  assert.equal(merged.safety.paused, true);
  assert.equal(merged.safety.paused_reason, "operator stop");
});

test("budgetSourceLabel reports unknown source for legacy budget payloads", () => {
  const budget = { ...payload().budget };
  delete (budget as Partial<typeof budget>).source;

  assert.equal(budgetSourceLabel(budget), "Summary source not reported by this control plane.");
});

test("budgetSourceLabel describes live sampled budget constraints", () => {
  const budget = {
    ...payload().budget,
    source: "d1_usage_windows" as const,
    window_sample_count: 2,
    constraint_sample_count: 3,
    constraints: Array.from({ length: 6 }, (_, index) => ({
      id: `constraint-${index}`,
      label: `Constraint ${index}`,
      detail: "Test constraint",
      window_type: "daily" as const,
      unit: "d1_row" as const,
      hard: true,
      sampled: index < 3,
      state: index < 3 ? "normal" as const : "missing" as const,
      source: index < 3 ? "d1_usage_windows" as const : "missing" as const,
      limit_units: 100,
      used_units: index < 3 ? 10 : null,
      used_pct: index < 3 ? 10 : null,
      remaining_units: index < 3 ? 90 : null,
      remaining_ratio: index < 3 ? 0.9 : null,
      per_event_units: index < 3 ? 10 : null,
      remaining_event_capacity: index < 3 ? 9 : null
    }))
  };

  assert.equal(
    budgetSourceLabel(budget),
    "Live database summary from 2 bounded usage windows and 3/6 sampled budget constraints."
  );
});

test("budgetSourceLabel describes Cloudflare analytics-only budget constraints", () => {
  const budget = {
    ...payload().budget,
    source: "cloudflare_analytics" as const,
    window_sample_count: 0,
    constraint_sample_count: 4,
    constraints: Array.from({ length: 6 }, (_, index) => ({
      id: `constraint-${index}`,
      label: `Constraint ${index}`,
      detail: "Test constraint",
      window_type: "daily" as const,
      unit: "worker_request" as const,
      hard: true,
      sampled: index < 4,
      state: index < 4 ? "normal" as const : "missing" as const,
      source: index < 4 ? "cloudflare_analytics" as const : "missing" as const,
      limit_units: 100,
      used_units: index < 4 ? 10 : null,
      used_pct: index < 4 ? 10 : null,
      remaining_units: index < 4 ? 90 : null,
      remaining_ratio: index < 4 ? 0.9 : null,
      per_event_units: null,
      remaining_event_capacity: null
    }))
  };

  assert.equal(
    budgetSourceLabel(budget),
    "Cloudflare analytics summary with 4/6 sampled budget constraints; no Chaop usage windows are open yet."
  );
});

test("budgetSourceLabel describes local model baselines", () => {
  const budget = {
    ...payload().budget,
    source: "cloudflare_analytics" as const,
    window_sample_count: 0,
    constraint_sample_count: 6,
    constraints: Array.from({ length: 6 }, (_, index) => ({
      id: `constraint-${index}`,
      label: `Constraint ${index}`,
      detail: "Test constraint",
      window_type: "daily" as const,
      unit: "d1_row" as const,
      hard: true,
      sampled: true,
      state: "normal" as const,
      source: index === 1 || index === 2 ? "schema_model" as const : "cloudflare_analytics" as const,
      limit_units: 100,
      used_units: index === 1 || index === 2 ? 0 : 10,
      used_pct: index === 1 || index === 2 ? 0 : 10,
      remaining_units: index === 1 || index === 2 ? 100 : 90,
      remaining_ratio: index === 1 || index === 2 ? 1 : 0.9,
      per_event_units: index === 1 || index === 2 ? 10 : null,
      remaining_event_capacity: index === 1 || index === 2 ? 10 : null
    }))
  };

  assert.equal(
    budgetSourceLabel(budget),
    "Cloudflare analytics summary with 6/6 sampled budget constraints, including 2 local model baselines; no Chaop usage windows are open yet."
  );
});

test("budgetPctLabel distinguishes missing samples from zero usage", () => {
  assert.equal(budgetPctLabel(null), "missing");
  assert.equal(budgetPctLabel(undefined), "missing");
  assert.equal(budgetPctLabel(0), "0%");
  assert.equal(budgetPctLabel(125.4), "125.4%");
});

test("safety helpers expose blocked action reasons only for guarded actions", () => {
  const baseSafety = safety();
  const data = payload({
    safety: {
      ...baseSafety,
      actions: baseSafety.actions.map((guard) =>
        guard.action === "host_session_refresh"
          ? {
            ...guard,
            state: "blocked",
            reason: "Refresh is paused while cost posture is conservative.",
            budget_state: "conservative"
          }
          : guard
      )
    }
  });

  assert.equal(safetyActionBlocked(data, "host_session_refresh"), true);
  assert.equal(safetyActionReason(data, "host_session_refresh"), "Refresh is paused while cost posture is conservative.");
  assert.equal(safetyActionBlocked(data, "command_create"), false);
  assert.equal(safetyActionReason(data, "command_create"), undefined);
});

test("dogfoodReadinessPreflight reports a ready managed path without refreshing inventory", () => {
  const data = payload({
    workspaces: [workspace("workspace-api", ["connector-a"])],
    connectors: [connector("connector-a", ["app_server_threads", "codex_app_server_exec"])],
    app_server_instances: [appServerInstance("app-server-a", "healthy", "2026-06-12T10:01:00.000Z", "connector-a")]
  });

  const readiness = dogfoodReadinessPreflight(data);

  assert.equal(readiness.state, "ready");
  assert.equal(readiness.next_action.href, "#thread-centre");
  assert.equal(readiness.checks.find((check) => check.id === "inventory")?.state, "ready");
  assert.match(
    readiness.checks.find((check) => check.id === "inventory")?.detail ?? "",
    /existing state only/
  );
});

test("dogfoodReadinessPreflight blocks on cost posture before connector state", () => {
  const baseSafety = safety();
  const data = payload({
    workspaces: [workspace("workspace-api", ["connector-a"])],
    connectors: [connector("connector-a", ["app_server_threads", "codex_app_server_exec"])],
    app_server_instances: [appServerInstance("app-server-a", "healthy", "2026-06-12T10:01:00.000Z", "connector-a")],
    safety: {
      ...baseSafety,
      state: "hard_limited",
      summary: "D1 rows written hard limit is active.",
      actions: baseSafety.actions.map((guard) =>
        guard.action === "command_create"
          ? {
            ...guard,
            state: "blocked",
            reason: "D1 rows written hard limit is active.",
            budget_state: "hard_limited"
          }
          : guard
      )
    }
  });

  const readiness = dogfoodReadinessPreflight(data);

  assert.equal(readiness.state, "blocked");
  assert.equal(readiness.next_action.href, "#budget-board");
  assert.equal(readiness.summary, "D1 rows written hard limit is active.");
});

test("dogfoodReadinessPreflight calls out split app-server connector capabilities", () => {
  const data = payload({
    workspaces: [workspace("workspace-api", ["connector-a", "connector-b"])],
    connectors: [
      connector("connector-a", ["app_server_threads"]),
      connector("connector-b", ["codex_app_server_exec"])
    ],
    app_server_instances: [appServerInstance("app-server-b", "healthy", "2026-06-12T10:01:00.000Z", "connector-b")]
  });

  const readiness = dogfoodReadinessPreflight(data);

  assert.equal(readiness.state, "blocked");
  assert.equal(readiness.next_action.href, "#host-sessions");
  assert.equal(readiness.checks.find((check) => check.id === "connector")?.state, "attention");
  assert.match(readiness.checks.find((check) => check.id === "connector")?.detail ?? "", /same connector/);
});

test("dogfoodReadinessPreflight distinguishes busy and missing app-server reports", () => {
  const busy = dogfoodReadinessPreflight(payload({
    workspaces: [workspace("workspace-api", ["connector-a"])],
    connectors: [connector("connector-a", ["app_server_threads", "codex_app_server_exec"])],
    app_server_instances: [
      {
        ...appServerInstance("app-server-a", "healthy", "2026-06-12T10:01:00.000Z", "connector-a"),
        active_turn_count: 2
      }
    ]
  }));
  const missing = dogfoodReadinessPreflight(payload({
    workspaces: [workspace("workspace-api", ["connector-a"])],
    connectors: [connector("connector-a", ["app_server_threads", "codex_app_server_exec"])]
  }));

  assert.equal(busy.state, "attention");
  assert.equal(busy.checks.find((check) => check.id === "app_server")?.detail, "1 healthy app-server instance with 2 active turns.");
  assert.equal(missing.state, "blocked");
  assert.equal(missing.checks.find((check) => check.id === "app_server")?.detail, "No healthy app-server instance is reported by a connector linked to workspace-api.");
});

test("dogfoodReadinessPreflight requires a workspace-linked managed connector", () => {
  const readiness = dogfoodReadinessPreflight(payload({
    connectors: [connector("connector-a", ["app_server_threads", "codex_app_server_exec"])],
    app_server_instances: [appServerInstance("app-server-a", "healthy", "2026-06-12T10:01:00.000Z", "connector-a")]
  }));

  assert.equal(readiness.state, "blocked");
  assert.equal(readiness.next_action.href, "#host-sessions");
  assert.equal(readiness.checks.find((check) => check.id === "connector")?.detail, "No online connector is linked to the target workspace for app-server dogfood.");
});

test("dogfoodReadinessPreflight does not borrow app-server health from an unrelated connector", () => {
  const readiness = dogfoodReadinessPreflight(payload({
    workspaces: [workspace("workspace-api", ["connector-a"])],
    connectors: [
      connector("connector-a", ["app_server_threads", "codex_app_server_exec"]),
      connector("connector-b", ["app_server_threads", "codex_app_server_exec"])
    ],
    app_server_instances: [appServerInstance("app-server-b", "healthy", "2026-06-12T10:01:00.000Z", "connector-b")]
  }));

  assert.equal(readiness.state, "blocked");
  assert.equal(readiness.checks.find((check) => check.id === "connector")?.state, "ready");
  assert.equal(readiness.checks.find((check) => check.id === "app_server")?.detail, "No healthy app-server instance is reported by a connector linked to workspace-api.");
});

test("dogfoodReadinessPreflight scopes readiness to the target workspace", () => {
  const data = payload({
    workspaces: [
      workspace("workspace-api", ["connector-a"]),
      workspace("workspace-docs", ["connector-b"])
    ],
    threads: [
      thread("thread-api", "workspace-api"),
      thread("thread-docs", "workspace-docs")
    ],
    connectors: [
      connector("connector-a", ["app_server_threads"]),
      connector("connector-b", ["app_server_threads", "codex_app_server_exec"])
    ],
    app_server_instances: [appServerInstance("app-server-b", "healthy", "2026-06-12T10:01:00.000Z", "connector-b")]
  });

  const defaultWorkspace = dogfoodReadinessPreflight(data);
  const selectedWorkspace = dogfoodReadinessPreflight(data, "thread-docs");

  assert.equal(defaultWorkspace.state, "blocked");
  assert.equal(defaultWorkspace.next_action.href, "#host-sessions");
  assert.equal(defaultWorkspace.checks.find((check) => check.id === "connector")?.state, "attention");
  assert.match(defaultWorkspace.checks.find((check) => check.id === "connector")?.detail ?? "", /workspace-api/);
  assert.equal(selectedWorkspace.state, "ready");
  assert.match(selectedWorkspace.checks.find((check) => check.id === "connector")?.detail ?? "", /workspace-docs/);
});

test("dogfoodReadinessPreflight requires thread-scoped app-server instances to match the target thread", () => {
  const data = payload({
    workspaces: [workspace("workspace-api", ["connector-a"])],
    threads: [
      thread("thread-api", "workspace-api"),
      thread("thread-docs", "workspace-api")
    ],
    connectors: [connector("connector-a", ["app_server_threads", "codex_app_server_exec"])],
    app_server_instances: [
      {
        ...appServerInstance("app-server-docs", "healthy", "2026-06-12T10:01:00.000Z", "connector-a"),
        scope: "thread",
        thread_id: "thread-docs"
      }
    ]
  });

  const unrelatedThread = dogfoodReadinessPreflight(data, "thread-api");
  const matchingThread = dogfoodReadinessPreflight(data, "thread-docs");

  assert.equal(unrelatedThread.state, "blocked");
  assert.equal(unrelatedThread.checks.find((check) => check.id === "connector")?.state, "ready");
  assert.equal(
    unrelatedThread.checks.find((check) => check.id === "app_server")?.detail,
    "No healthy app-server instance is reported by a connector linked to workspace-api."
  );
  assert.equal(matchingThread.state, "ready");
  assert.equal(matchingThread.checks.find((check) => check.id === "app_server")?.state, "ready");
});

test("dogfoodReadinessPreflight accepts externally managed listeners with app-server capabilities", () => {
  const externalInstance = {
    ...appServerInstance("app-server-a", "healthy", "2026-06-12T10:01:00.000Z", "connector-a"),
    endpoint_type: "external" as const
  };
  const readiness = dogfoodReadinessPreflight(payload({
    workspaces: [workspace("workspace-api", ["connector-a"])],
    connectors: [connector("connector-a", ["app_server_threads", "codex_app_server_exec"])],
    app_server_instances: [externalInstance]
  }));

  assert.equal(readiness.state, "ready");
  assert.equal(readiness.checks.find((check) => check.id === "app_server")?.state, "ready");
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

test("appServerInstancePlacementLabel shows connector, workspace, and thread placement", () => {
  assert.equal(appServerInstancePlacementLabel(appServerInstance("app-server-connector", "healthy", "2026-06-12T10:00:00.000Z")), "Connector-wide");
  assert.equal(
    appServerInstancePlacementLabel({
      ...appServerInstance("app-server-workspace", "healthy", "2026-06-12T10:00:00.000Z"),
      scope: "workspace",
      workspace_id: "workspace-api"
    }),
    "Workspace workspace-api"
  );
  assert.equal(
    appServerInstancePlacementLabel({
      ...appServerInstance("app-server-thread", "healthy", "2026-06-12T10:00:00.000Z"),
      scope: "thread",
      thread_id: "thread-123"
    }),
    "Thread thread-123"
  );
});

test("appServerInstanceForHostSession matches the session placement before connector fallback", () => {
  const connectorWide = appServerInstance("app-server-connector", "healthy", "2026-06-12T10:00:00.000Z", "connector-1");
  const unrelatedThread = {
    ...appServerInstance("app-server-other-thread", "degraded", "2026-06-12T10:05:00.000Z", "connector-1"),
    scope: "thread" as const,
    thread_id: "thread-other"
  };
  const workspaceMatch = {
    ...appServerInstance("app-server-workspace", "draining", "2026-06-12T10:04:00.000Z", "connector-1"),
    scope: "workspace" as const,
    workspace_id: "workspace-api"
  };
  const threadMatch = {
    ...appServerInstance("app-server-thread", "restarting", "2026-06-12T10:03:00.000Z", "connector-1"),
    scope: "thread" as const,
    thread_id: "thread-api"
  };
  const session = hostSession("session-api", {
    workspace_id: "workspace-api",
    attached_thread_id: "thread-api"
  });
  const data = payload({
    app_server_instances: [unrelatedThread, connectorWide, workspaceMatch, threadMatch]
  });

  assert.equal(appServerInstanceForHostSession(data, session), threadMatch);
});

test("appServerInstanceForHostSession falls back to matching workspace then connector-wide", () => {
  const connectorWide = appServerInstance("app-server-connector", "healthy", "2026-06-12T10:00:00.000Z", "connector-1");
  const workspaceMatch = {
    ...appServerInstance("app-server-workspace", "degraded", "2026-06-12T10:04:00.000Z", "connector-1"),
    scope: "workspace" as const,
    workspace_id: "workspace-api"
  };
  const otherWorkspace = {
    ...appServerInstance("app-server-other-workspace", "stopped", "2026-06-12T10:06:00.000Z", "connector-1"),
    scope: "workspace" as const,
    workspace_id: "workspace-docs"
  };
  const workspaceSession = hostSession("session-workspace", {
    workspace_id: "workspace-api"
  });
  const connectorSession = hostSession("session-connector", {
    workspace_id: "workspace-missing"
  });
  const data = payload({
    app_server_instances: [otherWorkspace, connectorWide, workspaceMatch]
  });

  assert.equal(appServerInstanceForHostSession(data, workspaceSession), workspaceMatch);
  assert.equal(appServerInstanceForHostSession(data, connectorSession), connectorWide);
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

test("threadTurnsForDisplay renders a completed assistant turn from command events", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [
      command("command-1", {
        prompt: "Summarise the failure.",
        state: "succeeded",
        updated_at: "2026-06-12T10:04:00.000Z"
      })
    ],
    [
      event("event-1", "command-1", 1, "command.accepted", "Control plane accepted the codex command."),
      event("event-2", "command-1", 2, "command.started", "Connector started Codex app-server turn."),
      event("event-3", "command-1", 3, "command.output", "Codex: The likely failure is a stale app-server lease."),
      event("event-4", "command-1", 4, "command.finished", "Codex app-server turn completed successfully.")
    ]
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "succeeded");
  assert.equal(turns[0]?.prompt, "Summarise the failure.");
  assert.equal(turns[0]?.assistant_summary, "The likely failure is a stale app-server lease.");
  assert.deepEqual(turns[0]?.progress_summaries, ["Connector started Codex app-server turn."]);
});

test("threadTurnsForDisplay keeps failed event-only turns diagnosable", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [],
    [
      event("event-1", "command-1", 1, "command.accepted", "Control plane accepted the codex command."),
      event("event-2", "command-1", 2, "command.failed", "Codex app-server turn could not start.")
    ]
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "failed");
  assert.equal(turns[0]?.prompt, undefined);
  assert.equal(turns[0]?.error_summary, "Codex app-server turn could not start.");
});

test("threadTurnsForDisplay keeps failure and partial assistant output on failed turns", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [
      command("command-1", {
        prompt: "Run the failing turn.",
        state: "failed",
        updated_at: "2026-06-12T10:04:00.000Z"
      })
    ],
    [
      event("event-1", "command-1", 1, "command.started", "Connector started Codex app-server turn."),
      event("event-2", "command-1", 2, "command.output", "Codex: I inspected the failing path."),
      event("event-3", "command-1", 3, "command.failed", "Codex app-server turn could not start.")
    ]
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "failed");
  assert.equal(turns[0]?.assistant_summary, "I inspected the failing path.");
  assert.equal(turns[0]?.error_summary, "Codex app-server turn could not start.");
});

test("threadTurnsForDisplay preserves terminal command state when the event tail is partial", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [
      command("command-1", {
        state: "succeeded",
        updated_at: "2026-06-12T10:05:00.000Z"
      })
    ],
    [
      event("event-1", "command-1", 1, "command.output", "Codex: Done.")
    ]
  );

  assert.equal(turns[0]?.status, "succeeded");
  assert.equal(turns[0]?.assistant_summary, "Done.");
});

test("threadTurnsForDisplay exposes pending approval interactions", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [command("command-1", { state: "running" })],
    [
      event("event-1", "command-1", 1, "command.started", "Connector started Codex app-server turn."),
      event("event-2", "command-1", 2, "approval.requested", "Approval requested.", {
        payload: {
          type: "turn_interaction",
          interaction_id: "interaction-1",
          status: "pending",
          method: "item/commandExecution/requestApproval",
          request_kind: "approval",
          subject: "command_execution",
          app_server_thread_id: "app-thread-1",
          app_server_turn_id: "app-turn-1",
          title: "Approve command execution",
          command: "touch requested.txt",
          cwd: "/tmp/project",
          network_approval_context: {
            host: "registry.npmjs.org",
            protocol: "https",
            port: 443
          },
          proposed_execpolicy_amendment: ["touch", "requested.txt"],
          available_decisions: [
            "decline",
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: ["touch", "requested.txt"]
              }
            },
            "cancel"
          ]
        }
      })
    ]
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "waiting");
  assert.equal(turns[0]?.pending_interactions.length, 1);
  assert.equal(turns[0]?.pending_interactions[0]?.payload.interaction_id, "interaction-1");
  assert.equal(turns[0]?.pending_interactions[0]?.payload.network_approval_context?.host, "registry.npmjs.org");
  assert.deepEqual(turns[0]?.pending_interactions[0]?.payload.available_decisions?.[1], {
    acceptWithExecpolicyAmendment: {
      execpolicy_amendment: ["touch", "requested.txt"]
    }
  });
});

test("threadTurnsForDisplay clears resolved interactions", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [command("command-1", { state: "running" })],
    [
      event("event-1", "command-1", 1, "command.started", "Connector started Codex app-server turn."),
      event("event-2", "command-1", 2, "input.requested", "Input requested.", {
        payload: {
          type: "turn_interaction",
          interaction_id: "interaction-1",
          status: "pending",
          method: "item/tool/requestUserInput",
          request_kind: "input",
          app_server_thread_id: "app-thread-1",
          app_server_turn_id: "app-turn-1",
          title: "Provide requested input",
          questions: [
            {
              id: "q1",
              header: "Confirm",
              question: "Continue?",
              is_other: false,
              is_secret: false
            }
          ]
        }
      }),
      event("event-3", "command-1", 3, "input.received", "Input provided.", {
        payload: {
          type: "turn_interaction_resolution",
          interaction_id: "interaction-1",
          status: "answered",
          answer_count: 1
        }
      })
    ]
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "running");
  assert.equal(turns[0]?.pending_interactions.length, 0);
});

test("threadTurnsForDisplay hides pending interactions after terminal events", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [command("command-1", { state: "failed" })],
    [
      event("event-1", "command-1", 1, "command.started", "Connector started Codex app-server turn."),
      event("event-2", "command-1", 2, "approval.requested", "Approval requested.", {
        payload: {
          type: "turn_interaction",
          interaction_id: "interaction-1",
          status: "pending",
          method: "item/commandExecution/requestApproval",
          request_kind: "approval",
          subject: "command_execution",
          app_server_thread_id: "app-thread-1",
          app_server_turn_id: "app-turn-1",
          title: "Approve command execution",
          command: "touch requested.txt",
          cwd: "/tmp/project",
          available_decisions: ["accept", "decline", "cancel"]
        }
      }),
      event("event-3", "command-1", 3, "command.failed", "Codex app-server turn failed.")
    ]
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "failed");
  assert.equal(turns[0]?.pending_interactions.length, 0);
});

test("threadTurnsForDisplay keeps terminal state after late interaction resolution", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [command("command-1", { state: "succeeded" })],
    [
      event("event-1", "command-1", 1, "command.started", "Connector started Codex app-server turn."),
      event("event-2", "command-1", 2, "command.finished", "Command finished."),
      event("event-3", "command-1", 3, "approval.resolved", "Approval accepted.", {
        payload: {
          type: "turn_interaction_resolution",
          interaction_id: "interaction-1",
          status: "accepted",
          decision: "accept"
        }
      })
    ]
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "succeeded");
});

test("threadTurnsForDisplay renders commandless backfilled history turns", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [],
    [
      event(
        "event-1",
        undefined,
        1,
        "command.output",
        "2026-06-12 10:00 - User: Inspect the app-server attach failure."
      ),
      event(
        "event-2",
        undefined,
        2,
        "command.output",
        "2026-06-12 10:01 - Assistant: The attach path is using the wrong thread lookup."
      )
    ]
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.command_id, "history-event-1");
  assert.equal(turns[0]?.status, "succeeded");
  assert.equal(turns[0]?.prompt, "Inspect the app-server attach failure.");
  assert.equal(turns[0]?.assistant_summary, "The attach path is using the wrong thread lookup.");
  assert.equal(turns[0]?.event_count, 2);
});

test("threadTurnsForDisplay parses backfilled history with unknown timestamps", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [],
    [
      event("event-1", undefined, 1, "command.output", "unknown time - User: Recover the old session.", {
        created_at: "1970-01-01T00:00:00.000Z"
      }),
      event("event-2", undefined, 2, "command.output", "unknown time - Assistant: I found the old transcript.", {
        created_at: "1970-01-01T00:00:00.000Z"
      })
    ]
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "succeeded");
  assert.equal(turns[0]?.prompt, "Recover the old session.");
  assert.equal(turns[0]?.assistant_summary, "I found the old transcript.");
  assert.equal(turns[0]?.updated_at, "unknown");
});

test("threadTurnsForDisplay marks user-only backfilled history as partial", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [],
    [
      event(
        "event-1",
        undefined,
        1,
        "command.output",
        "2026-06-12 10:00 - User: Inspect the app-server attach failure."
      )
    ]
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "partial");
  assert.equal(turns[0]?.prompt, "Inspect the app-server attach failure.");
  assert.equal(turns[0]?.assistant_summary, undefined);
});

test("threadTurnsForDisplay attaches commandless tool history to the previous turn", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [],
    [
      event(
        "event-1",
        undefined,
        1,
        "command.output",
        "2026-06-12 10:00 - User: Inspect the app-server attach failure."
      ),
      event(
        "event-2",
        undefined,
        2,
        "command.output",
        "2026-06-12 10:01 - Assistant: I will inspect the failing path."
      ),
      event(
        "event-3",
        undefined,
        3,
        "command.output",
        "2026-06-12 10:02 - Tool call: exec_command"
      )
    ]
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "succeeded");
  assert.equal(turns[0]?.assistant_summary, "I will inspect the failing path.");
  assert.deepEqual(turns[0]?.progress_summaries, ["2026-06-12 10:02 - Tool call: exec_command"]);
  assert.equal(turns[0]?.event_count, 3);
});

test("threadTurnsForDisplay leaves leading commandless tool history in raw events only", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [],
    [
      event(
        "event-1",
        undefined,
        1,
        "command.output",
        "2026-06-12 10:02 - Tool call: exec_command"
      )
    ]
  );

  assert.equal(turns.length, 0);
});

test("threadTurnsForDisplay keeps final assistant history on the same tool turn", () => {
  const turns = threadTurnsForDisplay(
    "thread-1",
    [],
    [
      event(
        "event-1",
        undefined,
        1,
        "command.output",
        "2026-06-12 10:00 - User: Inspect the app-server attach failure."
      ),
      event(
        "event-2",
        undefined,
        2,
        "command.output",
        "2026-06-12 10:01 - Assistant: I will inspect the failing path."
      ),
      event(
        "event-3",
        undefined,
        3,
        "command.output",
        "2026-06-12 10:02 - Tool call: exec_command"
      ),
      event(
        "event-4",
        undefined,
        4,
        "command.output",
        "2026-06-12 10:03 - Assistant: The failing path is fixed."
      )
    ]
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.prompt, "Inspect the app-server attach failure.");
  assert.equal(turns[0]?.assistant_summary, "The failing path is fixed.");
  assert.deepEqual(turns[0]?.progress_summaries, ["2026-06-12 10:02 - Tool call: exec_command"]);
  assert.equal(turns[0]?.event_count, 4);
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
      local_spool_bytes: 0,
      source: "empty",
      generated_at: "2026-06-12T10:00:00.000Z",
      window_sample_count: 0,
      windows: []
    },
    safety: safety(),
    server_time: "2026-06-12T10:00:00.000Z",
    ...overrides
  };
}

function command(id: string, overrides: Partial<CommandSummary> = {}): CommandSummary {
  return {
    id,
    workspace_id: "workspace-1",
    thread_id: "thread-1",
    task_id: "task-1",
    type: "codex",
    execution_mode: "app_server",
    prompt: "Run the next turn.",
    state: "pending",
    target_connector_id: "connector-1",
    created_at: "2026-06-12T10:00:00.000Z",
    updated_at: "2026-06-12T10:00:00.000Z",
    ...overrides
  };
}

function event(
  id: string,
  commandId: string | undefined,
  seq: number,
  kind: ThreadEvent["kind"],
  summary: string,
  overrides: Partial<ThreadEvent> = {}
): ThreadEvent {
  const item: ThreadEvent = {
    id,
    thread_id: "thread-1",
    seq,
    kind,
    priority: "P1",
    summary,
    created_at: `2026-06-12T10:00:0${seq}.000Z`
  };
  if (commandId) item.command_id = commandId;
  Object.assign(item, overrides);
  return item;
}

function safety(): BootstrapPayload["safety"] {
  return {
    state: "normal",
    paused: false,
    generated_at: "2026-06-12T10:00:00.000Z",
    summary: "Guarded dogfood actions are allowed.",
    actions: [
      "command_create",
      "local_thread_create",
      "host_session_refresh",
      "host_session_attach",
      "host_session_detach",
      "task_archive",
      "turn_interaction",
      "budget_bootstrap",
      "agent_event",
      "app_server_instances_report"
    ].map((action) => ({
      action: action as BootstrapPayload["safety"]["actions"][number]["action"],
      state: "allowed" as const,
      reason: "Allowed.",
      budget_state: "normal" as const
    }))
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

function hostSession(sessionId: string, overrides: Partial<HostSessionSummary> = {}): HostSessionSummary {
  return {
    id: `host-session-${sessionId}`,
    connector_id: "connector-1",
    hostname: "mac-studio.local",
    workspace_id: "workspace-api",
    session_id: sessionId,
    title: "Session",
    title_source: "metadata",
    cwd: "/Users/you/Program/project",
    updated_at: "2026-06-12T10:00:00.000Z",
    ...overrides
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
