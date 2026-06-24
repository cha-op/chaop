import type {
  AppServerInstanceSummary,
  BootstrapPayload,
  BudgetSummary,
  CommandSummary,
  CreateCommandRequest,
  ConnectorSummary,
  DogfoodSafetyAction,
  DogfoodSafetyActionGuard,
  DogfoodSafetyPosture,
  HostSessionBackfillSummary,
  HostSessionSummary,
  HostSessionSyncSummary,
  TaskArchiveResponse,
  ThreadEvent,
  ThreadSummary
} from "@chaop/protocol";

export type CommandExecutionMode = "placeholder" | "app_server" | "codex_cli_fallback";

export type ThreadTurnStatus = "partial" | "pending" | "running" | "waiting" | "succeeded" | "failed";

export type ThreadTurnSummary = {
  command_id: string;
  command?: CommandSummary | undefined;
  prompt?: string | undefined;
  status: ThreadTurnStatus;
  assistant_summary?: string | undefined;
  error_summary?: string | undefined;
  progress_summaries: string[];
  event_count: number;
  last_seq: number;
  updated_at: string;
  events: ThreadEvent[];
};

export const MANAGED_APP_SERVER_UNAVAILABLE = "No managed app-server connector is online.";

export function threadTurnsForDisplay(
  threadId: string,
  commands: CommandSummary[],
  events: ThreadEvent[]
): ThreadTurnSummary[] {
  const groups = new Map<string, { command?: CommandSummary; events: ThreadEvent[] }>();
  for (const event of events) {
    if (event.thread_id !== threadId || !event.command_id) continue;
    const group = groups.get(event.command_id) ?? { events: [] };
    group.events.push(event);
    groups.set(event.command_id, group);
  }

  for (const command of commands) {
    if (command.thread_id !== threadId) continue;
    const group = groups.get(command.id) ?? { events: [] };
    group.command = command;
    groups.set(command.id, group);
  }

  return [
    ...[...groups.entries()]
      .map(([commandId, group]) => buildThreadTurn(commandId, group.command, group.events)),
    ...buildHistoryTurns(threadId, events)
  ]
    .sort((left, right) => {
      const updated = right.updated_at.localeCompare(left.updated_at);
      if (updated !== 0) return updated;
      return right.last_seq - left.last_seq;
    });
}

function buildHistoryTurns(threadId: string, events: ThreadEvent[]): ThreadTurnSummary[] {
  const historyEvents = events
    .filter((event) => event.thread_id === threadId && !event.command_id)
    .sort((left, right) => {
      if (left.seq !== right.seq) return left.seq - right.seq;
      return left.created_at.localeCompare(right.created_at);
    });
  const drafts: HistoryTurnDraft[] = [];
  let current: HistoryTurnDraft | undefined;
  const finishCurrent = () => {
    if (!current) return;
    drafts.push(current);
    current = undefined;
  };
  const appendProgress = (event: ThreadEvent) => {
    const target = current ?? drafts.at(-1);
    if (target) {
      target.events.push(event);
      target.progress_summaries = appendProgressSummary(target.progress_summaries, event.summary);
    }
  };

  for (const event of historyEvents) {
    const message = parseBackfillMessage(event.summary);
    if (message?.role === "user") {
      finishCurrent();
      current = {
        id: `history-${event.id}`,
        prompt: message.text,
        events: [event]
      };
      continue;
    }

    if (message?.role === "assistant") {
      if (current) {
        current.assistant = message.text;
        current.events.push(event);
        drafts.push(current);
        current = undefined;
      } else {
        const previous = drafts.at(-1);
        if (previous) {
          previous.assistant = message.text;
          previous.events.push(event);
        } else {
          drafts.push({
            id: `history-${event.id}`,
            assistant: message.text,
            events: [event]
          });
        }
      }
      continue;
    }

    appendProgress(event);
  }

  finishCurrent();
  return drafts.map(historyTurnFromDraft);
}

function appendProgressSummary(current: string[] | undefined, summary: string): string[] {
  if (!current) return [summary];
  if (current.includes(summary)) return current;
  return [...current, summary];
}

