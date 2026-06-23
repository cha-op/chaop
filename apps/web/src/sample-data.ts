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
        capabilities: [
          "placeholder_commands",
          "app_server_threads",
          "app_server_archive",
          "codex_app_server_exec",
          "host_session_app_server_ensure"
        ],
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
    ],
    host_sessions: [
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
    ],
    host_session_syncs: [
      {
        connector_id: "connector-mac-studio",
        synced_at: "2026-06-09T21:58:05.000Z",
        reported_session_count: 2,
        stored_session_count: 2
      }
    ],
    app_server_instances: [
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
      },
      {
        id: "app-server-sample-external",
        connector_id: "connector-buildbox",
        instance_key: "external-4545",
        scope: "workspace",
        workspace_id: "workspace-api",
        endpoint_type: "external",
        state: "degraded",
        active_turn_count: 0,
        generation: 1,
        status_summary: "External app-server health check timed out.",
        last_error: "Health probe exceeded the connector timeout.",
        last_seen_at: "2026-06-09T21:54:30.000Z",
        state_changed_at: "2026-06-09T21:54:30.000Z",
        updated_at: "2026-06-09T21:54:30.000Z"
      },
      {
        id: "app-server-sample-restarting",
        connector_id: "connector-laptop",
        instance_key: "default",
        scope: "connector",
        endpoint_type: "managed",
        state: "restarting",
        active_turn_count: 0,
        generation: 3,
        status_summary: "Connector is restarting the managed listener.",
        last_seen_at: "2026-06-09T19:20:00.000Z",
        state_changed_at: "2026-06-09T19:19:40.000Z",
        updated_at: "2026-06-09T19:20:00.000Z"
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
        thread_id: "thread-inventory",
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
        thread_id: "thread-shell-approval",
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
        thread_id: "thread-budget-telemetry",
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
    events: [
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
    ],
    budget: {
      state: "conservative",
      daily_used_pct: 75,
      four_hour_used_pct: 62,
      burst_used_pct: 18,
      delayed_event_count: 42,
      compacted_event_count: 318,
      local_spool_bytes: 134217728,
      source: "sample",
      generated_at: "2026-06-09T21:58:05.000Z",
      window_sample_count: 3,
      constraint_sample_count: 3,
      d1_write_model: {
        source: "schema_derived",
        free_rows_written_per_day: 100000,
        free_worker_requests_per_day: 100000,
        budgeted_rows_written_per_event: 26,
        daily_budget_units: 3846,
        four_hour_soft_budget_units: 481,
        four_hour_hard_budget_units: 641,
        burst_budget_units: 384,
        steady_persisted_event_rows_written: 12,
        first_event_in_minute_rows_written: 14,
        first_event_in_four_hour_rows_written: 16,
        first_event_in_day_rows_written: 18,
        backfill_rows_written_per_event: 6,
        backfill_same_minute_fixed_rows_written: 6,
        command_lifecycle_without_task_rows_written: 16,
        command_lifecycle_with_task_rows_written: 20,
        components: []
      },
      bottleneck_constraint: {
        id: "d1_rows_written_daily",
        label: "D1 rows written / day",
        detail: "Cloudflare Free D1 rows-written limit, converted to Chaop event capacity with the current schema-derived write model.",
        window_type: "daily",
        unit: "d1_row",
        hard: true,
        sampled: true,
        state: "conservative",
        source: "sample",
        limit_units: 100000,
        used_units: 75000,
        used_pct: 75,
        remaining_units: 25000,
        remaining_ratio: 0.25,
        per_event_units: 26,
        remaining_event_capacity: 961,
        window_start: "2026-06-09T00:00:00.000Z",
        window_end: "2026-06-10T00:00:00.000Z",
        updated_at: "2026-06-09T21:58:05.000Z"
      },
      constraints: [
        {
          id: "d1_rows_written_daily",
          label: "D1 rows written / day",
          detail: "Cloudflare Free D1 rows-written limit, converted to Chaop event capacity with the current schema-derived write model.",
          window_type: "daily",
          unit: "d1_row",
          hard: true,
          sampled: true,
          state: "conservative",
          source: "sample",
          limit_units: 100000,
          used_units: 75000,
          used_pct: 75,
          remaining_units: 25000,
          remaining_ratio: 0.25,
          per_event_units: 26,
          remaining_event_capacity: 961,
          window_start: "2026-06-09T00:00:00.000Z",
          window_end: "2026-06-10T00:00:00.000Z",
          updated_at: "2026-06-09T21:58:05.000Z"
        },
        {
          id: "d1_rows_written_four_hour",
          label: "D1 rows written / 4h",
          detail: "Chaop local four-hour guardrail that prevents one busy period from consuming the full daily D1 rows-written posture.",
          window_type: "four_hour",
          unit: "d1_row",
          hard: true,
          sampled: true,
          state: "conservative",
          source: "sample",
          limit_units: 16666,
          used_units: 10322,
          used_pct: 61.9,
          remaining_units: 6344,
          remaining_ratio: 0.381,
          per_event_units: 26,
          remaining_event_capacity: 244,
          window_start: "2026-06-09T18:00:00.000Z",
          window_end: "2026-06-09T22:00:00.000Z",
          updated_at: "2026-06-09T21:58:05.000Z"
        },
        {
          id: "d1_rows_written_burst",
          label: "D1 rows written / minute",
          detail: "Chaop burst guardrail for short spikes, modelled from D1 rows written per persisted event.",
          window_type: "burst",
          unit: "d1_row",
          hard: true,
          sampled: true,
          state: "normal",
          source: "sample",
          limit_units: 9984,
          used_units: 1794,
          used_pct: 18,
          remaining_units: 8190,
          remaining_ratio: 0.82,
          per_event_units: 26,
          remaining_event_capacity: 315,
          window_start: "2026-06-09T21:57:00.000Z",
          window_end: "2026-06-09T21:58:00.000Z",
          updated_at: "2026-06-09T21:58:05.000Z"
        },
        {
          id: "worker_requests_daily",
          label: "Worker requests / day",
          detail: "Cloudflare Worker request usage is not sampled by Chaop yet; keep Cloudflare budget alerts enabled.",
          window_type: "daily",
          unit: "worker_request",
          hard: false,
          sampled: false,
          state: "missing",
          source: "missing",
          limit_units: 100000,
          used_units: null,
          used_pct: null,
          remaining_units: null,
          remaining_ratio: null,
          per_event_units: null,
          remaining_event_capacity: null
        },
        {
          id: "durable_object_requests_daily",
          label: "Durable Object requests / day",
          detail: "Durable Object request usage, including incoming WebSocket message billing at Cloudflare's 20:1 compute-request ratio, is not sampled by Chaop yet.",
          window_type: "daily",
          unit: "durable_object_request",
          hard: false,
          sampled: false,
          state: "missing",
          source: "missing",
          limit_units: 100000,
          used_units: null,
          used_pct: null,
          remaining_units: null,
          remaining_ratio: null,
          per_event_units: null,
          remaining_event_capacity: null
        },
        {
          id: "d1_rows_read_daily",
          label: "D1 rows read / day",
          detail: "Cloudflare D1 rows-read usage is not sampled by Chaop yet.",
          window_type: "daily",
          unit: "d1_row_read",
          hard: false,
          sampled: false,
          state: "missing",
          source: "missing",
          limit_units: 5000000,
          used_units: null,
          used_pct: null,
          remaining_units: null,
          remaining_ratio: null,
          per_event_units: null,
          remaining_event_capacity: null
        }
      ],
      windows: [
        {
          window_type: "daily",
          window_start: "2026-06-09T00:00:00.000Z",
          window_end: "2026-06-10T00:00:00.000Z",
          budget_state: "conservative",
          used_pct: 75,
          budget_units: 3846,
          events_received: 2885,
          events_compacted: 318,
          events_delayed: 42,
          local_spool_bytes: 134217728,
          estimated_d1_rows_written: 75010,
          updated_at: "2026-06-09T21:58:05.000Z"
        },
        {
          window_type: "four_hour",
          window_start: "2026-06-09T18:00:00.000Z",
          window_end: "2026-06-09T22:00:00.000Z",
          budget_state: "conservative",
          used_pct: 61.9,
          budget_units: 641,
          events_received: 397,
          events_compacted: 92,
          events_delayed: 18,
          local_spool_bytes: 67108864,
          estimated_d1_rows_written: 10322,
          updated_at: "2026-06-09T21:58:05.000Z"
        },
        {
          window_type: "burst",
          window_start: "2026-06-09T21:57:00.000Z",
          window_end: "2026-06-09T21:58:00.000Z",
          budget_state: "normal",
          used_pct: 18,
          budget_units: 384,
          events_received: 69,
          events_compacted: 4,
          events_delayed: 0,
          local_spool_bytes: 0,
          estimated_d1_rows_written: 1794,
          updated_at: "2026-06-09T21:58:05.000Z"
        }
      ],
      telemetry_history: {
        source: "cloudflare_analytics",
        latest_sample_at: "2026-06-09T21:55:00.000Z",
        points: [
          {
            sampled_at: "2026-06-09T20:55:00.000Z",
            d1_rows_written_daily: 60200,
            d1_rows_read_daily: 1804000,
            worker_requests_daily: 820,
            durable_object_requests_daily: 2100
          },
          {
            sampled_at: "2026-06-09T21:10:00.000Z",
            d1_rows_written_daily: 64100,
            d1_rows_read_daily: 1821000,
            worker_requests_daily: 890,
            durable_object_requests_daily: 2200
          },
          {
            sampled_at: "2026-06-09T21:25:00.000Z",
            d1_rows_written_daily: 69000,
            d1_rows_read_daily: 1855000,
            worker_requests_daily: 940,
            durable_object_requests_daily: 2290
          },
          {
            sampled_at: "2026-06-09T21:40:00.000Z",
            d1_rows_written_daily: 72300,
            d1_rows_read_daily: 1873000,
            worker_requests_daily: 990,
            durable_object_requests_daily: 2380
          },
          {
            sampled_at: "2026-06-09T21:55:00.000Z",
            d1_rows_written_daily: 75000,
            d1_rows_read_daily: 1886000,
            worker_requests_daily: 1040,
            durable_object_requests_daily: 2460
          }
        ],
        slopes: [
          {
            window: "15m",
            sample_count: 2,
            minutes: 15,
            d1_rows_written_delta: 2700,
            d1_rows_written_per_minute: 180,
            projected_d1_rows_written_daily: 97800
          },
          {
            window: "1h",
            sample_count: 5,
            minutes: 60,
            d1_rows_written_delta: 14800,
            d1_rows_written_per_minute: 246.7,
            projected_d1_rows_written_daily: 106200
          }
        ]
      },
      d1_activity: {
        generated_at: "2026-06-09T21:58:05.000Z",
        source: "d1_write_activity_signals",
        signals: [
          {
            id: "cloudflare_d1_rows_written_daily",
            label: "Measured D1 writes today",
            detail: "Cloudflare GraphQL Analytics cumulative rows_written for the current UTC day.",
            source: "cloudflare_analytics",
            rows_written_daily: 75010,
            sampled: true,
            updated_at: "2026-06-09T21:55:00.000Z"
          },
          {
            id: "estimated_event_persistence_daily",
            label: "Estimated guarded event writes",
            detail: "Current daily usage-window event count multiplied by the conservative schema-derived rows-written budget per event.",
            source: "d1_usage_windows",
            rows_written_daily: 75000,
            sampled: true,
            updated_at: "2026-06-09T21:58:05.000Z"
          },
          {
            id: "estimated_non_event_residual_daily",
            label: "Measured minus event estimate",
            detail: "Residual writes after subtracting Chaop's persisted-event estimate.",
            source: "cloudflare_analytics",
            rows_written_daily: 0,
            sampled: true,
            updated_at: "2026-06-09T21:55:00.000Z"
          }
        ]
      }
    },
    server_time: new Date().toISOString()
  };
}
