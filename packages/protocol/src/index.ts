export type SourceType = "browser" | "connector" | "worker" | "system";

export type MessageEnvelope<T = unknown> = {
  v: 1;
  msg_id: string;
  kind: string;
  workspace_id?: string | undefined;
  thread_id?: string | undefined;
  command_id?: string | undefined;
  seq?: number | undefined;
  idempotency_key?: string | undefined;
  source: {
    type: SourceType;
    id: string;
  };
  target?: {
    type: SourceType | "workspace" | "thread";
    id?: string | undefined;
  };
  created_at: string;
  payload: T;
};

export type BudgetState =
  | "normal"
  | "conservative"
  | "throttled"
  | "hard_limited"
  | "recovery";

export type RealtimeMode =
  | "realtime"
  | "summary"
  | "cost_saving"
  | "throttled"
  | "waiting_for_upload";

export type FocusLevel = "background" | "idle" | "watching" | "interactive";

export type TaskState =
  | "running"
  | "idle"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "throttled"
  | "failed"
  | "done";

export type TaskCategory = {
  id: string;
  name: string;
  colour: string;
};

export type BrowserPresence = {
  session_id: string;
  visible: boolean;
  active: boolean;
  route: string;
  focus?: {
    workspace_id?: string | undefined;
    thread_id?: string | undefined;
    connector_id?: string | undefined;
    mode: FocusLevel;
  };
  last_input_at: number;
};

export type ReportingPolicy = {
  policy_version: number;
  default_level: FocusLevel;
  budget_state: BudgetState;
  scopes: Array<{
    workspace_id?: string | undefined;
    thread_id?: string | undefined;
    connector_id?: string | undefined;
    level: FocusLevel;
    heartbeat_ms: number;
    telemetry_ms: number;
    event_batch_ms: number;
    log_batch_ms: number;
    diff_debounce_ms: number;
    upload_detail: boolean | "summary";
  }>;
};

export type ConnectorSummary = {
  id: string;
  name: string;
  hostname: string;
  status: "online" | "offline" | "degraded";
  capabilities: string[];
  logical_agent_count: number;
  active_command_count: number;
  realtime_mode: RealtimeMode;
  budget_state: BudgetState;
  last_seen_at?: string | undefined;
  updated_at?: string | undefined;
};

export type AppServerInstanceState =
  | "healthy"
  | "degraded"
  | "draining"
  | "restarting"
  | "stopped";

export type AppServerEndpointType = "managed" | "external";

export type AppServerInstanceScope = "connector" | "workspace" | "thread";

export type AppServerInstanceSummary = {
  id: string;
  connector_id: string;
  instance_key: string;
  scope: AppServerInstanceScope;
  endpoint_type: AppServerEndpointType;
  state: AppServerInstanceState;
  active_turn_count: number;
  generation: number;
  status_summary?: string | undefined;
  last_error?: string | undefined;
  last_seen_at: string;
  state_changed_at: string;
  updated_at: string;
};

export type AgentAppServerInstance = {
  instance_key: string;
  scope: AppServerInstanceScope;
  endpoint_type: AppServerEndpointType;
  state: AppServerInstanceState;
  active_turn_count?: number | undefined;
  generation?: number | undefined;
  status_summary?: string | undefined;
  last_error?: string | undefined;
  reason?: "edge" | "summary" | "shutdown" | undefined;
};

export type AgentAppServerInstancesReport = {
  snapshot?: boolean | undefined;
  instances: AgentAppServerInstance[];
};

export type AppServerInstancesUpdatePayload = {
  app_server_instances: AppServerInstanceSummary[];
  connector_id?: string | undefined;
  synced_at?: string | undefined;
  snapshot?: boolean | undefined;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  repo_url?: string | undefined;
  connector_ids: string[];
  active_thread_count: number;
};

export type ThreadSummary = {
  id: string;
  workspace_id: string;
  title: string;
  state: "active" | "idle" | "archived";
  last_seq: number;
  updated_at: string;
  realtime_mode: RealtimeMode;
};

export type TaskSummary = {
  id: string;
  workspace_id: string;
  thread_id: string;
  title: string;
  category_id: string;
  state: TaskState;
  connector_id?: string | undefined;
  assigned_agent?: string | undefined;
  realtime_mode: RealtimeMode;
  budget_state: BudgetState;
  archived_at?: string | undefined;
  updated_at: string;
};