function historyTurnFromDraft(draft: HistoryTurnDraft): ThreadTurnSummary {
  const sortedEvents = [...draft.events].sort((left, right) => {
    if (left.seq !== right.seq) return left.seq - right.seq;
    return left.created_at.localeCompare(right.created_at);
  });
  const failed = sortedEvents.some((event) => event.kind === "command.failed");
  return {
    command_id: draft.id,
    prompt: draft.prompt,
    status: failed ? "failed" : draft.assistant ? "succeeded" : "partial",
    assistant_summary: draft.assistant,
    error_summary: [...sortedEvents].reverse().find((event) => event.kind === "command.failed")?.summary,
    progress_summaries: draft.progress_summaries ?? [],
    event_count: sortedEvents.length,
    last_seq: Math.max(0, ...sortedEvents.map((event) => event.seq)),
    updated_at: sortedEvents.map((event) => event.created_at).sort().at(-1) ?? new Date(0).toISOString(),
    events: sortedEvents
  };
}

function parseBackfillMessage(summary: string): { role: "user" | "assistant"; text: string } | undefined {
  const timestamped = summary.match(
    /^(?:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}|unknown time)\s+-\s+(User|Assistant):\s*(.+)$/s
  );
  const bare = summary.match(/^(User|Assistant):\s*(.+)$/s);
  const match = timestamped ?? bare;
  if (!match) return undefined;
  const role = match[1] === "User" ? "user" : "assistant";
  const text = match[2]?.trim();
  return text ? { role, text } : undefined;
}

type HistoryTurnDraft = {
  id: string;
  prompt?: string | undefined;
  assistant?: string | undefined;
  progress_summaries?: string[] | undefined;
  events: ThreadEvent[];
};

function buildThreadTurn(
  commandId: string,
  command: CommandSummary | undefined,
  events: ThreadEvent[]
): ThreadTurnSummary {
  const sortedEvents = [...events].sort((left, right) => {
    if (left.seq !== right.seq) return left.seq - right.seq;
    return left.created_at.localeCompare(right.created_at);
  });
  const eventStatus = threadTurnStatusFromEvents(sortedEvents);
  const commandStatus = command ? threadTurnStatusFromCommand(command) : undefined;
  const hasTerminalEvent = sortedEvents.some((event) =>
    event.kind === "command.finished" || event.kind === "command.failed"
  );
  const status = hasTerminalEvent
    ? eventStatus ?? commandStatus ?? "pending"
    : commandStatus === "succeeded" || commandStatus === "failed"
      ? commandStatus
      : eventStatus ?? commandStatus ?? "pending";
  const assistantEvent = [...sortedEvents]
    .reverse()
    .find((event) => event.kind === "command.output" && assistantSummaryFromEvent(event) !== undefined);
  const errorEvent = [...sortedEvents].reverse().find((event) => event.kind === "command.failed");
  const progressSummaries = sortedEvents
    .filter((event) => progressSummaryForEvent(event) !== undefined)
    .map((event) => progressSummaryForEvent(event)!)
    .filter((summary, index, all) => all.indexOf(summary) === index);
  const updatedAt = [command?.updated_at, command?.created_at, ...sortedEvents.map((event) => event.created_at)]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort()
    .at(-1) ?? new Date(0).toISOString();

  return {
    command_id: commandId,
    command,
    prompt: command?.prompt,
    status,
    assistant_summary: assistantEvent ? assistantSummaryFromEvent(assistantEvent) : undefined,
    error_summary: errorEvent?.summary,
    progress_summaries: progressSummaries,
    event_count: sortedEvents.length,
    last_seq: Math.max(0, ...sortedEvents.map((event) => event.seq)),
    updated_at: updatedAt,
    events: sortedEvents
  };
}

function threadTurnStatusFromEvents(events: ThreadEvent[]): ThreadTurnStatus | undefined {
  let status: ThreadTurnStatus | undefined;
  for (const event of events) {
    if (event.kind === "command.accepted") status = "pending";
    if (event.kind === "command.started" || event.kind === "command.output") status = "running";
    if (event.kind === "approval.requested" || event.kind === "notice.throttled") status = "waiting";
    if (event.kind === "command.finished") status = "succeeded";
    if (event.kind === "command.failed") status = "failed";
  }
  return status;
}

