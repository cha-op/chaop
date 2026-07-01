import type {
  AppServerInstanceSummary,
  BootstrapPayload,
  BudgetConstraint,
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
  TurnInteractionRequestPayload,
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
  pending_interactions: PendingTurnInteraction[];
};

export type PendingTurnInteraction = {
  event_id: string;
  payload: TurnInteractionRequestPayload;
};

export type PendingTurnInteractionQuestion = NonNullable<TurnInteractionRequestPayload["questions"]>[number];

export type ReadinessPreflightState = "ready" | "attention" | "blocked";

export type ReadinessPreflightCheck = {
  id: "cost" | "connector" | "app_server" | "inventory";
  label: string;
  state: ReadinessPreflightState;
  detail: string;
};

export type ReadinessPreflight = {
  state: ReadinessPreflightState;
  title: string;
  summary: string;
  next_action: {
    label: string;
    href: "#budget-board" | "#host-sessions" | "#thread-centre";
    detail: string;
  };
  checks: ReadinessPreflightCheck[];
};

type ReadinessConnectorScope = {
  connector: ConnectorSummary;
  workspaceIds: Set<string>;
};

type ReadinessTarget =
  | { kind: "workspace"; workspaceId: string | undefined }
  | { kind: "missing_thread"; threadId: string }
  | { kind: "unattached_thread"; threadId: string; workspaceId: string }
  | { kind: "attached_thread"; threadId: string; workspaceId: string; connectorId: string };

export const MANAGED_APP_SERVER_UNAVAILABLE =
  "No online connector can both create and run managed app-server threads.";
export const TURN_INTERACTION_OTHER_SELECT_VALUE = "other";

const TURN_INTERACTION_OPTION_SELECT_PREFIX = "option:";

export function budgetBoardHash(threadId: string | undefined): string {
  return threadId ? `#budget-board?thread=${encodeURIComponent(threadId)}` : "#budget-board";
}

export function threadIdFromHashValue(hash: string): string | undefined {
  const query = hash.split("?")[1];
  if (!query) return undefined;
  return new URLSearchParams(query).get("thread") || undefined;
}

export function turnInteractionOptionSelectValue(index: number): string {
  return `${TURN_INTERACTION_OPTION_SELECT_PREFIX}${index}`;
}

export function turnInteractionQuestionSelectValue(
  question: PendingTurnInteractionQuestion,
  answer: string,
  otherSelected: boolean
): string {
  if (question.is_other && otherSelected) return TURN_INTERACTION_OTHER_SELECT_VALUE;
  const optionIndex = question.options?.findIndex((option) => option.label === answer) ?? -1;
  return optionIndex >= 0 ? turnInteractionOptionSelectValue(optionIndex) : "";
}

export function turnInteractionAnswerForSelectValue(
  question: PendingTurnInteractionQuestion,
  selectValue: string
): { answer: string; otherSelected: boolean } {
  if (question.is_other && selectValue === TURN_INTERACTION_OTHER_SELECT_VALUE) {
    return { answer: "", otherSelected: true };
  }
  if (!selectValue.startsWith(TURN_INTERACTION_OPTION_SELECT_PREFIX)) {
    return { answer: "", otherSelected: false };
  }
  const indexText = selectValue.slice(TURN_INTERACTION_OPTION_SELECT_PREFIX.length);
  const index = Number.parseInt(indexText, 10);
  if (!Number.isInteger(index) || index < 0) {
    return { answer: "", otherSelected: false };
  }
  return { answer: question.options?.[index]?.label ?? "", otherSelected: false };
}

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
  ].sort(compareThreadTurns);
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
    updated_at: historyTurnUpdatedAt(sortedEvents),
    events: sortedEvents,
    pending_interactions: []
  };
}

function compareThreadTurns(left: ThreadTurnSummary, right: ThreadTurnSummary): number {
  const leftTime = Date.parse(left.updated_at);
  const rightTime = Date.parse(right.updated_at);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return right.last_seq - left.last_seq;
}

function historyTurnUpdatedAt(events: ThreadEvent[]): string {
  return events
    .map((event) => event.created_at)
    .filter((value) => value !== UNKNOWN_BACKFILL_CREATED_AT)
    .sort()
    .at(-1) ?? UNKNOWN_TURN_UPDATED_AT;
}