export type HostSessionTitleSource =
  | "metadata"
  | "app_server"
  | "history"
  | "fallback";

export type HostSessionSummary = {
  id: string;
  connector_id: string;
  hostname: string;
  workspace_id: string;
  session_id: string;
  title: string;
  title_source: HostSessionTitleSource;
  app_server_present?: boolean | undefined;
  cwd?: string | undefined;
  updated_at: string;
  attached_task_id?: string | undefined;
  attached_thread_id?: string | undefined;
};

export type HostSessionsUpdatePayload = {
  host_sessions: HostSessionSummary[];
  connector_id?: string | undefined;
  synced_at?: string | undefined;
  snapshot?: boolean | undefined;
};

export type ConnectorsUpdatePayload = {
  connectors: ConnectorSummary[];
  synced_at?: string | undefined;
};

export type HostSessionSyncSummary = {
  connector_id: string;
  synced_at: string;
  reported_session_count: number;
  stored_session_count: number;
};

export type RefreshHostSessionsResponse = {
  requested: true;
  dispatched_to: number;
  server_time: string;
};

export type CreateLocalThreadRequest = {
  workspace_id: string;
  title?: string | undefined;
  connector_id?: string | undefined;
};

export type CreateLocalThreadResponse = {
  host_session: HostSessionSummary;
  task: TaskSummary;
  thread: ThreadSummary;
};

export type TaskArchiveSyncSummary = {
  attempted: boolean;
  connector_id?: string | undefined;
  session_id?: string | undefined;
  archived: boolean;
  error?: string | undefined;
};

export type TaskArchiveResponse = {
  task: TaskSummary;
  archive_sync?: TaskArchiveSyncSummary | undefined;
};

export type CommandSummary = {
  id: string;
  workspace_id: string;
  thread_id?: string | undefined;
  task_id?: string | undefined;
  type: "placeholder" | "codex";
  execution_mode?: CommandRequestExecutionMode | undefined;
  prompt: string;
  state:
    | "pending"
    | "leased"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelling"
    | "cancelled";
  target_connector_id?: string | undefined;
  created_at: string;
  updated_at: string;
};

export type CommandRequestExecutionMode = "app_server" | "codex_cli_fallback";

export type CommandTargetHostSession = {
  session_id: string;
  app_server_present: boolean;
  cwd?: string | undefined;
};

export type ThreadEvent = {
  id: string;
  thread_id: string;
  command_id?: string | undefined;
  seq: number;
  kind:
    | "command.accepted"
    | "command.started"
    | "command.output"
    | "command.finished"
    | "command.failed"
    | "approval.requested"
    | "notice.throttled";
  priority: "P0" | "P1" | "P2" | "P3";
  summary: string;
  created_at: string;
};

export type BudgetSummary = {
  state: BudgetState;
  daily_used_pct: number;
  four_hour_used_pct: number;
  burst_used_pct: number;
  delayed_event_count: number;
  compacted_event_count: number;
  local_spool_bytes: number;
};

export type BootstrapPayload = {
  user: {
    id: string;
    email: string;
    name: string;
  };
  connectors: ConnectorSummary[];
  workspaces: WorkspaceSummary[];
  threads: ThreadSummary[];
  tasks: TaskSummary[];
  host_sessions: HostSessionSummary[];
  host_session_syncs: HostSessionSyncSummary[];
  app_server_instances: AppServerInstanceSummary[];
  task_categories: TaskCategory[];
  running_commands: CommandSummary[];
  events: ThreadEvent[];
  budget: BudgetSummary;
  server_time: string;
};

export type AgentBootstrapRequest = {
  connector_name: string;
  hostname: string;
  workspace_root: string;
  capabilities: string[];
};

export type AgentBootstrapResponse = {
  connector_id: string;
  token: string;
  control_url: string;
  reporting_policy: ReportingPolicy;
};

export type CreateCommandRequest = {
  workspace_id: string;
  thread_id?: string | undefined;
  task_id?: string | undefined;
  type?: CommandSummary["type"] | undefined;
  execution_mode?: CommandRequestExecutionMode | undefined;
  prompt: string;
  target_connector_id?: string | undefined;
};