function threadTurnStatusFromCommand(command: CommandSummary): ThreadTurnStatus {
  if (command.state === "running" || command.state === "leased" || command.state === "cancelling") {
    return "running";
  }
  if (command.state === "succeeded") return "succeeded";
  if (command.state === "failed" || command.state === "cancelled") return "failed";
  return "pending";
}

function assistantSummaryFromEvent(event: ThreadEvent): string | undefined {
  if (event.kind !== "command.output") return undefined;
  const match = event.summary.match(/^Codex:\s*(.+)$/s);
  return match?.[1]?.trim() || undefined;
}

function progressSummaryForEvent(event: ThreadEvent): string | undefined {
  if (event.kind === "command.output" && assistantSummaryFromEvent(event) !== undefined) return undefined;
  if (event.kind === "command.finished" || event.kind === "command.failed") return undefined;
  if (event.kind === "command.accepted") return undefined;
  return event.summary;
}

const APP_SERVER_INSTANCE_STATE_RANK: Record<AppServerInstanceSummary["state"], number> = {
  degraded: 0,
  stopped: 1,
  restarting: 2,
  draining: 3,
  healthy: 4
};

export function safetyGuardForAction(
  data: BootstrapPayload | undefined,
  action: DogfoodSafetyAction
): DogfoodSafetyActionGuard | undefined {
  return data?.safety?.actions.find((guard) => guard.action === action);
}

export function safetyActionBlocked(
  data: BootstrapPayload | undefined,
  action: DogfoodSafetyAction
): boolean {
  return safetyGuardForAction(data, action)?.state === "blocked";
}

export function safetyActionReason(
  data: BootstrapPayload | undefined,
  action: DogfoodSafetyAction
): string | undefined {
  const guard = safetyGuardForAction(data, action);
  return guard?.state === "blocked" ? guard.reason : undefined;
}

export function budgetSourceLabel(budget: BudgetSummary): string {
  const windowSampleCount = budget.window_sample_count ?? (budget.windows ?? []).length;
  const constraintSampleCount = budget.constraint_sample_count ?? budget.constraints?.filter((constraint) => constraint.sampled).length ?? 0;
  const constraintCount = budget.constraints?.length ?? 0;
  const schemaModelCount = budget.constraints?.filter((constraint) => constraint.source === "schema_model" && constraint.sampled).length ?? 0;
  if (budget.source === "d1_usage_windows") {
    if (!budget.constraints) {
      return `Live database summary from ${windowSampleCount} bounded usage windows; detailed constraints are not reported by this control plane.`;
    }
    const baseline = schemaModelCount > 0 ? `, including ${schemaModelCount} local model baselines` : "";
    return `Live database summary from ${windowSampleCount} bounded usage windows and ${constraintSampleCount}/${constraintCount} sampled budget constraints${baseline}.`;
  }
  if (budget.source === "cloudflare_analytics") {
    const baseline = schemaModelCount > 0 ? `, including ${schemaModelCount} local model baselines` : "";
    return `Cloudflare analytics summary with ${constraintSampleCount}/${constraintCount} sampled budget constraints${baseline}; no Chaop usage windows are open yet.`;
  }
  if (budget.source === "sample") {
    return "Sample data for local development.";
  }
  if (budget.source === undefined) {
    return "Summary source not reported by this control plane.";
  }
  if (schemaModelCount > 0) {
    return `No D1 or Cloudflare usage samples yet; ${schemaModelCount} local short-window baselines are shown as 0.`;
  }
  return "No usage windows recorded yet.";
}

export function budgetPctLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "missing";
  }
  if (!Number.isFinite(value)) {
    return "unknown";
  }
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

export function appServerInstancesForConnector(
  data: BootstrapPayload | undefined,
  connectorId: string
): AppServerInstanceSummary[] {
  return (data?.app_server_instances ?? [])
    .filter((instance) => instance.connector_id === connectorId)
    .sort(compareAppServerInstancesForDisplay);
}

