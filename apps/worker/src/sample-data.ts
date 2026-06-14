import type {
  AppServerInstanceSummary,
  BootstrapPayload,
  BudgetSummary,
  ConnectorSummary,
  HostSessionSummary,
  HostSessionSyncSummary,
  TaskCategory,
  TaskSummary,
  ThreadEvent,
  ThreadSummary,
  WorkspaceSummary
} from "@chaop/protocol";

export const taskCategories: TaskCategory[] = [
  { id: "release", name: "Release", colour: "#2563eb" },
  { id: "incident", name: "Incident", colour: "#dc2626" },
  { id: "maintenance", name: "Maintenance", colour: "#0f766e" },
  { id: "research", name: "Research", colour: "#7c3aed" },
  { id: "personal", name: "Personal", colour: "#64748b" }
];

export const connectors: ConnectorSummary[] = [
  {
    id: "connector-mac-studio",
    name: "mac-studio",
    hostname: "mac-studio.local",
    status: "online",
    capabilities: ["placeholder_commands", "app_server_threads", "app_server_archive", "codex_app_server_exec"],
    logical_agent_count: 6,
    active_command_count: 2,
    realtime_mode: "realtime",
    budget_state: "normal",
    last_seen_at: "2026-06-09T21:58:00.000Z"
  },
  {
    id: "connector-buildbox",
    name: "buildbox",
    hostname: "buildbox.local",
    status: "degraded",
    capabilities: ["placeholder_commands"],
    logical_agent_count: 4,
    active_command_count: 1,
    realtime_mode: "summary",
    budget_state: "conservative",
    last_seen_at: "2026-06-09T21:55:00.000Z"
  },
  {
    id: "connector-laptop",
    name: "laptop",
    hostname: "laptop.local",
    status: "offline",
    capabilities: ["placeholder_commands"],
    logical_agent_count: 3,
    active_command_count: 0,
    realtime_mode: "waiting_for_upload",
    budget_state: "normal",
    last_seen_at: "2026-06-09T19:20:00.000Z"
  }
];

export const workspaces: WorkspaceSummary[] = [
  {
    id: "workspace-api",
    name: "API Control Plane",
    repo_url: "git@github.com:example/api-control-plane.git",
    connector_ids: ["connector-mac-studio", "connector-buildbox"],
    active_thread_count: 3
  },
  {
    id: "workspace-docs",
    name: "Deployment Docs",
    repo_url: "git@github.com:example/deployment-docs.git",
    connector_ids: ["connector-mac-studio"],
    active_thread_count: 2
  }
];

export const threads: ThreadSummary[] = [
  {
    id: "thread-orders-500",
    workspace_id: "workspace-api",
    title: "Investigate 500 errors on /api/orders",
    state: "active",
    last_seq: 12,
    updated_at: "2026-06-09T21:57:00.000Z",
    realtime_mode: "realtime"
  },
  {
    id: "thread-pr-readiness",
    workspace_id: "workspace-api",
    title: "Review PR readiness logs",
    state: "active",
    last_seq: 7,
    updated_at: "2026-06-09T21:50:00.000Z",
    realtime_mode: "summary"
  },
  {
    id: "thread-deploy-guide",
    workspace_id: "workspace-docs",
    title: "Generate deployment guide",
    state: "idle",
    last_seq: 3,
    updated_at: "2026-06-09T21:42:00.000Z",
    realtime_mode: "cost_saving"
  },
  {
    id: "thread-inventory",
    workspace_id: "workspace-api",
    title: "Sync workspace inventory",
    state: "idle",
    last_seq: 0,
    updated_at: "2026-06-09T21:40:00.000Z",
    realtime_mode: "summary"
  },
  {
    id: "thread-shell-approval",
    workspace_id: "workspace-api",
    title: "Await shell approval",
    state: "active",
    last_seq: 0,
    updated_at: "2026-06-09T21:36:00.000Z",
    realtime_mode: "realtime"
  },
  {
    id: "thread-budget-telemetry",
    workspace_id: "workspace-api",
    title: "Budget compacted telemetry",
    state: "active",
    last_seq: 0,
    updated_at: "2026-06-09T21:30:00.000Z",
    realtime_mode: "throttled"
  }
];