export type CreateCommandResponse = {
  command: CommandSummary;
  accepted: boolean;
};

export type AttachHostSessionRequest = {
  connector_id?: string | undefined;
};

export type AttachHostSessionResponse = {
  host_session: HostSessionSummary;
  task: TaskSummary;
  thread: ThreadSummary;
  events?: ThreadEvent[] | undefined;
  backfill?: HostSessionBackfillSummary | undefined;
};

export type DetachHostSessionRequest = {
  connector_id?: string | undefined;
};

export type DetachHostSessionResponse = {
  host_session: HostSessionSummary;
};

export type CommandDispatch = {
  command: CommandSummary;
  target_host_session?: CommandTargetHostSession | undefined;
};

export type AgentCommandEvent = {
  command_id: string;
  target_host_session_id?: string | undefined;
  kind:
    | "command.started"
    | "command.output"
    | "command.finished"
    | "command.failed";
  priority: ThreadEvent["priority"];
  summary: string;
};

export type AgentHostSession = {
  session_id: string;
  title: string;
  title_source: HostSessionTitleSource;
  app_server_present?: boolean | undefined;
  cwd?: string | undefined;
  updated_at: string;
};

export type HostSessionInventoryScope = "full" | "incremental";

export type AgentHostSessionsReport = {
  sessions: AgentHostSession[];
  inventory_scope?: HostSessionInventoryScope | undefined;
  app_server_inventory_ok?: boolean | undefined;
};

export type AgentBackfillEvent = {
  kind: ThreadEvent["kind"];
  priority: ThreadEvent["priority"];
  summary: string;
  idempotency_key: string;
  created_at: string;
};

export type HostSessionBackfillDispatch = {
  request_id: string;
  session_id: string;
  limit?: number | undefined;
};

export type HostSessionBackfillResult = {
  request_id: string;
  ok: boolean;
  events?: AgentBackfillEvent[] | undefined;
  truncated?: boolean | undefined;
  error?: string | undefined;
};

export type ThreadArchiveSyncDispatch = {
  request_id: string;
  session_id: string;
  archived: boolean;
};

export type ThreadArchiveSyncResult = {
  request_id: string;
  ok: boolean;
  synced?: boolean | undefined;
  error?: string | undefined;
};

export type HostSessionBackfillSummary = {
  attempted: boolean;
  imported_event_count: number;
  truncated?: boolean | undefined;
  error?: string | undefined;
};

export type ThreadEventsResponse = {
  events: ThreadEvent[];
};

export type LocalThreadCreateDispatch = {
  request_id: string;
  workspace_id: string;
  title?: string | undefined;
};

export type LocalThreadCreateResult = {
  request_id: string;
  ok: boolean;
  session?: AgentHostSession | undefined;
  error?: string | undefined;
};

export type ThrottleNotice = {
  state: BudgetState;
  reason: string;
  retry_after_ms?: number | undefined;
  affected_scope: "global" | "connector" | "workspace" | "thread" | "command";
};

export const TASK_STATE_LABELS: Record<TaskState, string> = {
  running: "Running",
  idle: "Idle",
  waiting_for_approval: "Waiting for approval",
  waiting_for_input: "Waiting for input",
  throttled: "Throttled",
  failed: "Failed",
  done: "Done"
};

export function groupTasksByState(
  tasks: TaskSummary[]
): Record<TaskState, TaskSummary[]> {
  const grouped: Record<TaskState, TaskSummary[]> = {
    running: [],
    idle: [],
    waiting_for_approval: [],
    waiting_for_input: [],
    throttled: [],
    failed: [],
    done: []
  };

  for (const task of tasks) {
    grouped[task.state].push(task);
  }

  return grouped;
}

export function createEnvelope<T>(
  kind: string,
  source: MessageEnvelope["source"],
  payload: T,
  overrides: Partial<Omit<MessageEnvelope<T>, "v" | "kind" | "source" | "payload">> = {}
): MessageEnvelope<T> {
  return {
    v: 1,
    msg_id: overrides.msg_id ?? cryptoRandomId(),
    kind,
    source,
    created_at: overrides.created_at ?? new Date().toISOString(),
    payload,
    ...overrides
  };
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