export function appServerInstancesForDisplay(
  data: BootstrapPayload | undefined
): AppServerInstanceSummary[] {
  return [...(data?.app_server_instances ?? [])].sort(compareAppServerInstancesForDisplay);
}

export function primaryAppServerInstanceForConnector(
  data: BootstrapPayload | undefined,
  connectorId: string
): AppServerInstanceSummary | undefined {
  return appServerInstancesForConnector(data, connectorId)[0];
}

export function appServerInstanceForHostSession(
  data: BootstrapPayload | undefined,
  session: HostSessionSummary
): AppServerInstanceSummary | undefined {
  return appServerInstancesForConnector(data, session.connector_id)
    .filter((instance) => appServerInstancePlacementRankForHostSession(instance, session) !== undefined)
    .sort((left, right) => {
      const leftRank = appServerInstancePlacementRankForHostSession(left, session) ?? 99;
      const rightRank = appServerInstancePlacementRankForHostSession(right, session) ?? 99;
      return leftRank - rightRank || compareAppServerInstancesForDisplay(left, right);
    })[0];
}

export function appServerInstanceStateLabel(state: AppServerInstanceSummary["state"]): string {
  return state.replaceAll("_", " ");
}

export function appServerInstancePlacementLabel(instance: AppServerInstanceSummary): string {
  if (instance.scope === "connector") return "Connector-wide";
  if (instance.scope === "workspace") {
    return instance.workspace_id ? `Workspace ${instance.workspace_id}` : "Workspace";
  }
  return instance.thread_id ? `Thread ${instance.thread_id}` : "Thread";
}

function appServerInstancePlacementRankForHostSession(
  instance: AppServerInstanceSummary,
  session: HostSessionSummary
): number | undefined {
  if (instance.scope === "thread") {
    return session.attached_thread_id && instance.thread_id === session.attached_thread_id ? 0 : undefined;
  }
  if (instance.scope === "workspace") {
    return instance.workspace_id === session.workspace_id ? 1 : undefined;
  }
  return 2;
}

export function mergeBootstrapPayload(
  current: BootstrapPayload | undefined,
  incoming: BootstrapPayload
): BootstrapPayload {
  if (!current) {
    return {
      ...incoming,
      app_server_instances: appServerInstancesOrEmpty(incoming),
      safety: safetyOrFallback(incoming)
    };
  }

  const hostSessionSyncs = mergeHostSessionSyncs(incoming.host_session_syncs, current.host_session_syncs);
  const incomingAppServerInstances = maybeAppServerInstances(incoming);
  const incomingSafety = maybeSafety(incoming);
  return {
    ...incoming,
    connectors: mergeBootstrapConnectors(current.connectors, incoming.connectors),
    threads: mergeById(incoming.threads, current.threads, newerThread),
    tasks: mergeById(incoming.tasks, current.tasks, newerByUpdatedAt),
    running_commands: mergeById(incoming.running_commands, current.running_commands, newerByUpdatedAt),
    events: mergeById(incoming.events, current.events, newerByCreatedAt),
    host_sessions: mergeHostSessions(incoming.host_sessions, current.host_sessions),
    host_session_syncs: hostSessionSyncs,
    app_server_instances: incomingAppServerInstances
      ? mergeBootstrapAppServerInstances(appServerInstancesOrEmpty(current), incomingAppServerInstances)
      : appServerInstancesOrEmpty(current),
    safety: incomingSafety ?? safetyOrFallback(current, incoming.server_time)
  };
}

function maybeAppServerInstances(payload: BootstrapPayload): AppServerInstanceSummary[] | undefined {
  const value = (payload as { app_server_instances?: unknown }).app_server_instances;
  return Array.isArray(value) ? value as AppServerInstanceSummary[] : undefined;
}

function maybeSafety(payload: BootstrapPayload): DogfoodSafetyPosture | undefined {
  const value = (payload as { safety?: unknown }).safety;
  return isSafetyPosture(value) ? value : undefined;
}

function safetyOrFallback(payload: BootstrapPayload, generatedAt = payload.server_time): DogfoodSafetyPosture {
  return maybeSafety(payload) ?? defaultSafetyPosture(generatedAt);
}