export const tasks: TaskSummary[] = [
  task("task-orders-500", "Investigate 500 errors on /api/orders", "incident", "running", "thread-orders-500"),
  task("task-pr-readiness", "Review PR readiness logs", "release", "waiting_for_input", "thread-pr-readiness"),
  task("task-inventory", "Sync workspace inventory", "maintenance", "idle", "thread-inventory"),
  task("task-deploy-guide", "Generate deployment guide", "research", "done", "thread-deploy-guide"),
  task("task-shell-approval", "Await shell approval", "maintenance", "waiting_for_approval", "thread-shell-approval"),
  task("task-budget-telemetry", "Budget compacted telemetry", "personal", "throttled", "thread-budget-telemetry")
];

export const hostSessions: HostSessionSummary[] = [
  {
    id: "host-session-sample-attached",
    connector_id: "connector-mac-studio",
    hostname: "mac-studio.local",
    workspace_id: "workspace-api",
    session_id: "019d3109-210d-7492-be2b-902b10993a3d",
    title: "Investigate 500 errors on /api/orders",
    title_source: "metadata",
    app_server_present: true,
    cwd: "/Users/you/Program/api-control-plane",
    updated_at: "2026-06-09T21:58:00.000Z",
    attached_task_id: "task-orders-500",
    attached_thread_id: "thread-orders-500"
  },
  {
    id: "host-session-sample-unattached",
    connector_id: "connector-mac-studio",
    hostname: "mac-studio.local",
    workspace_id: "workspace-api",
    session_id: "019e3152-ab17-7ce1-90e8-664c715fe952",
    title: "Evaluate Telegram bot options",
    title_source: "history",
    cwd: "/Users/you/Program/bot-lab",
    updated_at: "2026-06-09T20:18:00.000Z"
  }
];

export const hostSessionSyncs: HostSessionSyncSummary[] = [
  {
    connector_id: "connector-mac-studio",
    synced_at: "2026-06-09T21:58:05.000Z",
    reported_session_count: 2,
    stored_session_count: 2
  }
];

export const appServerInstances: AppServerInstanceSummary[] = [
  {
    id: "app-server-sample-managed",
    connector_id: "connector-mac-studio",
    instance_key: "default",
    scope: "connector",
    endpoint_type: "managed",
    state: "healthy",
    active_turn_count: 1,
    generation: 1,
    status_summary: "Managed app-server is accepting turns.",
    last_seen_at: "2026-06-09T21:58:05.000Z",
    state_changed_at: "2026-06-09T21:57:50.000Z",
    updated_at: "2026-06-09T21:58:05.000Z"
  }
];

export const budget: BudgetSummary = {
  state: "conservative",
  daily_used_pct: 75,
  four_hour_used_pct: 62,
  burst_used_pct: 18,
  delayed_event_count: 42,
  compacted_event_count: 318,
  local_spool_bytes: 134217728
};

export const events: ThreadEvent[] = [
  {
    id: "event-placeholder-accepted",
    thread_id: "thread-orders-500",
    command_id: "command-placeholder",
    seq: 1,
    kind: "command.accepted",
    priority: "P1",
    summary: "Control plane accepted the placeholder command.",
    created_at: "2026-06-09T21:58:01.000Z"
  },
  {
    id: "event-placeholder-output",
    thread_id: "thread-orders-500",
    command_id: "command-placeholder",
    seq: 2,
    kind: "command.output",
    priority: "P2",
    summary: "Summary stream is current; full log detail is deferred.",
    created_at: "2026-06-09T21:58:02.000Z"
  }
];

export function sampleBootstrap(email = "operator@example.com"): BootstrapPayload {
  return {
    user: {
      id: "user-operator",
      email,
      name: email.split("@")[0] ?? "operator"
    },
    connectors,
    workspaces,
    threads,
    tasks,
    host_sessions: hostSessions,
    host_session_syncs: hostSessionSyncs,
    app_server_instances: appServerInstances,
    task_categories: taskCategories,
    running_commands: [],
    events,
    budget,
    server_time: new Date().toISOString()
  };
}

function task(
  id: string,
  title: string,
  category_id: string,
  state: TaskSummary["state"],
  thread_id: string
): TaskSummary {
  return {
    id,
    workspace_id: id === "task-deploy-guide" ? "workspace-docs" : "workspace-api",
    thread_id,
    title,
    category_id,
    state,
    connector_id: state === "idle" ? undefined : "connector-mac-studio",
    assigned_agent: state === "idle" ? undefined : "codex-placeholder",
    realtime_mode: state === "throttled" ? "throttled" : state === "done" ? "summary" : "realtime",
    budget_state: state === "throttled" ? "throttled" : "normal",
    updated_at: "2026-06-09T21:58:00.000Z"
  };
}