const UNKNOWN_BACKFILL_CREATED_AT = "1970-01-01T00:00:00.000Z";
const UNKNOWN_TURN_UPDATED_AT = "unknown";

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
    events: sortedEvents,
    pending_interactions: status === "succeeded" || status === "failed" ? [] : pendingTurnInteractions(sortedEvents)
  };
}

function threadTurnStatusFromEvents(events: ThreadEvent[]): ThreadTurnStatus | undefined {
  let status: ThreadTurnStatus | undefined;
  let terminalStatus: ThreadTurnStatus | undefined;
  for (const event of events) {
    if (event.kind === "command.finished") {
      terminalStatus = "succeeded";
      continue;
    }
    if (event.kind === "command.failed") {
      terminalStatus = "failed";
      continue;
    }
    if (terminalStatus) continue;
    if (event.kind === "command.accepted") status = "pending";
    if (
      event.kind === "command.started" ||
      event.kind === "command.output" ||
      event.kind === "approval.resolved" ||
      event.kind === "input.received"
    ) {
      status = "running";
    }
    if (
      event.kind === "approval.requested" ||
      event.kind === "input.requested" ||
      event.kind === "notice.throttled"
    ) {
      status = "waiting";
    }
  }
  return terminalStatus ?? status;
}

function pendingTurnInteractions(events: ThreadEvent[]): PendingTurnInteraction[] {
  const resolved = new Set<string>();
  for (const event of events) {
    const payload = event.payload;
    if (payload?.type !== "turn_interaction_resolution") continue;
    resolved.add(payload.interaction_id);
  }

  return events
    .filter((event) => {
      const payload = event.payload;
      return payload?.type === "turn_interaction" && !resolved.has(payload.interaction_id);
    })
    .map((event) => ({
      event_id: event.id,
      payload: event.payload as TurnInteractionRequestPayload
    }));
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
  "turn_interaction",
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
      connector.capabilities.includes("app_server_threads") &&
      connector.capabilities.includes("codex_app_server_exec")
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

export function dogfoodReadinessPreflight(
  data: BootstrapPayload | undefined,
  selectedThreadId?: string
): ReadinessPreflight {
  const target = readinessTarget(data, selectedThreadId);
  const checks = [
    readinessCostCheck(data),
    readinessConnectorCheck(data, target),
    readinessAppServerCheck(data, target),
    readinessInventoryCheck(data)
  ];
  const state = checks.some((check) => check.state === "blocked")
    ? "blocked"
    : checks.some((check) => check.state === "attention")
      ? "attention"
      : "ready";
  const nextAction = readinessNextAction(state, checks);
  return {
    state,
    title: readinessTitle(state),
    summary: readinessSummary(state, checks),
    next_action: nextAction,
    checks
  };
}

function readinessCostCheck(data: BootstrapPayload | undefined): ReadinessPreflightCheck {
  if (!data) {
    return {
      id: "cost",
      label: "Cost posture",
      state: "blocked",
      detail: "Bootstrap data has not loaded yet."
    };
  }

  const safety = data.safety;
  const blockedReason =
    safetyActionReason(data, "command_create") ??
    safetyActionReason(data, "local_thread_create") ??
    safetyActionReason(data, "host_session_attach");
  if (safety.paused) {
    return {
      id: "cost",
      label: "Cost posture",
      state: "blocked",
      detail: safety.paused_reason ?? safety.summary
    };
  }
  if (
    safety.state === "hard_limited" ||
    safety.state === "throttled" ||
    data.budget.state === "hard_limited" ||
    data.budget.state === "throttled" ||
    blockedReason
  ) {
    return {
      id: "cost",
      label: "Cost posture",
      state: "blocked",
      detail: blockedReason ?? safety.summary
    };
  }
  if (
    safety.state === "conservative" ||
    safety.state === "recovery" ||
    data.budget.state === "conservative" ||
    data.budget.state === "recovery"
  ) {
    return {
      id: "cost",
      label: "Cost posture",
      state: "attention",
      detail: safety.summary
    };
  }
  if (!budgetHasSampledHardConstraint(data.budget)) {
    return {
      id: "cost",
      label: "Cost posture",
      state: "attention",
      detail: "No sampled hard budget constraint is available yet."
    };
  }
  return {
    id: "cost",
    label: "Cost posture",
    state: "ready",
    detail: safety.summary
  };
}

function readinessConnectorCheck(
  data: BootstrapPayload | undefined,
  target: ReadinessTarget
): ReadinessPreflightCheck {
  if (target.kind === "missing_thread") {
    return {
      id: "connector",
      label: "Connector",
      state: "blocked",
      detail: "The selected thread is no longer available."
    };
  }
  if (target.kind === "unattached_thread") {
    return {
      id: "connector",
      label: "Connector",
      state: "blocked",
      detail: "The selected thread has no attached app-server Host Session."
    };
  }
  const workspaceId = target.workspaceId;
  const online = readinessConnectorScopes(data, workspaceId).filter((scope) => scope.connector.status === "online");
  const workspaceLinked = online.filter((scope) => scope.workspaceIds.size > 0);
  const full = readinessEligibleConnectorScopes(data, target);
  const workspaceLabel = readinessWorkspaceLabel(data, workspaceId);
  if (full.length > 0) {
    return {
      id: "connector",
      label: "Connector",
      state: "ready",
      detail: target.kind === "attached_thread"
        ? `${full.length} workspace connector${full.length === 1 ? "" : "s"} can run the selected app-server thread for ${workspaceLabel}.`
        : `${full.length} workspace connector${full.length === 1 ? "" : "s"} can create and run app-server threads for ${workspaceLabel}.`
    };
  }
  if (target.kind === "attached_thread") {
    const owner = readinessConnectorScopes(data, workspaceId).find(
      (scope) => scope.connector.id === target.connectorId
    );
    if (!owner) {
      return {
        id: "connector",
        label: "Connector",
        state: "blocked",
        detail: "The connector attached to the selected thread is no longer reported."
      };
    }
    if (owner.workspaceIds.size === 0) {
      return {
        id: "connector",
        label: "Connector",
        state: "blocked",
        detail: `The connector attached to the selected thread is no longer linked to ${workspaceLabel}.`
      };
    }
    if (owner.connector.status !== "online") {
      return {
        id: "connector",
        label: "Connector",
        state: "blocked",
        detail: `The connector attached to the selected thread is ${owner.connector.status}.`
      };
    }
    return {
      id: "connector",
      label: "Connector",
      state: "blocked",
      detail: "The connector attached to the selected thread does not report app-server execution capability."
    };
  }
  if (online.length === 0) {
    return {
      id: "connector",
      label: "Connector",
      state: "blocked",
      detail: "No online connector is reporting managed app-server capabilities."
    };
  }
  if (workspaceLinked.length === 0) {
    return {
      id: "connector",
      label: "Connector",
      state: "blocked",
      detail: `No online connector is linked to ${workspaceLabel} for app-server dogfood.`
    };
  }
  const canCreate = workspaceLinked.some((scope) => scope.connector.capabilities.includes("app_server_threads"));
  const canRun = workspaceLinked.some((scope) => scope.connector.capabilities.includes("codex_app_server_exec"));
  if (!canCreate && !canRun) {
    return {
      id: "connector",
      label: "Connector",
      state: "blocked",
      detail: `${workspaceLinked.length} workspace connector${workspaceLinked.length === 1 ? "" : "s"} online for ${workspaceLabel}, but none reports app-server capabilities.`
    };
  }
  return {
    id: "connector",
    label: "Connector",
    state: "attention",
    detail: canCreate
      ? `An online connector for ${workspaceLabel} can create app-server threads, but execution capability is not reported on the same connector.`
      : `An online connector for ${workspaceLabel} can run app-server turns, but local thread creation is not reported on the same connector.`
  };
}

function readinessAppServerCheck(
  data: BootstrapPayload | undefined,
  target: ReadinessTarget
): ReadinessPreflightCheck {
  if (target.kind === "missing_thread") {
    return {
      id: "app_server",
      label: "App-server",
      state: "blocked",
      detail: "No app-server can target a thread that is no longer available."
    };
  }
  if (target.kind === "unattached_thread") {
    return {
      id: "app_server",
      label: "App-server",
      state: "blocked",
      detail: "Attach an app-server Host Session before running the selected thread."
    };
  }
  const workspaceId = target.workspaceId;
  const selectedThreadId = target.kind === "attached_thread" ? target.threadId : undefined;
  const eligibleConnectorScopes = readinessEligibleConnectorScopes(data, target);
  const instances = (data?.app_server_instances ?? []).filter((instance) =>
    readinessInstanceMatchesEligibleConnector(data, instance, eligibleConnectorScopes, selectedThreadId)
  );
  const healthy = instances.filter((instance) => instance.state === "healthy");
  const idle = healthy.filter((instance) => instance.active_turn_count === 0);
  const activeTurns = healthy.reduce((total, instance) => total + instance.active_turn_count, 0);
  if (idle.length > 0) {
    return {
      id: "app_server",
      label: "App-server",
      state: "ready",
      detail: `${idle.length} healthy app-server instance${idle.length === 1 ? "" : "s"} idle.`
    };
  }
  if (healthy.length > 0) {
    return {
      id: "app_server",
      label: "App-server",
      state: "attention",
      detail: `${healthy.length} healthy app-server instance${healthy.length === 1 ? "" : "s"} with ${activeTurns} active turn${activeTurns === 1 ? "" : "s"}.`
    };
  }
  const edge = instances
    .filter((instance) => instance.state !== "stopped")
    .sort(compareAppServerInstancesForDisplay)[0];
  if (edge) {
    return {
      id: "app_server",
      label: "App-server",
      state: "blocked",
      detail: edge.last_error ?? edge.status_summary ?? `App-server is ${edge.state}.`
    };
  }
  return {
    id: "app_server",
    label: "App-server",
    state: "blocked",
    detail: `No healthy app-server instance is reported by a connector linked to ${readinessWorkspaceLabel(data, workspaceId)}.`
  };
}

function readinessConnectorScopes(
  data: BootstrapPayload | undefined,
  workspaceId: string | undefined
): ReadinessConnectorScope[] {
  if (!data) return [];
  const workspaceIdsByConnector = new Map<string, Set<string>>();
  const workspaces = workspaceId
    ? data.workspaces.filter((workspace) => workspace.id === workspaceId)
    : [];
  for (const workspace of workspaces) {
    for (const connectorId of workspace.connector_ids) {
      const workspaceIds = workspaceIdsByConnector.get(connectorId) ?? new Set<string>();
      workspaceIds.add(workspace.id);
      workspaceIdsByConnector.set(connectorId, workspaceIds);
    }
  }
  return data.connectors.map((connector) => ({
    connector,
    workspaceIds: workspaceIdsByConnector.get(connector.id) ?? new Set<string>()
  }));
}

function readinessEligibleConnectorScopes(
  data: BootstrapPayload | undefined,
  target: ReadinessTarget
): ReadinessConnectorScope[] {
  if (target.kind === "missing_thread" || target.kind === "unattached_thread") return [];
  return readinessConnectorScopes(data, target.workspaceId).filter((scope) => {
    if (
      scope.workspaceIds.size === 0 ||
      scope.connector.status !== "online" ||
      !scope.connector.capabilities.includes("codex_app_server_exec")
    ) {
      return false;
    }
    if (target.kind === "attached_thread") {
      return scope.connector.id === target.connectorId;
    }
    return scope.connector.capabilities.includes("app_server_threads");
  });
}

function readinessTarget(
  data: BootstrapPayload | undefined,
  selectedThreadId: string | undefined
): ReadinessTarget {
  if (!selectedThreadId) {
    return { kind: "workspace", workspaceId: localThreadWorkspaceId(data) };
  }
  const thread = data?.threads.find((item) => item.id === selectedThreadId);
  if (!thread) {
    return { kind: "missing_thread", threadId: selectedThreadId };
  }
  const session = attachedAppServerHostSession(data, selectedThreadId);
  if (!session) {
    return {
      kind: "unattached_thread",
      threadId: selectedThreadId,
      workspaceId: thread.workspace_id
    };
  }
  return {
    kind: "attached_thread",
    threadId: selectedThreadId,
    workspaceId: thread.workspace_id,
    connectorId: session.connector_id
  };
}

function readinessInstanceMatchesEligibleConnector(
  data: BootstrapPayload | undefined,
  instance: AppServerInstanceSummary,
  eligibleConnectorScopes: ReadinessConnectorScope[],
  selectedThreadId: string | undefined
): boolean {
  const scope = eligibleConnectorScopes.find((item) => item.connector.id === instance.connector_id);
  if (!scope) return false;
  if (instance.scope === "connector") return true;
  if (instance.scope === "workspace") return Boolean(instance.workspace_id && scope.workspaceIds.has(instance.workspace_id));
  if (!selectedThreadId) return false;
  if (instance.thread_id !== selectedThreadId) return false;
  const thread = data?.threads.find((item) => item.id === instance.thread_id);
  return Boolean(thread && scope.workspaceIds.has(thread.workspace_id));
}

function readinessWorkspaceLabel(data: BootstrapPayload | undefined, workspaceId: string | undefined): string {
  if (!workspaceId) return "the target workspace";
  return data?.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? workspaceId;
}

function readinessInventoryCheck(data: BootstrapPayload | undefined): ReadinessPreflightCheck {
  const reason = safetyActionReason(data, "host_session_refresh");
  if (reason) {
    return {
      id: "inventory",
      label: "Inventory sync",
      state: "attention",
      detail: `Broad Host Session refresh is blocked: ${reason}`
    };
  }
  return {
    id: "inventory",
    label: "Inventory sync",
    state: "ready",
    detail: "Passive preflight uses existing state only; broad Host Session refresh remains opt-in."
  };
}

function readinessNextAction(
  state: ReadinessPreflightState,
  checks: ReadinessPreflightCheck[]
): ReadinessPreflight["next_action"] {
  const blocked = checks.find((check) => check.state === "blocked");
  if (blocked?.id === "cost") {
    return {
      label: "Review Budget Board",
      href: "#budget-board",
      detail: "Clear the cost posture before starting an app-server turn."
    };
  }
  if (blocked?.id === "connector" || blocked?.id === "app_server") {
    return {
      label: "Open Host Sessions",
      href: "#host-sessions",
      detail: "Confirm connector and app-server state before attaching or creating a thread."
    };
  }
  if (state === "attention") {
    const attention = checks.find((check) => check.state === "attention");
    if (attention?.id === "cost") {
      return {
        label: "Review Budget Board",
        href: "#budget-board",
        detail: "Confirm the cost warning before starting daily dogfood work."
      };
    }
    return {
      label: "Open Host Sessions",
      href: "#host-sessions",
      detail: "Confirm the warning state before starting daily dogfood work."
    };
  }
  return {
    label: "Open Thread Centre",
    href: "#thread-centre",
    detail: "Create or select an app-server thread and send a bounded prompt."
  };
}

function readinessTitle(state: ReadinessPreflightState): string {
  if (state === "ready") return "Ready for app-server dogfood";
  if (state === "attention") return "Ready with operator attention";
  return "Not ready for app-server dogfood";
}

function readinessSummary(state: ReadinessPreflightState, checks: ReadinessPreflightCheck[]): string {
  if (state === "ready") {
    return "Cost, connector, and app-server state are aligned for a low-cost managed thread.";
  }
  const first = checks.find((check) => check.state === state) ?? checks.find((check) => check.state !== "ready");
  return first?.detail ?? "Readiness state needs attention.";
}

function budgetHasSampledHardConstraint(budget: BudgetSummary): boolean {
  if (budget.bottleneck_constraint && isSampledHardBudgetConstraint(budget.bottleneck_constraint)) return true;
  if (budget.constraints?.some(isSampledHardBudgetConstraint)) return true;
  if (budget.constraints || budget.constraint_sample_count !== undefined || budget.source === "empty") return false;
  return [budget.daily_used_pct, budget.four_hour_used_pct, budget.burst_used_pct].some(
    (value) => typeof value === "number" && Number.isFinite(value)
  );
}

function isSampledHardBudgetConstraint(constraint: BudgetConstraint): boolean {
  return constraint.hard && constraint.sampled && constraint.state !== "missing";
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