function isSafetyPosture(value: unknown): value is DogfoodSafetyPosture {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DogfoodSafetyPosture>;
  return typeof candidate.state === "string"
    && typeof candidate.paused === "boolean"
    && typeof candidate.generated_at === "string"
    && typeof candidate.summary === "string"
    && Array.isArray(candidate.actions);
}

const DEFAULT_SAFETY_ACTIONS: DogfoodSafetyAction[] = [
  "command_create",
  "local_thread_create",
  "host_session_refresh",
  "host_session_attach",
  "host_session_detach",
  "task_archive",
  "budget_bootstrap",
  "agent_event",
  "app_server_instances_report"
];

function defaultSafetyPosture(generatedAt = new Date(0).toISOString()): DogfoodSafetyPosture {
  return {
    state: "normal",
    paused: false,
    generated_at: generatedAt,
    summary: "Dogfood writes are allowed.",
    actions: DEFAULT_SAFETY_ACTIONS.map((action) => ({
      action,
      state: "allowed",
      reason: "Allowed by the legacy control plane response.",
      budget_state: "normal"
    }))
  };
}

function appServerInstancesOrEmpty(payload: BootstrapPayload): AppServerInstanceSummary[] {
  return maybeAppServerInstances(payload) ?? [];
}

function mergeBootstrapConnectors(
  current: ConnectorSummary[],
  incoming: ConnectorSummary[]
): ConnectorSummary[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  return incoming.map((item) => {
    const currentItem = currentById.get(item.id);
    return currentItem ? newerConnector(item, currentItem) : item;
  });
}

function mergeBootstrapAppServerInstances(
  current: AppServerInstanceSummary[],
  incoming: AppServerInstanceSummary[]
): AppServerInstanceSummary[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  return incoming.map((item) => {
    const currentItem = currentById.get(item.id);
    return currentItem ? newerAppServerInstance(item, currentItem) : item;
  });
}

export function mergeConnectorSummaries(
  current: ConnectorSummary[],
  incoming: ConnectorSummary[]
): ConnectorSummary[] {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  const knownIds = new Set(current.map((item) => item.id));
  return [
    ...current.map((item) => {
      const incomingItem = incomingById.get(item.id);
      return incomingItem ? newerConnector(incomingItem, item) : item;
    }),
    ...incoming.filter((item) => !knownIds.has(item.id))
  ];
}

export function mergeAppServerInstances(
  current: AppServerInstanceSummary[],
  incoming: AppServerInstanceSummary[],
  options: { snapshotConnectorId?: string | undefined } = {}
): AppServerInstanceSummary[] {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  const retainedCurrent = current.filter(
    (item) =>
      options.snapshotConnectorId === undefined ||
      item.connector_id !== options.snapshotConnectorId ||
      incomingById.has(item.id)
  );
  const knownIds = new Set(retainedCurrent.map((item) => item.id));
  return [
    ...retainedCurrent.map((item) => {
      const incomingItem = incomingById.get(item.id);
      return incomingItem ? newerAppServerInstance(incomingItem, item) : item;
    }),
    ...incoming.filter((item) => !knownIds.has(item.id))
  ];
}

export function localThreadWorkspaceId(
  data: BootstrapPayload | undefined,
  selectedThreadId?: string
): string | undefined {
  if (!data) return undefined;
  const selectedThread = selectedThreadId
    ? data.threads.find((thread) => thread.id === selectedThreadId)
    : undefined;
  return selectedThread?.workspace_id ?? data.workspaces[0]?.id;
}

export function localThreadConnectors(
  data: BootstrapPayload | undefined,
  workspaceId: string | undefined
): ConnectorSummary[] {
  if (!data || !workspaceId) return [];
  const workspace = data.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return [];
  const connectorIds = new Set(workspace.connector_ids);
  return data.connectors.filter(
    (connector) =>
      connectorIds.has(connector.id) &&
      connector.status === "online" &&
      connector.capabilities.includes("app_server_threads")
  );
}

