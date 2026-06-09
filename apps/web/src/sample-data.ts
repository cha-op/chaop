import type { BootstrapPayload } from "@chaop/protocol";

export function fallbackBootstrap(): BootstrapPayload {
  return {
    user: {
      id: "user-operator",
      email: "operator@example.com",
      name: "operator"
    },
    connectors: [
      {
        id: "connector-mac-studio",
        name: "mac-studio",
        hostname: "mac-studio.local",
        status: "online",
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
        logical_agent_count: 3,
        active_command_count: 0,
        realtime_mode: "waiting_for_upload",
        budget_state: "normal",
        last_seen_at: "2026-06-09T19:20:00.000Z"
      }
    ],
    workspaces: [
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
    ],
    threads: [
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
      }
    ],
    task_categories: [
      { id: "release", name: "Release", colour: "#2563eb" },
      { id: "incident", name: "Incident", colour: "#dc2626" },
      { id: "maintenance", name: "Maintenance", colour: "#0f766e" },
      { id: "research", name: "Research", colour: "#7c3aed" },
      { id: "personal", name: "Personal", colour: "#64748b" }
    ],
    tasks: [
      {
        id: "task-orders-500",
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        title: "Investigate 500 errors on /api/orders",
        category_id: "incident",
        state: "running",
        connector_id: "connector-mac-studio",
        assigned_agent: "codex-placeholder",
        realtime_mode: "realtime",
        budget_state: "normal",
        updated_at: "2026-06-09T21:58:00.000Z"
      },
      {
        id: "task-pr-readiness",
        workspace_id: "workspace-api",
        thread_id: "thread-pr-readiness",
        title: "Review PR readiness logs",
        category_id: "release",
        state: "waiting_for_input",
        connector_id: "connector-mac-studio",
        assigned_agent: "codex-placeholder",
        realtime_mode: "realtime",
        budget_state: "normal",
        updated_at: "2026-06-09T21:52:00.000Z"
      },
      {
        id: "task-inventory",
        workspace_id: "workspace-api",
        title: "Sync workspace inventory",
        category_id: "maintenance",
        state: "idle",
        realtime_mode: "summary",
        budget_state: "normal",
        updated_at: "2026-06-09T21:40:00.000Z"
      },
      {
        id: "task-deploy-guide",
        workspace_id: "workspace-docs",
        thread_id: "thread-deploy-guide",
        title: "Generate deployment guide",
        category_id: "research",
        state: "done",
        connector_id: "connector-mac-studio",
        assigned_agent: "codex-placeholder",
        realtime_mode: "summary",
        budget_state: "normal",
        updated_at: "2026-06-09T21:42:00.000Z"
      },
      {
        id: "task-shell-approval",
        workspace_id: "workspace-api",
        title: "Await shell approval",
        category_id: "maintenance",
        state: "waiting_for_approval",
        connector_id: "connector-buildbox",
        assigned_agent: "codex-placeholder",
        realtime_mode: "realtime",
        budget_state: "normal",
        updated_at: "2026-06-09T21:36:00.000Z"
      },
      {
        id: "task-budget-telemetry",
        workspace_id: "workspace-api",
        title: "Budget compacted telemetry",
        category_id: "personal",
        state: "throttled",
        connector_id: "connector-buildbox",
        assigned_agent: "codex-placeholder",
        realtime_mode: "throttled",
        budget_state: "throttled",
        updated_at: "2026-06-09T21:30:00.000Z"
      }
    ],
    running_commands: [],
    budget: {
      state: "conservative",
      daily_used_pct: 75,
      four_hour_used_pct: 62,
      burst_used_pct: 18,
      delayed_event_count: 42,
      compacted_event_count: 318,
      local_spool_bytes: 134217728
    },
    server_time: new Date().toISOString()
  };
}