export function localThreadConnectorId(
  data: BootstrapPayload | undefined,
  workspaceId: string | undefined,
  selectedConnectorId: string
): string | undefined {
  if (!selectedConnectorId) return undefined;
  return localThreadConnectors(data, workspaceId).some((connector) => connector.id === selectedConnectorId)
    ? selectedConnectorId
    : undefined;
}

export function commandTypeForMode(mode: CommandExecutionMode): CommandSummary["type"] {
  return mode === "placeholder" ? "placeholder" : "codex";
}

export function commandExecutionModeForRequest(
  mode: CommandExecutionMode
): CreateCommandRequest["execution_mode"] {
  if (mode === "placeholder") return undefined;
  return mode;
}

export function commandModeLabel(mode: CommandExecutionMode): string {
  return {
    placeholder: "Placeholder",
    app_server: "App-server",
    codex_cli_fallback: "CLI fallback"
  }[mode];
}

export function defaultCommandMode(
  data: BootstrapPayload | undefined,
  threadId: string | undefined
): CommandExecutionMode {
  return managedAppServerCommandAvailable(data, threadId) ? "app_server" : "placeholder";
}

export function managedAppServerCommandAvailable(
  data: BootstrapPayload | undefined,
  threadId: string | undefined
): boolean {
  const session = attachedAppServerHostSession(data, threadId);
  if (!data || !session) return false;
  const connector = data.connectors.find((item) => item.id === session.connector_id);
  return Boolean(connector && connectorCanRunManagedAppServer(connector));
}

export function codexCliFallbackAvailable(
  data: BootstrapPayload | undefined,
  workspaceId: string | undefined
): boolean {
  if (!data || !workspaceId) return false;
  const workspace = data.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return false;
  const connectorIds = new Set(workspace.connector_ids);
  return data.connectors.some(
    (connector) =>
      connectorIds.has(connector.id) &&
      connector.status === "online" &&
      connector.capabilities.includes("codex_exec")
  );
}

export function normaliseCommandMode(
  mode: CommandExecutionMode,
  data: BootstrapPayload | undefined,
  threadId: string | undefined,
  options: { showCliFallback: boolean; preferManagedAppServer?: boolean }
): CommandExecutionMode {
  if (options.preferManagedAppServer) {
    return defaultCommandMode(data, threadId);
  }

  if (mode === "app_server" && !managedAppServerCommandAvailable(data, threadId)) {
    return "placeholder";
  }

  if (mode === "codex_cli_fallback") {
    const thread = data?.threads.find((item) => item.id === threadId);
    if (!options.showCliFallback || !codexCliFallbackAvailable(data, thread?.workspace_id)) {
      return defaultCommandMode(data, threadId);
    }
  }

  return mode;
}

export function historyBackfillNotice(backfill: HostSessionBackfillSummary | undefined): string | undefined {
  if (!backfill || !backfill.attempted || backfill.error) return undefined;
  const count = backfill.imported_event_count;
  if (count === 0) {
    return backfill.truncated
      ? "Attached. History backfill was truncated before any importable events were found."
      : "Attached. History backfill found no importable events.";
  }
  const noun = count === 1 ? "event" : "events";
  return backfill.truncated
    ? `Attached. Imported ${count} history ${noun}; older history was truncated.`
    : `Attached. Imported ${count} history ${noun}.`;
}

export function archiveSyncWarning(
  action: "Archive" | "Unarchive",
  response: TaskArchiveResponse
): string | undefined {
  const error = response.archive_sync?.error;
  return error ? `${action} completed, but app-server sync did not: ${error}` : undefined;
}

export function archiveSyncNotice(
  action: "Archive" | "Unarchive",
  response: TaskArchiveResponse
): string | undefined {
  const sync = response.archive_sync;
  if (!sync || !sync.attempted || sync.error) return undefined;
  return `${action} completed. App-server sync completed.`;
}

function attachedAppServerHostSession(
  data: BootstrapPayload | undefined,
  threadId: string | undefined
): HostSessionSummary | undefined {
  if (!data || !threadId) return undefined;
  return data.host_sessions.find(
    (session) => session.attached_thread_id === threadId && session.app_server_present === true
  );
}

function connectorCanRunManagedAppServer(connector: ConnectorSummary): boolean {
  return connector.status === "online" && connector.capabilities.includes("codex_app_server_exec");
}

function compareAppServerInstancesForDisplay(
  left: AppServerInstanceSummary,
  right: AppServerInstanceSummary
): number {
  const stateDelta = APP_SERVER_INSTANCE_STATE_RANK[left.state] - APP_SERVER_INSTANCE_STATE_RANK[right.state];
  if (stateDelta !== 0) return stateDelta;

  const turnDelta = right.active_turn_count - left.active_turn_count;
  if (turnDelta !== 0) return turnDelta;

  const updatedDelta = right.updated_at.localeCompare(left.updated_at);
  if (updatedDelta !== 0) return updatedDelta;

  const connectorDelta = left.connector_id.localeCompare(right.connector_id);
  if (connectorDelta !== 0) return connectorDelta;

  return left.instance_key.localeCompare(right.instance_key);
}

function mergeById<T extends { id: string }>(
  incoming: T[],
  current: T[],
  pick: (incoming: T, current: T) => T
): T[] {
  const merged = new Map<string, T>();
  for (const item of incoming) {
    merged.set(item.id, item);
  }
  for (const item of current) {
    const existing = merged.get(item.id);
    merged.set(item.id, existing ? pick(existing, item) : item);
  }
  return Array.from(merged.values());
}

export function mergeHostSessions(
  incoming: HostSessionSummary[],
  current: HostSessionSummary[],
  options: { snapshotConnectorId?: string | undefined } = {}
): HostSessionSummary[] {
  const merged = new Map<string, HostSessionSummary>();
  const incomingIds = new Set(incoming.map((item) => item.id));

  for (const item of incoming) {
    merged.set(item.id, item);
  }

  for (const item of current) {
    if (
      options.snapshotConnectorId !== undefined &&
      item.connector_id === options.snapshotConnectorId &&
      !incomingIds.has(item.id)
    ) {
      continue;
    }
    const existing = merged.get(item.id);
    if (existing) {
      merged.set(item.id, newerByUpdatedAt(existing, item));
      continue;
    }

    merged.set(item.id, item);
  }

  return Array.from(merged.values());
}

function newerThread(incoming: ThreadSummary, current: ThreadSummary): ThreadSummary {
  if (current.last_seq > incoming.last_seq) return current;
  if (incoming.last_seq > current.last_seq) return incoming;
  return newerByUpdatedAt(incoming, current);
}

function newerConnector(incoming: ConnectorSummary, current: ConnectorSummary): ConnectorSummary {
  const incomingTime = connectorTimestamp(incoming);
  const currentTime = connectorTimestamp(current);
  if (incomingTime && currentTime && currentTime < incomingTime) return incoming;
  if (incomingTime && currentTime && currentTime > incomingTime) return current;
  return incoming;
}

function newerAppServerInstance(
  incoming: AppServerInstanceSummary,
  current: AppServerInstanceSummary
): AppServerInstanceSummary {
  return current.updated_at > incoming.updated_at ? current : incoming;
}

function connectorTimestamp(connector: ConnectorSummary): string | undefined {
  return connector.updated_at ?? connector.last_seen_at;
}

function newerByUpdatedAt<T extends { updated_at: string }>(incoming: T, current: T): T {
  return current.updated_at > incoming.updated_at ? current : incoming;
}

function newerByCreatedAt<T extends { created_at: string }>(incoming: T, current: T): T {
  return current.created_at > incoming.created_at ? current : incoming;
}

function mergeHostSessionSyncs(
  incoming: HostSessionSyncSummary[],
  current: HostSessionSyncSummary[]
): HostSessionSyncSummary[] {
  const merged = new Map<string, HostSessionSyncSummary>();
  for (const item of incoming) {
    merged.set(item.connector_id, item);
  }
  for (const item of current) {
    const existing = merged.get(item.connector_id);
    merged.set(item.connector_id, existing && existing.synced_at > item.synced_at ? existing : item);
  }
  return Array.from(merged.values());
}
