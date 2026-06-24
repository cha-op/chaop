import type {
  AgentBackfillEvent,
  AgentAppServerInstance,
  AgentAppServerInstancesReport,
  AgentBootstrapRequest,
  AgentCommandEvent,
  AgentHostSessionsReport,
  AppServerInstanceSummary,
  AttachHostSessionResponse,
  BootstrapPayload,
  BudgetConstraint,
  BudgetD1Activity,
  BudgetD1WriteModel,
  BudgetState,
  BudgetSummary,
  BudgetTelemetryHistory,
  BudgetTelemetryPoint,
  BudgetTelemetrySlope,
  BudgetWindowSignal,
  BudgetWindowType,
  CommandDispatch,
  CommandTargetHostSession,
  CommandSummary,
  ConnectorSummary,
  CreateLocalThreadRequest,
  CreateLocalThreadResponse,
  CreateCommandRequest,
  CreateCommandResponse,
  DogfoodSafetyAction,
  DogfoodSafetyActionGuard,
  DogfoodSafetyPosture,
  AgentHostSession,
  DetachHostSessionResponse,
  HostSessionSummary,
  HostSessionSyncSummary,
  ResolveTurnInteractionRequest,
  TaskCategory,
  TaskSummary,
  ThreadEvent,
  TurnInteractionRequestPayload,
  TurnInteractionResponseDispatch,
  ThreadSummary,
  WorkspaceSummary
} from "@chaop/protocol";
import { taskCategories } from "./sample-data.js";
import type { Env } from "./types.js";
import type { BrowserIdentity } from "./auth.js";

const DEFAULT_WORKSPACE_ID = "workspace-api";
const DEFAULT_THREAD_ID = "thread-orders-500";
const DEFAULT_TASK_ID = "task-orders-500";
const APP_SERVER_UNCHANGED_SUMMARY_DEBOUNCE_MS = 15 * 60 * 1000;
const DEFAULT_TURN_INTERACTION_AUTO_RESOLUTION_RESPONSE_GRACE_MS = 250;
const TURN_INTERACTION_RESOLUTION_CLAIM_TTL_MS = 60_000;
const CLOUDFLARE_FREE_WORKER_REQUESTS_PER_DAY = 100_000;
const CLOUDFLARE_FREE_D1_ROWS_WRITTEN_PER_DAY = 100_000;
const CLOUDFLARE_FREE_D1_ROWS_READ_PER_DAY = 5_000_000;
const CLOUDFLARE_FREE_DURABLE_OBJECT_REQUESTS_PER_DAY = 100_000;
const D1_THREAD_SEQUENCE_UPDATE_ROWS = 2;
const D1_EVENT_INSERT_ROWS = 4;
const D1_USAGE_WINDOW_EXISTING_UPDATE_ROWS = 2;
const D1_USAGE_WINDOW_NEW_INSERT_ROWS = 4;
const D1_USAGE_WINDOW_COUNT = 3;
const D1_COMMAND_STATE_UPDATE_ROWS = 2;
const D1_TASK_STATE_UPDATE_ROWS = 4;
const D1_CONNECTOR_ACTIVITY_UPDATE_ROWS = 2;
const D1_STEADY_PERSISTED_EVENT_ROWS_WRITTEN =
  D1_THREAD_SEQUENCE_UPDATE_ROWS + D1_EVENT_INSERT_ROWS + D1_USAGE_WINDOW_COUNT * D1_USAGE_WINDOW_EXISTING_UPDATE_ROWS;
const D1_FIRST_EVENT_IN_MINUTE_ROWS_WRITTEN =
  D1_THREAD_SEQUENCE_UPDATE_ROWS
  + D1_EVENT_INSERT_ROWS
  + (D1_USAGE_WINDOW_COUNT - 1) * D1_USAGE_WINDOW_EXISTING_UPDATE_ROWS
  + D1_USAGE_WINDOW_NEW_INSERT_ROWS;
const D1_FIRST_EVENT_IN_FOUR_HOUR_ROWS_WRITTEN =
  D1_THREAD_SEQUENCE_UPDATE_ROWS
  + D1_EVENT_INSERT_ROWS
  + D1_USAGE_WINDOW_EXISTING_UPDATE_ROWS
  + 2 * D1_USAGE_WINDOW_NEW_INSERT_ROWS;
const D1_FIRST_EVENT_IN_DAY_ROWS_WRITTEN =
  D1_THREAD_SEQUENCE_UPDATE_ROWS + D1_EVENT_INSERT_ROWS + D1_USAGE_WINDOW_COUNT * D1_USAGE_WINDOW_NEW_INSERT_ROWS;
const D1_BACKFILL_ROWS_WRITTEN_PER_EVENT = D1_THREAD_SEQUENCE_UPDATE_ROWS + D1_EVENT_INSERT_ROWS;
const D1_BACKFILL_SAME_MINUTE_FIXED_ROWS_WRITTEN = D1_USAGE_WINDOW_COUNT * D1_USAGE_WINDOW_EXISTING_UPDATE_ROWS;
const D1_COMMAND_LIFECYCLE_WITHOUT_TASK_ROWS_WRITTEN =
  D1_STEADY_PERSISTED_EVENT_ROWS_WRITTEN + D1_COMMAND_STATE_UPDATE_ROWS + D1_CONNECTOR_ACTIVITY_UPDATE_ROWS;
const D1_COMMAND_LIFECYCLE_WITH_TASK_ROWS_WRITTEN =
  D1_COMMAND_LIFECYCLE_WITHOUT_TASK_ROWS_WRITTEN + D1_TASK_STATE_UPDATE_ROWS;
const D1_COMMAND_LIFECYCLE_DAY_BOUNDARY_ROWS_WRITTEN =
  D1_FIRST_EVENT_IN_DAY_ROWS_WRITTEN + D1_COMMAND_STATE_UPDATE_ROWS + D1_TASK_STATE_UPDATE_ROWS + D1_CONNECTOR_ACTIVITY_UPDATE_ROWS;
// Local guardrails include command lifecycle and daily-window boundary overhead so missing telemetry stays conservative.
const D1_BUDGETED_ROWS_WRITTEN_PER_EVENT = D1_COMMAND_LIFECYCLE_DAY_BOUNDARY_ROWS_WRITTEN;
const DEFAULT_DAILY_BUDGET_UNITS = Math.floor(CLOUDFLARE_FREE_D1_ROWS_WRITTEN_PER_DAY / D1_BUDGETED_ROWS_WRITTEN_PER_EVENT);
const DEFAULT_FOUR_HOUR_HARD_BUDGET_UNITS = Math.max(1, Math.floor(DEFAULT_DAILY_BUDGET_UNITS / 6));
const DEFAULT_FOUR_HOUR_SOFT_BUDGET_UNITS = Math.max(1, Math.ceil(DEFAULT_FOUR_HOUR_HARD_BUDGET_UNITS * 0.75));
const DEFAULT_BURST_EVENTS_PER_MINUTE = Math.max(
  1,
  Math.floor((CLOUDFLARE_FREE_D1_ROWS_WRITTEN_PER_DAY * 0.1) / D1_BUDGETED_ROWS_WRITTEN_PER_EVENT)
);
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const DEFAULT_CF_TELEMETRY_TIMEOUT_MS = 5_000;
const DEFAULT_CF_TELEMETRY_CACHE_SECONDS = 300;
const DEFAULT_CF_TELEMETRY_FAILURE_CACHE_SECONDS = 60;
const DEFAULT_BUDGET_TELEMETRY_SAMPLE_SECONDS = 300;
const DEFAULT_BUDGET_TELEMETRY_HISTORY_CACHE_SECONDS = 60;
const BUDGET_TELEMETRY_HISTORY_HOURS = 24;
const BUDGET_TELEMETRY_HISTORY_LIMIT = 300;
const DOGFOOD_SAFETY_PAUSE_KEY = "dogfood_safety.pause";
const CLOUDFLARE_GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const WS_INCOMING_MESSAGES_PER_DO_REQUEST = 20;
const BUDGET_STATE_RANK: Record<BudgetState, number> = {
  normal: 0,
  recovery: 1,
  conservative: 2,
  throttled: 3,
  hard_limited: 4
};

let cloudflareTelemetryCache: CloudflareTelemetryCacheEntry | undefined;
let cloudflareTelemetryDailyCache: CloudflareTelemetryCacheEntry | undefined;
let budgetTelemetryHistoryCache: BudgetTelemetryHistoryCacheEntry | undefined;

export class CommandTargetError extends Error {
  constructor(
    message: string,
    readonly status = 404
  ) {
    super(message);
  }
}

export class LocalThreadTargetError extends Error {
  readonly status = 404;
}

export class DogfoodSafetyError extends Error {
  readonly status = 429;

  constructor(
    message: string,
    readonly posture: DogfoodSafetyPosture,
    readonly guard: DogfoodSafetyActionGuard
  ) {
    super(message);
  }
}

export class NotFoundError extends Error {
  readonly status = 404;
}

type DogfoodSafetyPostureOptions = {
  refreshCloudflareTelemetry?: boolean | undefined;
};

export type RecordAgentEventResult = {
  accepted: boolean;
  dispatch_pending?: boolean;
  event?: ThreadEvent;
};

export async function loadBootstrapFromDb(
  env: Env,
  user: BrowserIdentity
): Promise<BootstrapPayload | undefined> {
  if (!env.DB) {
    return undefined;
  }

  const [
    connectors,
    workspaces,
    threads,
    hostSessions,
    hostSessionSyncs,
    appServerInstances,
    categories,
    tasks,
    runningCommands,
    events
  ] = await Promise.all([
    listConnectors(env),
    listWorkspaces(env),
    listThreads(env),
    listHostSessions(env),
    listHostSessionSyncs(env),
    listAppServerInstances(env),
    listTaskCategories(env),
    listTasks(env),
    listRecentCommands(env),
    listRecentEvents(env)
  ]);
  const budgetSummary = await loadBudgetSummaryFromDb(env, undefined, { connectors, tasks });
  const safetyGeneratedAt = budgetSummary.generated_at ?? new Date().toISOString();
  const safety = dogfoodSafetyPosture({
    generatedAt: safetyGeneratedAt,
    paused: await loadDogfoodSafetyPause(env, safetyGeneratedAt),
    constraints: budgetSummary.constraints ?? [],
    budgetStates: [budgetSummary.state]
  });

  return {
    user,
    connectors,
    workspaces,
    threads,
    host_sessions: hostSessions,
    host_session_syncs: hostSessionSyncs,
    app_server_instances: appServerInstances,
    task_categories: categories,
    tasks,
    running_commands: runningCommands,
    events,
    budget: budgetSummary,
    safety,
    server_time: new Date().toISOString()
  };
}

export async function loadBudgetSummaryFromDb(
  env: Env,
  generatedAt = new Date().toISOString(),
  snapshots: { connectors?: ConnectorSummary[] | undefined; tasks?: TaskSummary[] | undefined } = {}
): Promise<BudgetSummary> {
  if (!env.DB) {
    return emptyBudgetSummary(generatedAt);
  }

  const [daily, fourHour, burst, connectorStates, taskStates, liveTelemetry, persistedTelemetry] = await Promise.all([
    currentUsageWindow(env, "daily", generatedAt),
    currentUsageWindow(env, "four_hour", generatedAt),
    currentUsageWindow(env, "burst", generatedAt),
    snapshots.connectors
      ? Promise.resolve(connectorBudgetStateCounts(snapshots.connectors))
      : listConnectorBudgetStates(env),
    snapshots.tasks
      ? Promise.resolve(taskBudgetStateCounts(snapshots.tasks))
      : listTaskBudgetStates(env),
    loadCloudflareTelemetryBestEffort(env, generatedAt),
    loadMaxPersistedCloudflareTelemetrySample(env, generatedAt)
  ]);
  const telemetry = mergeCloudflareTelemetrySamples(liveTelemetry, persistedTelemetry);
  const windows = [daily, fourHour, burst].filter((row): row is UsageWindowRow => row !== undefined);
  const primaryWindow = daily ?? fourHour ?? burst;
  const windowSignals = windows.map((window) => budgetWindowSignalFromRow(env, window));
  const localBaselines = localBudgetWindowBaselines(env, generatedAt);
  const telemetrySampleInserted = await persistBudgetTelemetrySampleBestEffort(env, liveTelemetry, generatedAt);
  const telemetryHistory = await loadBudgetTelemetryHistoryBestEffort(env, generatedAt, {
    force: telemetrySampleInserted
  });
  const constraints = budgetConstraints(env, windowSignals, telemetry, localBaselines);
  const bottleneckConstraint = budgetBottleneckConstraint(constraints);
  const d1Activity = budgetD1ActivitySignals(env, generatedAt, daily, telemetry);
  const constraintStates = constraints
    .filter((constraint) => constraint.sampled && constraint.hard && constraint.state !== "missing")
    .map((constraint) => constraint.state as BudgetState);
  const states = [
    ...constraintStates,
    ...connectorStates.map((row) => budgetStateFromString(row.budget_state)),
    ...taskStates.map((row) => budgetStateFromString(row.budget_state))
  ];

  return {
    state: worstBudgetState(states),
    daily_used_pct: windowPct(env, daily),
    four_hour_used_pct: windowPct(env, fourHour) ?? localBaselines.get("four_hour")?.used_pct ?? null,
    burst_used_pct: windowPct(env, burst) ?? localBaselines.get("burst")?.used_pct ?? null,
    delayed_event_count: nonNegativeInteger(primaryWindow?.events_delayed),
    compacted_event_count: nonNegativeInteger(primaryWindow?.events_compacted),
    local_spool_bytes: nonNegativeInteger(primaryWindow?.local_spool_bytes),
    source: windows.length > 0 ? "d1_usage_windows" : telemetry ? "cloudflare_analytics" : "empty",
    generated_at: generatedAt,
    window_sample_count: windows.length,
    constraint_sample_count: constraints.filter((constraint) => constraint.sampled).length,
    windows: windowSignals,
    constraints,
    bottleneck_constraint: bottleneckConstraint,
    d1_write_model: budgetD1WriteModel(env),
    telemetry_history: telemetryHistory,
    d1_activity: d1Activity
  };
}

export async function loadDogfoodSafetyPostureFromDb(
  env: Env,
  generatedAt = new Date().toISOString(),
  snapshots: { connectors?: ConnectorSummary[] | undefined; tasks?: TaskSummary[] | undefined } = {},
  options: DogfoodSafetyPostureOptions = {}
): Promise<DogfoodSafetyPosture> {
  const effectiveGeneratedAt = generatedAt ?? new Date().toISOString();
  if (!env.DB) {
    return dogfoodSafetyPosture({
      generatedAt: effectiveGeneratedAt,
      paused: undefined,
      constraints: budgetConstraints({}, [], undefined, localBudgetWindowBaselines({}, effectiveGeneratedAt))
    });
  }

  const liveTelemetryPromise = options.refreshCloudflareTelemetry
    ? loadCloudflareTelemetryBestEffort(env, effectiveGeneratedAt)
    : loadCachedCloudflareTelemetryBestEffort(env, effectiveGeneratedAt);
  const persistedTelemetryPromise = loadMaxPersistedCloudflareTelemetrySample(env, effectiveGeneratedAt);
  const [pause, daily, fourHour, burst, connectorStates, taskStates, liveTelemetry, persistedTelemetry] = await Promise.all([
    loadDogfoodSafetyPause(env, effectiveGeneratedAt),
    currentUsageWindow(env, "daily", effectiveGeneratedAt),
    currentUsageWindow(env, "four_hour", effectiveGeneratedAt),
    currentUsageWindow(env, "burst", effectiveGeneratedAt),
    snapshots.connectors
      ? Promise.resolve(connectorBudgetStateCounts(snapshots.connectors))
      : listConnectorBudgetStates(env),
    snapshots.tasks
      ? Promise.resolve(taskBudgetStateCounts(snapshots.tasks))
      : listTaskBudgetStates(env),
    liveTelemetryPromise,
    persistedTelemetryPromise
  ]);
  const telemetry = mergeCloudflareTelemetrySamples(liveTelemetry, persistedTelemetry);
  if (options.refreshCloudflareTelemetry) {
    await persistBudgetTelemetrySampleBestEffort(env, liveTelemetry, effectiveGeneratedAt);
  }
  const windows = [daily, fourHour, burst].filter((row): row is UsageWindowRow => row !== undefined);
  const windowSignals = windows.map((window) => budgetWindowSignalFromRow(env, window));
  const constraints = budgetConstraints(
    env,
    windowSignals,
    telemetry,
    localBudgetWindowBaselines(env, effectiveGeneratedAt)
  );
  return dogfoodSafetyPosture({
    generatedAt: effectiveGeneratedAt,
    paused: pause,
    constraints,
    budgetStates: [
      ...connectorStates.map((row) => budgetStateFromString(row.budget_state)),
      ...taskStates.map((row) => budgetStateFromString(row.budget_state))
    ]
  });
}

export async function setDogfoodSafetyPauseInDb(
  env: Env,
  paused: boolean,
  actor: BrowserIdentity,
  reason?: string | undefined,
  generatedAt = new Date().toISOString()
): Promise<DogfoodSafetyPosture> {
  if (!env.DB) {
    return dogfoodSafetyPosture({
      generatedAt,
      paused: paused
        ? {
          paused: true,
          reason: boundedSafetyReason(reason),
          updated_by: actor.email,
          updated_at: generatedAt
        }
        : undefined,
      constraints: budgetConstraints({}, [], undefined, localBudgetWindowBaselines({}, generatedAt))
    });
  }

  if (paused) {
    await env.DB.prepare(
      `INSERT INTO control_plane_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    )
      .bind(
        DOGFOOD_SAFETY_PAUSE_KEY,
        JSON.stringify({
          paused: true,
          reason: boundedSafetyReason(reason),
          updated_by: actor.email,
          updated_at: generatedAt
        }),
        generatedAt
      )
      .run();
  } else {
    await env.DB.prepare("DELETE FROM control_plane_settings WHERE key = ?")
      .bind(DOGFOOD_SAFETY_PAUSE_KEY)
      .run();
  }

  return loadDogfoodSafetyPostureFromDb(env, generatedAt);
}

export async function assertDogfoodSafetyActionAllowed(
  env: Env,
  action: DogfoodSafetyAction,
  generatedAt = new Date().toISOString()
): Promise<DogfoodSafetyPosture> {
  const posture = await loadDogfoodSafetyPostureFromDb(env, generatedAt);
  const guard = posture.actions.find((item) => item.action === action);
  if (guard?.state === "blocked") {
    throw new DogfoodSafetyError(guard.reason, posture, guard);
  }
  return posture;
}

export async function dogfoodSafetyActionAllowed(
  env: Env,
  action: DogfoodSafetyAction,
  generatedAt = new Date().toISOString()
): Promise<boolean> {
  try {
    await assertDogfoodSafetyActionAllowed(env, action, generatedAt);
    return true;
  } catch (error) {
    if (error instanceof DogfoodSafetyError) return false;
    throw error;
  }
}

export async function bootstrapBudgetWindowsInDb(
  env: Env,
  generatedAt = new Date().toISOString()
): Promise<BudgetSummary> {
  if (!env.DB) {
    return emptyBudgetSummary(generatedAt);
  }

  const timestamp = new Date(generatedAt);
  const effectiveTimestamp = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
  const updatedAt = effectiveTimestamp.toISOString();
  const zeroMetrics: UsageEventMetrics = {
    eventsReceived: 0,
    compacted: 0,
    delayed: 0,
    spoolBytes: 0
  };

  for (const window of usageWindowSpecs(env, effectiveTimestamp)) {
    await upsertUsageWindow(env, window, zeroMetrics, updatedAt);
  }

  return loadBudgetSummaryFromDb(env, updatedAt);
}

export type RecordAppServerInstancesResult = {
  app_server_instances: AppServerInstanceSummary[];
  synced_at: string;
  snapshot: boolean;
};

export async function recordAppServerInstances(
  env: Env,
  connectorId: string,
  report: AgentAppServerInstancesReport,
  syncedAt = new Date().toISOString()
): Promise<RecordAppServerInstancesResult> {
  if (!env.DB) return { app_server_instances: [], synced_at: syncedAt, snapshot: report.snapshot === true };

  const connector = await env.DB.prepare(
    `SELECT id
     FROM connectors
     WHERE id = ?
     LIMIT 1`
  )
    .bind(connectorId)
    .first<{ id: string }>();
  if (!connector) return { app_server_instances: [], synced_at: syncedAt, snapshot: report.snapshot === true };

  const persisted: AppServerInstanceSummary[] = [];
  const reportedIdentities = new Set<string>();
  for (const instance of report.instances) {
    const placementKey = appServerInstancePlacementKey(instance);
    reportedIdentities.add(appServerInstanceIdentityKey(instance.instance_key, placementKey));
    const fingerprint = appServerInstanceFingerprint(instance);
    const existing = await env.DB.prepare(
      `SELECT id, connector_id, instance_key, scope, workspace_id, thread_id, placement_key,
              endpoint_type, state,
              active_turn_count, generation, status_summary, last_error,
              report_fingerprint, last_seen_at, state_changed_at,
              summary_changed_at, created_at, updated_at
       FROM app_server_instances
       WHERE connector_id = ? AND instance_key = ? AND placement_key = ?
       LIMIT 1`
    )
      .bind(connectorId, instance.instance_key, placementKey)
      .first<AppServerInstanceRow>();
    const shouldPersist = shouldPersistAppServerInstance(existing, instance, fingerprint, syncedAt);
    if (!shouldPersist) continue;

    const id = existing?.id ?? appServerInstanceId(connectorId, instance.instance_key, placementKey);
    const stateChangedAt = existing && existing.state === instance.state
      ? existing.state_changed_at
      : syncedAt;
    const summaryChangedAt = existing && existing.report_fingerprint === fingerprint
      ? existing.summary_changed_at
      : syncedAt;
    await env.DB.prepare(
      `INSERT INTO app_server_instances (
         id, connector_id, instance_key, scope, workspace_id, thread_id,
         placement_key, endpoint_type, state,
         active_turn_count, generation, status_summary, last_error,
         report_fingerprint, last_seen_at, state_changed_at, summary_changed_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connector_id, instance_key, placement_key) DO UPDATE SET
         scope = excluded.scope,
         workspace_id = excluded.workspace_id,
         thread_id = excluded.thread_id,
         placement_key = excluded.placement_key,
         endpoint_type = excluded.endpoint_type,
         state = excluded.state,
         active_turn_count = excluded.active_turn_count,
         generation = excluded.generation,
         status_summary = excluded.status_summary,
         last_error = excluded.last_error,
         report_fingerprint = excluded.report_fingerprint,
         last_seen_at = excluded.last_seen_at,
         state_changed_at = excluded.state_changed_at,
         summary_changed_at = excluded.summary_changed_at,
         updated_at = excluded.updated_at`
    )
      .bind(
        id,
        connectorId,
        instance.instance_key,
        instance.scope,
        instance.workspace_id ?? null,
        instance.thread_id ?? null,
        placementKey,
        instance.endpoint_type,
        instance.state,
        instance.active_turn_count ?? 0,
        instance.generation ?? 0,
        instance.status_summary ?? null,
        instance.last_error ?? null,
        fingerprint,
        syncedAt,
        stateChangedAt,
        summaryChangedAt,
        existing?.created_at ?? syncedAt,
        syncedAt
      )
      .run();

    const row = await env.DB.prepare(
      `SELECT id, connector_id, instance_key, scope, workspace_id, thread_id, placement_key,
              endpoint_type, state,
              active_turn_count, generation, status_summary, last_error,
              last_seen_at, state_changed_at, updated_at
       FROM app_server_instances
       WHERE connector_id = ? AND instance_key = ? AND placement_key = ?
       LIMIT 1`
    )
      .bind(connectorId, instance.instance_key, placementKey)
      .first<AppServerInstanceRow>();
    if (row) persisted.push(appServerInstanceFromRow(row));
  }

  if (report.snapshot === true) {
    const omitted = await allRows<AppServerInstanceRow>(
      env.DB.prepare(
        `SELECT id, connector_id, instance_key, scope, workspace_id, thread_id, placement_key,
                endpoint_type, state,
                active_turn_count, generation, status_summary, last_error,
                report_fingerprint, last_seen_at, state_changed_at,
                summary_changed_at, created_at, updated_at
         FROM app_server_instances
         WHERE connector_id = ?
           AND state <> 'stopped'`
      ).bind(connectorId)
    );
    for (const row of omitted) {
      if (reportedIdentities.has(appServerInstanceIdentityKey(row.instance_key, row.placement_key))) continue;
      persisted.push(
        await stopAppServerInstanceRow(
          env,
          row,
          "Instance was omitted from the latest connector snapshot.",
          syncedAt
        )
      );
    }
  }

  if (report.snapshot === true && (persisted.length > 0 || report.instances.length > 0)) {
    return {
      app_server_instances: await listAppServerInstancesForConnector(env, connectorId),
      synced_at: syncedAt,
      snapshot: true
    };
  }

  return { app_server_instances: persisted, synced_at: syncedAt, snapshot: report.snapshot === true };
}

export async function markAppServerInstancesStoppedForConnector(
  env: Env,
  connectorId: string,
  syncedAt = new Date().toISOString()
): Promise<AppServerInstanceSummary[]> {
  if (!env.DB) return [];

  const rows = await allRows<AppServerInstanceRow>(
    env.DB.prepare(
      `SELECT id, connector_id, instance_key, scope, workspace_id, thread_id, placement_key,
              endpoint_type, state,
              active_turn_count, generation, status_summary, last_error,
              report_fingerprint, last_seen_at, state_changed_at,
              summary_changed_at, created_at, updated_at
       FROM app_server_instances
       WHERE connector_id = ?
         AND state <> 'stopped'`
    ).bind(connectorId)
  );

  const stopped: AppServerInstanceSummary[] = [];
  for (const row of rows) {
    stopped.push(
      await stopAppServerInstanceRow(
        env,
        row,
        "Connector went offline before reporting app-server state.",
        syncedAt
      )
    );
  }
  return stopped;
}

export async function recordHostSessions(
  env: Env,
  connectorId: string,
  report: AgentHostSessionsReport,
  syncedAt = new Date().toISOString(),
  options: { workspaceId?: string | undefined } = {}
): Promise<{
  host_sessions: HostSessionSummary[];
  synced_at: string;
  released_connector_ids: string[];
  failed_events: ThreadEvent[];
  snapshot: boolean;
}> {
  if (!env.DB) {
    return {
      host_sessions: [],
      synced_at: syncedAt,
      released_connector_ids: [],
      failed_events: [],
      snapshot: false
    };
  }

  const connector = await env.DB.prepare(
    `SELECT hostname
     FROM connectors
     WHERE id = ?
     LIMIT 1`
  )
    .bind(connectorId)
    .first<{ hostname: string }>();
  if (!connector) {
    return {
      host_sessions: [],
      synced_at: syncedAt,
      released_connector_ids: [],
      failed_events: [],
      snapshot: false
    };
  }

  const workspace = await env.DB.prepare(
    `SELECT workspace_id
     FROM workspace_connectors
     WHERE connector_id = ?
     ORDER BY last_indexed_at DESC
     LIMIT 1`
  )
    .bind(connectorId)
    .first<{ workspace_id: string }>();
  const workspaceId = options.workspaceId ?? workspace?.workspace_id ?? DEFAULT_WORKSPACE_ID;
  const upserted: HostSessionSummary[] = [];
  const storedReportedSessions: HostSessionSummary[] = [];
  let storedReportedSessionCount = 0;
  const releasedConnectorIds = new Set<string>();
  const failedEvents: ThreadEvent[] = [];
  const reportedSessions = report.sessions.slice(0, 200);
  const reportedSessionIds = new Set(reportedSessions.map((session) => session.session_id));
  const inventoryScope = report.inventory_scope ?? "incremental";
  const canClearMissingAppServerSessions =
    inventoryScope === "full" &&
    report.app_server_inventory_ok === true &&
    reportedSessions.length === report.sessions.length;
  const canUseAppServerAbsence = inventoryScope === "full" && report.app_server_inventory_ok === true;

  for (const session of reportedSessions) {
    const id = hostSessionId(connectorId, session.session_id);
    const previous = await findHostSession(env, session.session_id, connectorId);
    const reportedAppServerPresent = agentHostSessionAppServerPresent(session);
    const appServerPresent =
      !reportedAppServerPresent && !canUseAppServerAbsence && previous?.app_server_present === true
        ? 1
        : reportedAppServerPresent ? 1 : 0;
    const result = await env.DB.prepare(
      `INSERT INTO host_sessions (
         id, connector_id, hostname, workspace_id, session_id, title, title_source, app_server_present,
         cwd, discovered_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connector_id, session_id) DO UPDATE SET
         hostname = excluded.hostname,
         workspace_id = CASE
           WHEN host_sessions.attached_task_id IS NOT NULL OR host_sessions.attached_thread_id IS NOT NULL
           THEN host_sessions.workspace_id
           ELSE excluded.workspace_id
         END,
         title = excluded.title,
         title_source = excluded.title_source,
         app_server_present = excluded.app_server_present,
         cwd = excluded.cwd,
         updated_at = excluded.updated_at
       WHERE host_sessions.hostname IS NOT excluded.hostname
          OR host_sessions.workspace_id IS NOT (
            CASE
              WHEN host_sessions.attached_task_id IS NOT NULL OR host_sessions.attached_thread_id IS NOT NULL
              THEN host_sessions.workspace_id
              ELSE excluded.workspace_id
            END
          )
          OR host_sessions.title IS NOT excluded.title
          OR host_sessions.title_source IS NOT excluded.title_source
          OR host_sessions.app_server_present IS NOT excluded.app_server_present
          OR host_sessions.cwd IS NOT excluded.cwd
          OR host_sessions.updated_at IS NOT excluded.updated_at`
    )
      .bind(
        id,
        connectorId,
        connector.hostname,
        workspaceId,
        session.session_id,
        session.title,
        session.title_source,
        appServerPresent,
        session.cwd ?? null,
        syncedAt,
        session.updated_at
      )
      .run();
    if (!((result.meta as { changes?: number } | undefined)?.changes)) {
      if (previous) {
        storedReportedSessionCount += 1;
        storedReportedSessions.push(previous);
      }
      continue;
    }
    const stored = await findHostSession(env, session.session_id, connectorId);
    if (stored) {
      storedReportedSessionCount += 1;
      storedReportedSessions.push(stored);
      upserted.push(stored);
      if (
        previous?.app_server_present === true &&
        stored.app_server_present !== true &&
        (stored.attached_task_id || stored.attached_thread_id)
      ) {
        await cleanupUnavailableAppServerHostSession(env, stored, syncedAt, releasedConnectorIds, failedEvents);
      }
    }
  }

  if (canClearMissingAppServerSessions) {
    const staleAppServerOnlySessions = await allRows<HostSessionRow>(
      env.DB.prepare(
        `SELECT hs.id, hs.connector_id, hs.hostname, hs.workspace_id, hs.session_id, hs.title, hs.title_source,
          hs.app_server_present, hs.cwd, hs.updated_at, hs.attached_task_id, hs.attached_thread_id
         FROM host_sessions hs
         INNER JOIN connectors c ON c.id = hs.connector_id
         WHERE hs.connector_id = ?
           AND hs.app_server_present = 1
           AND c.status <> 'offline'`
      ).bind(connectorId)
    );
    for (const row of staleAppServerOnlySessions) {
      if (reportedSessionIds.has(row.session_id)) {
        continue;
      }
      const result = await env.DB.prepare(
        `UPDATE host_sessions
         SET app_server_present = 0, updated_at = ?
         WHERE id = ?
           AND app_server_present = 1`
      )
        .bind(syncedAt, row.id)
        .run();
      if (!((result.meta as { changes?: number } | undefined)?.changes)) {
        continue;
      }
      const demoted = hostSessionFromRow({
        ...row,
        app_server_present: 0,
        updated_at: syncedAt
      });
      upserted.push(demoted);
      if (demoted.attached_task_id || demoted.attached_thread_id) {
        await cleanupUnavailableAppServerHostSession(env, demoted, syncedAt, releasedConnectorIds, failedEvents);
      }
    }
  }

  await env.DB.prepare(
    `INSERT INTO host_session_syncs (
       connector_id, synced_at, reported_session_count, stored_session_count
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(connector_id) DO UPDATE SET
       synced_at = excluded.synced_at,
       reported_session_count = excluded.reported_session_count,
       stored_session_count = excluded.stored_session_count`
  )
    .bind(connectorId, syncedAt, reportedSessions.length, storedReportedSessionCount)
    .run();

  await env.DB.prepare(
    `UPDATE connectors
     SET last_seen_at = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(syncedAt, syncedAt, connectorId)
    .run();

  return {
    host_sessions: inventoryScope === "full"
      ? [...storedReportedSessions, ...upserted.filter((session) => !reportedSessionIds.has(session.session_id))]
      : upserted,
    synced_at: syncedAt,
    released_connector_ids: [...releasedConnectorIds],
    failed_events: failedEvents,
    snapshot: canClearMissingAppServerSessions
  };
}

export async function markHostSessionAppServerPresentInDb(
  env: Env,
  hostSession: HostSessionSummary,
  updatedAt = new Date().toISOString()
): Promise<void> {
  if (!env.DB || hostSession.app_server_present === true) return;

  await env.DB.prepare(
    `UPDATE host_sessions
     SET app_server_present = 1, updated_at = ?
     WHERE id = ?
       AND app_server_present <> 1`
  )
    .bind(updatedAt, hostSession.id)
    .run();
}

async function cleanupUnavailableAppServerHostSession(
  env: Env,
  hostSession: HostSessionSummary,
  now: string,
  releasedConnectorIds: Set<string>,
  failedEvents: ThreadEvent[]
): Promise<void> {
  const released = await releaseCommandsForDetachedAppServerHostSession(env, hostSession, now);
  for (const releasedConnectorId of released) {
    releasedConnectorIds.add(releasedConnectorId);
  }
  failedEvents.push(...await failCommandsForDetachedAppServerHostSession(env, hostSession, now));
}

export async function archiveTaskInDb(env: Env, taskId: string): Promise<TaskSummary> {
  const task = await loadTask(env, taskId);
  if (!task) {
    throw new NotFoundError("Task not found");
  }

  const now = new Date().toISOString();
  await env.DB!.prepare(
    `UPDATE tasks
     SET archived_at = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(now, now, task.id)
    .run();
  await env.DB!.prepare(
    `UPDATE threads
     SET state = 'archived', updated_at = ?
     WHERE id = ?`
  )
    .bind(now, task.thread_id)
    .run();

  return {
    ...task,
    archived_at: now,
    updated_at: now
  };
}

export async function unarchiveTaskInDb(env: Env, taskId: string): Promise<TaskSummary> {
  const task = await loadTask(env, taskId);
  if (!task) {
    throw new NotFoundError("Task not found");
  }

  const now = new Date().toISOString();
  const threadState = task.state === "running" ? "active" : "idle";
  await env.DB!.prepare(
    `UPDATE tasks
     SET archived_at = NULL, updated_at = ?
     WHERE id = ?`
  )
    .bind(now, task.id)
    .run();
  await env.DB!.prepare(
    `UPDATE threads
     SET state = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(threadState, now, task.thread_id)
    .run();

  return {
    ...task,
    archived_at: undefined,
    updated_at: now
  };
}

export async function attachHostSessionInDb(
  env: Env,
  sessionId: string,
  connectorId?: string
): Promise<AttachHostSessionResponse & { attachment_created: boolean }> {
  if (!env.DB) {
    throw new Error("DB binding is required for host session attachment");
  }

  const hostSession = await findHostSession(env, sessionId, connectorId);
  if (!hostSession) {
    throw new NotFoundError("Host session not found");
  }

  if (hostSession.attached_task_id && hostSession.attached_thread_id) {
    const [task, thread] = await Promise.all([
      loadTask(env, hostSession.attached_task_id),
      loadThread(env, hostSession.attached_thread_id)
    ]);
    if (task && thread) {
      return { host_session: hostSession, task, thread, attachment_created: false };
    }
  }

  const now = new Date().toISOString();
  const threadId = stableScopedId("thread-host", hostSession.connector_id, hostSession.session_id);
  const taskId = stableScopedId("task-host", hostSession.connector_id, hostSession.session_id);

  await env.DB.prepare(
    `INSERT INTO threads (id, workspace_id, title, state, realtime_mode, last_seq, created_at, updated_at)
     VALUES (?, ?, ?, 'idle', 'realtime', 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       state = CASE WHEN state = 'archived' THEN state ELSE 'idle' END,
       realtime_mode = excluded.realtime_mode,
       updated_at = excluded.updated_at`
  )
    .bind(threadId, hostSession.workspace_id, hostSession.title, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO tasks (
       id, workspace_id, thread_id, title, category_id, state, connector_id,
       assigned_agent, realtime_mode, budget_state, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'maintenance', 'idle', ?, 'chaop-agent', 'realtime', 'normal', NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       thread_id = excluded.thread_id,
       title = excluded.title,
       connector_id = excluded.connector_id,
       assigned_agent = excluded.assigned_agent,
       realtime_mode = excluded.realtime_mode,
       budget_state = excluded.budget_state,
       archived_at = NULL,
       updated_at = excluded.updated_at`
  )
    .bind(taskId, hostSession.workspace_id, threadId, hostSession.title, hostSession.connector_id, now, now)
    .run();

  await env.DB.prepare(
    `UPDATE host_sessions
     SET attached_task_id = ?, attached_thread_id = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(taskId, threadId, now, hostSession.id)
    .run();

  const [task, thread] = await Promise.all([loadTask(env, taskId), loadThread(env, threadId)]);
  if (!task || !thread) {
    throw new NotFoundError("Attached task or thread not found");
  }

  return {
    host_session: {
      ...hostSession,
      attached_task_id: taskId,
      attached_thread_id: threadId,
      updated_at: now
    },
    task,
    thread,
    attachment_created: true
  };
}

export async function loadHostSessionInDb(
  env: Env,
  sessionId: string,
  connectorId?: string
): Promise<HostSessionSummary | undefined> {
  if (!env.DB) {
    throw new Error("DB binding is required for host session lookup");
  }
  return findHostSession(env, sessionId, connectorId);
}

export async function hasLiveHostSessionAttachmentInDb(
  env: Env,
  hostSession: HostSessionSummary
): Promise<boolean> {
  if (!env.DB) {
    throw new Error("DB binding is required for host session attachment lookup");
  }
  if (!hostSession.attached_task_id || !hostSession.attached_thread_id) {
    return false;
  }
  const [task, thread] = await Promise.all([
    loadTask(env, hostSession.attached_task_id),
    loadThread(env, hostSession.attached_thread_id)
  ]);
  return Boolean(task && thread);
}

export async function detachHostSessionInDb(
  env: Env,
  sessionId: string,
  connectorId?: string
): Promise<DetachHostSessionResponse & { released_connector_ids?: string[]; failed_events?: ThreadEvent[] }> {
  if (!env.DB) {
    throw new Error("DB binding is required for host session detachment");
  }

  const hostSession = await findHostSession(env, sessionId, connectorId);
  if (!hostSession) {
    throw new NotFoundError("Host session not found");
  }

  if (!hostSession.attached_task_id && !hostSession.attached_thread_id) {
    return { host_session: hostSession };
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE host_sessions
     SET attached_task_id = NULL, attached_thread_id = NULL, updated_at = ?
     WHERE id = ?`
  )
    .bind(now, hostSession.id)
    .run();
  const releasedConnectorIds = await releaseCommandsForDetachedAppServerHostSession(env, hostSession, now);
  const failedEvents = await failCommandsForDetachedAppServerHostSession(env, hostSession, now);

  return {
    host_session: {
      ...hostSession,
      attached_task_id: undefined,
      attached_thread_id: undefined,
      updated_at: now
    },
    released_connector_ids: releasedConnectorIds,
    failed_events: failedEvents
  };
}

async function releaseCommandsForDetachedAppServerHostSession(
  env: Env,
  hostSession: HostSessionSummary,
  now: string
): Promise<string[]> {
  const taskId = hostSession.attached_task_id ?? null;
  const threadId = hostSession.attached_thread_id ?? null;
  if (!taskId && !threadId) {
    return [];
  }

  const result = await env.DB!.prepare(
    `UPDATE commands
     SET state = 'pending',
         target_connector_id = CASE WHEN target_connector_id_source = 'attached' THEN NULL ELSE target_connector_id END,
         target_connector_id_source = CASE WHEN target_connector_id_source = 'attached' THEN 'auto' ELSE target_connector_id_source END,
         lease_owner_connector_id = NULL,
         lease_until = NULL,
         lease_target_host_session_id = (
           SELECT hs.session_id
           FROM host_sessions hs
           WHERE hs.id = COALESCE(
             (
               SELECT hs_task.id
               FROM host_sessions hs_task
               WHERE hs_task.workspace_id = commands.workspace_id
                 AND commands.task_id IS NOT NULL
                 AND hs_task.attached_task_id = commands.task_id
                 AND (hs_task.connector_id <> ? OR hs_task.session_id <> ?)
               ORDER BY hs_task.updated_at DESC, hs_task.id DESC
               LIMIT 1
             ),
             (
               SELECT hs_thread.id
               FROM host_sessions hs_thread
               WHERE hs_thread.workspace_id = commands.workspace_id
                 AND commands.thread_id IS NOT NULL
                 AND hs_thread.attached_thread_id = commands.thread_id
                 AND (hs_thread.connector_id <> ? OR hs_thread.session_id <> ?)
                 AND (
                   commands.task_id IS NULL
                   OR NOT EXISTS (
                     SELECT 1
                     FROM host_sessions hst
                     WHERE hst.workspace_id = commands.workspace_id
                       AND hst.attached_task_id = commands.task_id
                       AND (hst.connector_id <> ? OR hst.session_id <> ?)
                   )
                 )
               ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
               LIMIT 1
             )
           )
         ),
         updated_at = ?
     WHERE workspace_id = ?
       AND type = 'codex'
       AND COALESCE(execution_mode, '') <> 'codex_cli_fallback'
       AND (target_connector_id = ? OR target_connector_id IS NULL)
       AND (
         (
           state = 'pending'
           AND lease_target_host_session_id = ?
         )
         OR (
           state = 'leased'
           AND lease_owner_connector_id = ?
           AND (
             lease_target_host_session_id = ?
             OR lease_target_host_session_id IS NULL
           )
         )
       )
       AND (
         (? IS NOT NULL AND task_id = ?)
         OR (? IS NOT NULL AND thread_id = ?)
       )
       AND EXISTS (
         SELECT 1
         FROM host_sessions hs
         INNER JOIN connectors c ON c.id = hs.connector_id
         INNER JOIN workspace_connectors wc
           ON wc.workspace_id = commands.workspace_id
          AND wc.connector_id = hs.connector_id
         WHERE hs.id = COALESCE(
           (
             SELECT hs_task.id
             FROM host_sessions hs_task
             WHERE hs_task.workspace_id = commands.workspace_id
               AND commands.task_id IS NOT NULL
               AND hs_task.attached_task_id = commands.task_id
               AND (hs_task.connector_id <> ? OR hs_task.session_id <> ?)
             ORDER BY hs_task.updated_at DESC, hs_task.id DESC
             LIMIT 1
           ),
           (
             SELECT hs_thread.id
             FROM host_sessions hs_thread
             WHERE hs_thread.workspace_id = commands.workspace_id
               AND commands.thread_id IS NOT NULL
               AND hs_thread.attached_thread_id = commands.thread_id
               AND (hs_thread.connector_id <> ? OR hs_thread.session_id <> ?)
               AND (
                 commands.task_id IS NULL
                 OR NOT EXISTS (
                   SELECT 1
                   FROM host_sessions hst
                   WHERE hst.workspace_id = commands.workspace_id
                     AND hst.attached_task_id = commands.task_id
                     AND (hst.connector_id <> ? OR hst.session_id <> ?)
                 )
               )
             ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
             LIMIT 1
           )
         )
           AND hs.app_server_present = 1
           AND wc.can_execute = 1
           AND c.status = 'online'
           AND c.capabilities_json LIKE '%"codex_app_server_exec"%'
           AND (
             commands.target_connector_id_source = 'attached'
             OR commands.target_connector_id IS NULL
             OR hs.connector_id = commands.target_connector_id
           )
      )`
    )
    .bind(
      hostSession.connector_id,
      hostSession.session_id,
      hostSession.connector_id,
      hostSession.session_id,
      hostSession.connector_id,
      hostSession.session_id,
      now,
      hostSession.workspace_id,
      hostSession.connector_id,
      hostSession.session_id,
      hostSession.connector_id,
      hostSession.session_id,
      taskId,
      taskId,
      threadId,
      threadId,
      hostSession.connector_id,
      hostSession.session_id,
      hostSession.connector_id,
      hostSession.session_id,
      hostSession.connector_id,
      hostSession.session_id
    )
    .run();

  if (!(result.meta as { changes?: number } | undefined)?.changes) {
    return [];
  }

  await updateConnectorActivity(env, hostSession.connector_id);
  return executableAppServerConnectorIdsForWorkspace(env, hostSession.workspace_id);
}

async function executableAppServerConnectorIdsForWorkspace(
  env: Env,
  workspaceId: string
): Promise<string[]> {
  const rows = await allRows<{ connector_id: string }>(
    env.DB!.prepare(
      `SELECT DISTINCT c.id AS connector_id
       FROM connectors c
       INNER JOIN workspace_connectors wc
         ON wc.connector_id = c.id
       WHERE wc.workspace_id = ?
         AND wc.can_execute = 1
         AND c.status = 'online'
         AND c.capabilities_json LIKE '%"codex_app_server_exec"%'`
    ).bind(workspaceId)
  );

  return rows.map((row) => row.connector_id);
}

async function failCommandsForDetachedAppServerHostSession(
  env: Env,
  hostSession: HostSessionSummary,
  now: string
): Promise<ThreadEvent[]> {
  const taskId = hostSession.attached_task_id ?? null;
  const threadId = hostSession.attached_thread_id ?? null;
  if (!taskId && !threadId) {
    return [];
  }

  const commands = await allRows<CommandRow & { lease_owner_connector_id: string | null }>(
    env.DB!.prepare(
      `SELECT id, workspace_id, thread_id, task_id, type, prompt, state,
              target_connector_id, lease_owner_connector_id, created_at, updated_at
       FROM commands cmd
       WHERE cmd.workspace_id = ?
         AND cmd.type = 'codex'
         AND COALESCE(cmd.execution_mode, '') <> 'codex_cli_fallback'
         AND (cmd.target_connector_id = ? OR cmd.target_connector_id IS NULL)
         AND (
           (
             cmd.state = 'pending'
             AND cmd.lease_target_host_session_id = ?
           )
           OR (
             cmd.state = 'leased'
             AND cmd.lease_owner_connector_id = ?
             AND (
               cmd.lease_target_host_session_id = ?
               OR cmd.lease_target_host_session_id IS NULL
             )
           )
         )
         AND (
           (? IS NOT NULL AND cmd.task_id = ?)
           OR (? IS NOT NULL AND cmd.thread_id = ?)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM host_sessions hs
           INNER JOIN connectors c ON c.id = hs.connector_id
           INNER JOIN workspace_connectors wc
             ON wc.workspace_id = cmd.workspace_id
            AND wc.connector_id = hs.connector_id
           WHERE hs.id = COALESCE(
             (
               SELECT hs_task.id
               FROM host_sessions hs_task
               WHERE hs_task.workspace_id = cmd.workspace_id
                 AND cmd.task_id IS NOT NULL
                 AND hs_task.attached_task_id = cmd.task_id
                 AND hs_task.id <> ?
               ORDER BY hs_task.updated_at DESC, hs_task.id DESC
               LIMIT 1
             ),
             (
               SELECT hs_thread.id
               FROM host_sessions hs_thread
               WHERE hs_thread.workspace_id = cmd.workspace_id
                 AND cmd.thread_id IS NOT NULL
                 AND hs_thread.attached_thread_id = cmd.thread_id
                 AND hs_thread.id <> ?
                 AND (
                   cmd.task_id IS NULL
                   OR NOT EXISTS (
                     SELECT 1
                     FROM host_sessions hst
                     WHERE hst.workspace_id = cmd.workspace_id
                       AND hst.id <> ?
                       AND hst.attached_task_id = cmd.task_id
                   )
                 )
               ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
               LIMIT 1
             )
           )
             AND hs.app_server_present = 1
             AND wc.can_execute = 1
             AND c.status = 'online'
             AND c.capabilities_json LIKE '%"codex_app_server_exec"%'
             AND (cmd.target_connector_id IS NULL OR hs.connector_id = cmd.target_connector_id)
         )
       ORDER BY cmd.created_at ASC`
    ).bind(
      hostSession.workspace_id,
      hostSession.connector_id,
      hostSession.session_id,
      hostSession.connector_id,
      hostSession.session_id,
      taskId,
      taskId,
      threadId,
      threadId,
      hostSession.id,
      hostSession.id,
      hostSession.id
    )
  );

  const failedEvents: ThreadEvent[] = [];
  for (const command of commands) {
    const result = await env.DB!.prepare(
      `UPDATE commands
       SET state = 'failed', lease_owner_connector_id = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ?
         AND workspace_id = ?
         AND type = 'codex'
         AND COALESCE(execution_mode, '') <> 'codex_cli_fallback'
         AND (target_connector_id = ? OR target_connector_id IS NULL)
         AND (
           (
             state = 'pending'
             AND lease_target_host_session_id = ?
           )
           OR (
             state = 'leased'
             AND lease_owner_connector_id = ?
             AND (
               lease_target_host_session_id = ?
               OR lease_target_host_session_id IS NULL
             )
           )
         )
         AND (
           (? IS NOT NULL AND task_id = ?)
           OR (? IS NOT NULL AND thread_id = ?)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM host_sessions hs
           INNER JOIN connectors c ON c.id = hs.connector_id
           INNER JOIN workspace_connectors wc
             ON wc.workspace_id = commands.workspace_id
            AND wc.connector_id = hs.connector_id
           WHERE hs.id = COALESCE(
             (
               SELECT hs_task.id
               FROM host_sessions hs_task
               WHERE hs_task.workspace_id = commands.workspace_id
                 AND commands.task_id IS NOT NULL
                 AND hs_task.attached_task_id = commands.task_id
                 AND hs_task.id <> ?
               ORDER BY hs_task.updated_at DESC, hs_task.id DESC
               LIMIT 1
             ),
             (
               SELECT hs_thread.id
               FROM host_sessions hs_thread
               WHERE hs_thread.workspace_id = commands.workspace_id
                 AND commands.thread_id IS NOT NULL
                 AND hs_thread.attached_thread_id = commands.thread_id
                 AND hs_thread.id <> ?
                 AND (
                   commands.task_id IS NULL
                   OR NOT EXISTS (
                     SELECT 1
                     FROM host_sessions hst
                     WHERE hst.workspace_id = commands.workspace_id
                       AND hst.id <> ?
                       AND hst.attached_task_id = commands.task_id
                   )
                 )
               ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
               LIMIT 1
             )
           )
             AND hs.app_server_present = 1
             AND wc.can_execute = 1
             AND c.status = 'online'
             AND c.capabilities_json LIKE '%"codex_app_server_exec"%'
             AND (commands.target_connector_id IS NULL OR hs.connector_id = commands.target_connector_id)
         )`
    )
      .bind(
        now,
        command.id,
        hostSession.workspace_id,
        hostSession.connector_id,
        hostSession.session_id,
        hostSession.connector_id,
        hostSession.session_id,
        taskId,
        taskId,
        threadId,
        threadId,
        hostSession.id,
        hostSession.id,
        hostSession.id
      )
      .run();
    if (!((result.meta as { changes?: number } | undefined)?.changes)) {
      continue;
    }

    if (command.state === "leased" && command.lease_owner_connector_id) {
      await updateConnectorActivity(env, command.lease_owner_connector_id);
    }

    if (command.task_id) {
      await env.DB!.prepare(
        `UPDATE tasks
         SET state = 'failed', updated_at = ?
         WHERE id = ?`
      )
        .bind(now, command.task_id)
        .run();
    }

    if (command.thread_id) {
      const event = await appendEvent(env, {
        workspace_id: command.workspace_id,
        thread_id: command.thread_id,
        command_id: command.id,
        kind: "command.failed",
        priority: "P1",
        summary: "Host session was detached before the command could run."
      });
      if (event) {
        failedEvents.push(event);
      }
    }
  }
  return failedEvents;
}

export async function findAttachedHostSessionForTaskInDb(
  env: Env,
  taskId: string
): Promise<HostSessionSummary | undefined> {
  if (!env.DB) {
    throw new Error("DB binding is required for host session lookup");
  }

  const row = await env.DB.prepare(
    `SELECT hs.id, hs.connector_id, hs.hostname, hs.workspace_id, hs.session_id, hs.title, hs.title_source,
       hs.app_server_present, hs.cwd, hs.updated_at, hs.attached_task_id, hs.attached_thread_id
     FROM host_sessions hs
     INNER JOIN connectors c ON c.id = hs.connector_id
     WHERE hs.attached_task_id = ?
     ORDER BY hs.updated_at DESC
     LIMIT 1`
  )
    .bind(taskId)
    .first<HostSessionRow>();
  return row ? hostSessionFromRow(row) : undefined;
}

export async function recordHostSessionBackfillEvents(
  env: Env,
  hostSession: HostSessionSummary,
  events: AgentBackfillEvent[],
  accountedAt = new Date().toISOString()
): Promise<ThreadEvent[]> {
  if (!env.DB || !hostSession.attached_thread_id) {
    return [];
  }

  const thread = await loadThread(env, hostSession.attached_thread_id);
  if (!thread) {
    throw new NotFoundError("Attached thread not found");
  }

  const imported: ThreadEvent[] = [];
  try {
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      const eventId = stableBackfillEventId(hostSession, event);
      const existing = await env.DB.prepare(
        "SELECT id FROM events WHERE id = ? LIMIT 1"
      )
        .bind(eventId)
        .first<{ id: string }>();
      if (existing) {
        continue;
      }

      const now = new Date().toISOString();
      const createdAt = normaliseBackfillCreatedAt(event.created_at);
      const sequence = await env.DB.prepare(
        `UPDATE threads
         SET last_seq = last_seq + 1, updated_at = ?
         WHERE id = ?
         RETURNING last_seq`
      )
        .bind(now, thread.id)
        .first<{ last_seq: number }>();
      if (!sequence) {
        continue;
      }

      const summary = event.summary.split(/\s+/).join(" ").trim().slice(0, 600);
      const stored: ThreadEvent = {
        id: eventId,
        thread_id: thread.id,
        seq: sequence.last_seq,
        kind: event.kind,
        priority: event.priority,
        summary,
        created_at: createdAt
      };

      const insertResult = await env.DB.prepare(
        `INSERT OR IGNORE INTO events (
           id, workspace_id, thread_id, command_id, seq, kind, priority, summary, idempotency_key, created_at
         ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          stored.id,
          thread.workspace_id,
          stored.thread_id,
          stored.seq,
          stored.kind,
          stored.priority,
          stored.summary,
          event.idempotency_key,
          stored.created_at
        )
        .run();
      if (insertResult.meta?.changes === 0) {
        continue;
      }
      imported.push(stored);
    }
  } finally {
    await recordUsageWindowsForEventsBestEffort(env, imported, accountedAt);
  }

  return imported;
}

export async function listThreadEventsInDb(
  env: Env,
  threadId: string,
  limit = 100
): Promise<ThreadEvent[]> {
  if (!env.DB) {
    throw new Error("DB binding is required for thread events");
  }

  const thread = await loadThread(env, threadId);
  if (!thread) {
    throw new NotFoundError("Thread not found");
  }

  const boundedLimit = Math.max(1, Math.min(limit, 200));
  const rows = await allRows<ThreadEventRow>(
    env.DB.prepare(
      `SELECT id, thread_id, command_id, seq, kind, priority, summary, payload_json, created_at
       FROM events
       WHERE thread_id = ?
       ORDER BY seq DESC
       LIMIT ?`
    )
      .bind(thread.id, boundedLimit)
  );
  return rows.reverse().map(threadEventFromRow);
}

export async function prepareTurnInteractionResolutionInDb(
  env: Env,
  eventId: string,
  response: ResolveTurnInteractionRequest
): Promise<TurnInteractionResponseDispatch> {
  if (!env.DB) {
    throw new Error("DB binding is required for turn interaction resolution");
  }
  const row = await env.DB.prepare(
    `SELECT e.id, e.thread_id, e.command_id, e.kind, e.payload_json, e.created_at,
            cmd.lease_owner_connector_id, cmd.state
     FROM events e
     LEFT JOIN commands cmd ON cmd.id = e.command_id
     WHERE e.id = ?
     LIMIT 1`
  )
    .bind(eventId)
    .first<{
      id: string;
      thread_id: string;
      command_id: string | null;
      kind: ThreadEvent["kind"];
      payload_json: string | null;
      created_at: string;
      lease_owner_connector_id: string | null;
      state: CommandSummary["state"] | null;
    }>();
  if (!row) {
    throw new NotFoundError("Turn interaction event not found");
  }
  if (!row.command_id || !row.lease_owner_connector_id || !row.state || !isActiveCommandState(row.state)) {
    throw new CommandTargetError("Turn interaction is no longer active", 409);
  }
  const payload = parseTurnInteractionRequestPayload(row.payload_json);
  if (!payload) {
    throw new CommandTargetError("Turn interaction payload is unavailable", 409);
  }
  if (payload.status !== "pending") {
    throw new CommandTargetError("Turn interaction has already been resolved", 409);
  }
  if (response.kind === "approval" && row.kind !== "approval.requested") {
    throw new CommandTargetError("Turn interaction is not an approval request", 400);
  }
  if (response.kind === "input" && row.kind !== "input.requested") {
    throw new CommandTargetError("Turn interaction is not an input request", 400);
  }
  if (turnInteractionAutoResolutionExpired(payload, row.created_at)) {
    throw new CommandTargetError("Turn interaction auto-resolution deadline has expired", 409);
  }
  validateTurnInteractionResponseForRequest(response, payload);
  if (await hasTurnInteractionResolution(env, row.command_id, payload.interaction_id)) {
    throw new CommandTargetError("Turn interaction has already been resolved", 409);
  }
  await claimTurnInteractionResolution(env, row.id, row.command_id, payload.interaction_id, response.kind);
  return {
    command_id: row.command_id,
    interaction_id: payload.interaction_id,
    response
  };
}

export async function recordTurnInteractionResolutionInDb(
  env: Env,
  eventId: string,
  response: ResolveTurnInteractionRequest,
  options: { allowExisting?: boolean } = {}
): Promise<ThreadEvent> {
  if (!env.DB) {
    throw new Error("DB binding is required for turn interaction resolution");
  }
  const row = await env.DB.prepare(
    `SELECT e.id, e.workspace_id, e.thread_id, e.command_id, e.kind, e.payload_json,
            cmd.task_id, cmd.lease_owner_connector_id
     FROM events e
     LEFT JOIN commands cmd ON cmd.id = e.command_id
     WHERE e.id = ?
     LIMIT 1`
  )
    .bind(eventId)
    .first<{
      id: string;
      workspace_id: string;
      thread_id: string;
      command_id: string | null;
      kind: ThreadEvent["kind"];
      payload_json: string | null;
      task_id: string | null;
      lease_owner_connector_id: string | null;
    }>();
  if (!row || !row.command_id) {
    throw new NotFoundError("Turn interaction event not found");
  }
  const payload = parseTurnInteractionRequestPayload(row.payload_json);
  if (!payload) {
    throw new CommandTargetError("Turn interaction payload is unavailable", 409);
  }
  validateTurnInteractionResponseForRequest(response, payload);
  const existing = await findTurnInteractionResolution(env, row.command_id, payload.interaction_id);
  if (existing) {
    if (options.allowExisting) {
      await releaseTurnInteractionResolutionClaimBestEffort(env, row.command_id, payload.interaction_id);
      return existing;
    }
    throw new CommandTargetError("Turn interaction has already been resolved", 409);
  }
  const resolution = turnInteractionResolutionEvent(response, payload);
  let event: ThreadEvent | undefined;
  try {
    event = await appendEvent(env, {
      workspace_id: row.workspace_id,
      thread_id: row.thread_id,
      command_id: row.command_id,
      kind: response.kind === "approval" ? "approval.resolved" : "input.received",
      priority: "P1",
      summary: resolution.summary,
      payload: resolution.payload
    });
  } catch (error) {
    const raced = options.allowExisting
      ? await findTurnInteractionResolution(env, row.command_id, payload.interaction_id)
      : undefined;
    if (raced && isUniqueConstraintError(error)) {
      await releaseTurnInteractionResolutionClaimBestEffort(env, row.command_id, payload.interaction_id);
      return raced;
    }
    throw error;
  }
  if (!event) {
    throw new NotFoundError("Thread not found");
  }
  if (row.task_id) {
    await env.DB.prepare(
      `UPDATE tasks
       SET state = 'running',
           connector_id = COALESCE(?, connector_id),
           assigned_agent = CASE WHEN ? IS NOT NULL THEN 'chaop-agent' ELSE assigned_agent END,
           updated_at = ?
       WHERE id = ?
         AND state IN ('waiting_for_approval', 'waiting_for_input')`
    )
      .bind(row.lease_owner_connector_id, row.lease_owner_connector_id, event.created_at, row.task_id)
      .run();
  }
  await releaseTurnInteractionResolutionClaimBestEffort(env, row.command_id, payload.interaction_id);
  return event;
}

export async function releaseTurnInteractionResolutionClaimInDb(
  env: Env,
  commandId: string,
  interactionId: string
): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(
    "DELETE FROM turn_interaction_resolution_claims WHERE command_id = ? AND interaction_id = ?"
  )
    .bind(commandId, interactionId)
    .run();
}

async function releaseTurnInteractionResolutionClaimBestEffort(
  env: Env,
  commandId: string,
  interactionId: string
): Promise<void> {
  try {
    await releaseTurnInteractionResolutionClaimInDb(env, commandId, interactionId);
  } catch (error) {
    console.warn("Turn interaction resolution claim cleanup failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function chooseConnectorForLocalThread(
  env: Env,
  user: BrowserIdentity,
  request: CreateLocalThreadRequest
): Promise<string> {
  if (!env.DB) {
    throw new Error("DB binding is required for local thread creation");
  }

  await ensureUser(env, user);

  const workspace = await env.DB.prepare(
    "SELECT id FROM workspaces WHERE id = ? LIMIT 1"
  )
    .bind(request.workspace_id)
    .first<{ id: string }>();
  if (!workspace) {
    throw new LocalThreadTargetError("Workspace not available");
  }

  const connector = request.connector_id
    ? await findLocalThreadConnector(env, request.workspace_id, request.connector_id)
    : await findBestLocalThreadConnector(env, request.workspace_id);

  if (!connector) {
    throw new LocalThreadTargetError("No managed app-server connector with thread support is online");
  }

  return connector.id;
}

export async function attachCreatedLocalThreadInDb(
  env: Env,
  connectorId: string,
  workspaceId: string,
  session: AgentHostSession
): Promise<CreateLocalThreadResponse> {
  if (!env.DB) {
    throw new Error("DB binding is required for local thread creation");
  }

  await recordHostSessions(
    env,
    connectorId,
    { sessions: [session], inventory_scope: "incremental", app_server_inventory_ok: true },
    new Date().toISOString(),
    { workspaceId }
  );
  const { attachment_created: _attachmentCreated, ...response } = await attachHostSessionInDb(
    env,
    session.session_id,
    connectorId
  );
  return response;
}

export async function ensureConnectorInventory(
  env: Env,
  connectorId: string,
  registration: AgentBootstrapRequest
): Promise<void> {
  if (!env.DB) return;

  const now = new Date().toISOString();
  await retireDuplicateConnectors(env, connectorId, registration, now);

  for (const category of taskCategories) {
    await env.DB.prepare(
      `INSERT INTO task_categories (id, name, colour, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         colour = excluded.colour,
         updated_at = excluded.updated_at`
    )
      .bind(category.id, category.name, category.colour, categorySortOrder(category), now, now)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, repo_url, default_branch, created_at, updated_at)
     VALUES (?, 'Codex Workspace', NULL, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       updated_at = excluded.updated_at`
  )
    .bind(DEFAULT_WORKSPACE_ID, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO workspace_connectors (workspace_id, connector_id, local_path, can_execute, last_indexed_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(workspace_id, connector_id) DO UPDATE SET
       local_path = excluded.local_path,
       can_execute = 1,
       last_indexed_at = excluded.last_indexed_at`
  )
    .bind(DEFAULT_WORKSPACE_ID, connectorId, registration.workspace_root, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO threads (id, workspace_id, title, state, realtime_mode, last_seq, created_at, updated_at)
     VALUES (?, ?, 'Placeholder command lane', 'active', 'realtime', 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       title = excluded.title,
       state = 'active',
       realtime_mode = 'realtime',
       updated_at = excluded.updated_at`
  )
    .bind(DEFAULT_THREAD_ID, DEFAULT_WORKSPACE_ID, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO tasks (
       id, workspace_id, thread_id, title, category_id, state, connector_id,
       assigned_agent, realtime_mode, budget_state, created_at, updated_at
     ) VALUES (?, ?, ?, 'Run command through local connector', 'maintenance', 'idle', ?, 'chaop-agent', 'realtime', 'normal', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       thread_id = excluded.thread_id,
       title = excluded.title,
       category_id = excluded.category_id,
       connector_id = excluded.connector_id,
       assigned_agent = excluded.assigned_agent,
       realtime_mode = excluded.realtime_mode,
       budget_state = excluded.budget_state,
       updated_at = excluded.updated_at`
  )
    .bind(DEFAULT_TASK_ID, DEFAULT_WORKSPACE_ID, DEFAULT_THREAD_ID, connectorId, now, now)
    .run();
}

export async function updateConnectorCapabilities(
  env: Env,
  connectorId: string,
  capabilities: string[]
): Promise<boolean> {
  if (!env.DB) return false;

  const now = new Date().toISOString();
  const capabilitiesJson = JSON.stringify([...new Set(capabilities)]);
  const result = await env.DB.prepare(
    `UPDATE connectors
     SET status = 'online',
         capabilities_json = ?,
         last_seen_at = ?,
         updated_at = ?
     WHERE id = ?
       AND (
         status <> 'online'
         OR capabilities_json IS NULL
         OR capabilities_json <> ?
       )`
  )
    .bind(capabilitiesJson, now, now, connectorId, capabilitiesJson)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markConnectorOnline(env: Env, connectorId: string): Promise<boolean> {
  if (!env.DB) return false;

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE connectors
     SET status = 'online',
         last_seen_at = ?,
         updated_at = ?
     WHERE id = ?`
  )
    .bind(now, now, connectorId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markConnectorDegraded(
  env: Env,
  connectorId: string,
  now = new Date().toISOString()
): Promise<void> {
  if (!env.DB) return;

  await env.DB.prepare(
    `UPDATE connectors
     SET status = 'degraded',
         active_command_count = 0,
         updated_at = ?
     WHERE id = ?`
  )
    .bind(now, connectorId)
    .run();
}

export async function createCommandInDb(
  env: Env,
  user: BrowserIdentity,
  request: CreateCommandRequest
): Promise<{ response: CreateCommandResponse; targetConnectorId?: string | undefined }> {
  if (!env.DB) {
    throw new Error("DB binding is required for command creation");
  }

  await ensureUser(env, user);

  const commandType = request.type ?? "placeholder";
  if (request.execution_mode && commandType !== "codex") {
    throw new CommandTargetError("Command execution mode requires codex command type", 400);
  }
  const requestedExecutionMode = commandType === "codex" ? request.execution_mode : undefined;
  const scope = await resolveCommandScope(env, request);
  const useAttachedTarget = requestedExecutionMode !== "codex_cli_fallback";
  const attachedTarget = useAttachedTarget ? await findAttachedCommandTarget(env, scope) : null;
  if (requestedExecutionMode === "app_server" && attachedTarget?.app_server_present !== true) {
    throw new CommandTargetError("App-server execution requires an attached app-server host session");
  }
  const executionMode =
    commandType === "codex" && attachedTarget?.app_server_present === true
      ? "app_server"
      : requestedExecutionMode;
  if (commandType === "codex" && !executionMode) {
    throw new CommandTargetError(
      "Codex commands require an attached app-server host session or explicit CLI fallback execution mode"
    );
  }
  const attachedTargetForInsert = attachedTarget
    ? {
      connectorId: attachedTarget.connector_id,
      sessionId: attachedTarget.session_id,
      appServerPresent: attachedTarget.app_server_present
    }
    : undefined;
  const appServerTargetHostSessionId =
    executionMode === "app_server" ? attachedTarget?.session_id ?? null : null;
  const targetConnectorId =
    request.target_connector_id
    ?? attachedTarget?.connector_id
    ?? (await chooseConnectorForWorkspace(env, scope.workspaceId, commandType));
  const targetConnectorIdSource = request.target_connector_id
    ? "explicit"
    : attachedTarget?.connector_id
      ? "attached"
      : "auto";

  if (request.target_connector_id && !targetConnectorId) {
    throw new CommandTargetError("Target connector not available");
  }

  if (attachedTarget && targetConnectorId !== attachedTarget.connector_id) {
    throw new CommandTargetError("Target connector does not own the attached host session");
  }

  if (targetConnectorId) {
    await assertConnectorCanExecute(env, targetConnectorId, scope.workspaceId, commandType, {
      requireAppServerExec: executionMode === "app_server"
    });
  }

  const now = new Date().toISOString();
  const command: CommandSummary = {
    id: `command-${cryptoRandomId().slice(0, 12)}`,
    workspace_id: scope.workspaceId,
    thread_id: scope.threadId,
    task_id: scope.taskId,
    type: commandType,
    execution_mode: commandType === "codex" ? executionMode : undefined,
    prompt: request.prompt,
    state: "pending",
    target_connector_id: targetConnectorId,
    created_at: now,
    updated_at: now
  };

  const inserted = await insertCommandInDb(env, user.id, command, {
    appServerTargetHostSessionId,
    attachedTarget: attachedTargetForInsert,
    targetConnectorIdSource
  });
  if (!inserted) {
    throw new CommandTargetError("Attached host session changed before command creation", 409);
  }

  if (command.thread_id) {
    await appendEvent(env, {
      workspace_id: command.workspace_id,
      thread_id: command.thread_id,
      command_id: command.id,
      kind: "command.accepted",
      priority: "P1",
      summary: `Control plane accepted the ${command.type} command.`
    });
  }

  return { response: { accepted: true, command }, targetConnectorId };
}

async function insertCommandInDb(
  env: Env,
  userId: string,
  command: CommandSummary,
  options: {
    appServerTargetHostSessionId?: string | null;
    attachedTarget?: {
      connectorId: string;
      sessionId: string;
      appServerPresent: boolean;
    } | undefined;
    targetConnectorIdSource: CommandTargetConnectorIdSource;
  }
): Promise<boolean> {
  if (options.attachedTarget) {
    if (!command.target_connector_id) {
      return false;
    }
    const result = await env.DB!.prepare(
      `INSERT INTO commands (
         id, workspace_id, thread_id, task_id, type, prompt, state,
         target_connector_id, target_connector_id_source, lease_target_host_session_id,
         execution_mode, created_by, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1
         FROM host_sessions hs
         WHERE hs.id = (
           SELECT hs2.id
           FROM host_sessions hs2
           WHERE hs2.workspace_id = ?
             AND (
               (? IS NOT NULL AND hs2.attached_task_id = ?)
               OR (
                 ? IS NOT NULL
                 AND hs2.attached_thread_id = ?
                 AND (
                   ? IS NULL
                   OR NOT EXISTS (
                     SELECT 1
                     FROM host_sessions hst
                     WHERE hst.workspace_id = hs2.workspace_id
                       AND hst.attached_task_id = ?
                   )
                 )
               )
             )
           ORDER BY
             CASE WHEN ? IS NOT NULL AND hs2.attached_task_id = ? THEN 0 ELSE 1 END,
             hs2.updated_at DESC,
             hs2.id DESC
           LIMIT 1
         )
           AND hs.connector_id = ?
           AND hs.session_id = ?
           AND COALESCE(hs.app_server_present, 0) = ?
       )`
    )
      .bind(
        command.id,
        command.workspace_id,
        command.thread_id ?? null,
        command.task_id ?? null,
        command.type,
        command.prompt,
        command.state,
        command.target_connector_id,
        options.targetConnectorIdSource,
        options.appServerTargetHostSessionId,
        command.execution_mode ?? null,
        userId,
        command.created_at,
        command.updated_at,
        command.workspace_id,
        command.task_id ?? null,
        command.task_id ?? null,
        command.thread_id ?? null,
        command.thread_id ?? null,
        command.task_id ?? null,
        command.task_id ?? null,
        command.task_id ?? null,
        command.task_id ?? null,
        command.target_connector_id,
        options.attachedTarget.sessionId,
        options.attachedTarget.appServerPresent ? 1 : 0
      )
      .run();
    return Boolean((result.meta as { changes?: number } | undefined)?.changes);
  }

  await env.DB!.prepare(
    `INSERT INTO commands (
       id, workspace_id, thread_id, task_id, type, prompt, state,
       target_connector_id, target_connector_id_source, lease_target_host_session_id,
       execution_mode, created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
  )
    .bind(
      command.id,
      command.workspace_id,
      command.thread_id ?? null,
      command.task_id ?? null,
      command.type,
      command.prompt,
      command.state,
      command.target_connector_id ?? null,
      options.targetConnectorIdSource,
      command.execution_mode ?? null,
      userId,
      command.created_at,
      command.updated_at
    )
    .run();
  return true;
}

export async function pendingCommandsForConnector(
  env: Env,
  connectorId: string
): Promise<CommandDispatch[]> {
  if (!env.DB) return [];

  const now = new Date().toISOString();
  const rows = await allRows<PendingCommandRow>(
    env.DB.prepare(
      `SELECT cmd.id, cmd.workspace_id, cmd.thread_id, cmd.task_id, cmd.type, cmd.prompt, cmd.state,
              cmd.target_connector_id, cmd.target_connector_id_source, cmd.execution_mode,
              cmd.created_at, cmd.updated_at,
              hs.id AS target_host_session_row_id,
              hs.session_id AS target_host_session_id,
              hs.app_server_present AS target_host_session_app_server_present,
              hs.cwd AS target_host_session_cwd
       FROM commands cmd
       LEFT JOIN host_sessions hs
         ON COALESCE(cmd.execution_mode, '') <> 'codex_cli_fallback'
        AND hs.id = COALESCE(
          (
            SELECT hs_task.id
            FROM host_sessions hs_task
            WHERE hs_task.workspace_id = cmd.workspace_id
              AND cmd.task_id IS NOT NULL
              AND hs_task.attached_task_id = cmd.task_id
            ORDER BY hs_task.updated_at DESC, hs_task.id DESC
            LIMIT 1
          ),
          (
            SELECT hs_thread.id
            FROM host_sessions hs_thread
            WHERE hs_thread.workspace_id = cmd.workspace_id
              AND cmd.thread_id IS NOT NULL
              AND hs_thread.attached_thread_id = cmd.thread_id
              AND (
                cmd.task_id IS NULL
                OR NOT EXISTS (
                  SELECT 1
                  FROM host_sessions hst
                  WHERE hst.workspace_id = cmd.workspace_id
                    AND hst.attached_task_id = cmd.task_id
                )
              )
            ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
            LIMIT 1
          )
        )
       WHERE (
           cmd.state = 'pending'
           OR (cmd.state = 'leased' AND cmd.lease_until IS NOT NULL AND cmd.lease_until < ?)
         )
         AND (
           cmd.target_connector_id = ?
           OR cmd.target_connector_id IS NULL
           OR (
             cmd.target_connector_id_source = 'auto'
             AND hs.connector_id = ?
             AND COALESCE(hs.app_server_present, 0) = 1
           )
         )
         AND (hs.connector_id IS NULL OR hs.connector_id = ?)
         AND (
           cmd.lease_target_host_session_id IS NULL
           OR hs.session_id = cmd.lease_target_host_session_id
         )
         AND EXISTS (
           SELECT 1
           FROM workspace_connectors wc
           INNER JOIN connectors c ON c.id = wc.connector_id
           WHERE wc.workspace_id = cmd.workspace_id
             AND wc.connector_id = ?
             AND wc.can_execute = 1
             AND c.status = 'online'
             AND (
               cmd.type <> 'codex'
               OR (
                 COALESCE(hs.app_server_present, 0) = 1
                 AND c.capabilities_json LIKE '%"codex_app_server_exec"%'
               )
               OR (
                 COALESCE(hs.app_server_present, 0) <> 1
                 AND cmd.lease_target_host_session_id IS NULL
                 AND c.capabilities_json LIKE '%"codex_exec"%'
               )
             )
         )
       ORDER BY created_at ASC
       LIMIT 1`
    ).bind(now, connectorId, connectorId, connectorId, connectorId)
  );

  const leaseUntil = new Date(Date.now() + 60_000).toISOString();
  const leasedRows: PendingCommandRow[] = [];

  for (const row of rows) {
    const result = await env.DB.prepare(
      `UPDATE commands
       SET state = 'leased',
           target_connector_id = CASE
             WHEN target_connector_id_source = 'auto' AND ? IS NOT NULL AND ? = 1
             THEN ?
             ELSE target_connector_id
           END,
           target_connector_id_source = CASE
             WHEN target_connector_id_source = 'auto' AND ? IS NOT NULL AND ? = 1
             THEN 'attached'
             ELSE target_connector_id_source
           END,
           lease_owner_connector_id = ?,
           lease_until = ?,
           lease_target_host_session_id = ?,
           updated_at = ?
       WHERE id = ?
         AND (
           state = 'pending'
           OR (state = 'leased' AND lease_until IS NOT NULL AND lease_until < ?)
         )
         AND (
           COALESCE(commands.execution_mode, '') = 'codex_cli_fallback'
           OR
           (
             ? IS NULL
             AND COALESCE(
               (
                 SELECT hs_task.id
                 FROM host_sessions hs_task
                 WHERE hs_task.workspace_id = commands.workspace_id
                   AND commands.task_id IS NOT NULL
                   AND hs_task.attached_task_id = commands.task_id
                 ORDER BY hs_task.updated_at DESC, hs_task.id DESC
                 LIMIT 1
               ),
               (
                 SELECT hs_thread.id
                 FROM host_sessions hs_thread
                 WHERE hs_thread.workspace_id = commands.workspace_id
                   AND commands.thread_id IS NOT NULL
                   AND hs_thread.attached_thread_id = commands.thread_id
                   AND (
                     commands.task_id IS NULL
                     OR NOT EXISTS (
                       SELECT 1
                       FROM host_sessions hst
                       WHERE hst.workspace_id = commands.workspace_id
                         AND hst.attached_task_id = commands.task_id
                     )
                   )
                 ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
                 LIMIT 1
               )
             ) IS NULL
           )
           OR (
             ? IS NOT NULL
             AND COALESCE(
               (
                 SELECT hs_task.id
                 FROM host_sessions hs_task
                 WHERE hs_task.workspace_id = commands.workspace_id
                   AND commands.task_id IS NOT NULL
                   AND hs_task.attached_task_id = commands.task_id
                 ORDER BY hs_task.updated_at DESC, hs_task.id DESC
                 LIMIT 1
               ),
               (
                 SELECT hs_thread.id
                 FROM host_sessions hs_thread
                 WHERE hs_thread.workspace_id = commands.workspace_id
                   AND commands.thread_id IS NOT NULL
                   AND hs_thread.attached_thread_id = commands.thread_id
                   AND (
                     commands.task_id IS NULL
                     OR NOT EXISTS (
                       SELECT 1
                       FROM host_sessions hst
                       WHERE hst.workspace_id = commands.workspace_id
                         AND hst.attached_task_id = commands.task_id
                     )
                   )
                 ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
                 LIMIT 1
               )
             ) = ?
           )
         )
         AND (
           commands.lease_target_host_session_id IS NULL
           OR EXISTS (
             SELECT 1
             FROM host_sessions hs_lease
             WHERE hs_lease.id = ?
               AND hs_lease.session_id = commands.lease_target_host_session_id
           )
         )
         AND (
           target_connector_id = ?
           OR target_connector_id IS NULL
           OR (
             target_connector_id_source = 'auto'
             AND EXISTS (
               SELECT 1
               FROM host_sessions hs_target
               WHERE hs_target.id = ?
                 AND hs_target.connector_id = ?
                 AND COALESCE(hs_target.app_server_present, 0) = 1
             )
           )
         )
         AND EXISTS (
           SELECT 1
           FROM workspace_connectors wc
           INNER JOIN connectors c ON c.id = wc.connector_id
           LEFT JOIN host_sessions hs_guard ON hs_guard.id = ?
           WHERE wc.workspace_id = commands.workspace_id
             AND wc.connector_id = ?
             AND wc.can_execute = 1
             AND c.status = 'online'
             AND (hs_guard.id IS NULL OR hs_guard.connector_id = ?)
             AND (
               commands.type <> 'codex'
               OR (
                 COALESCE(hs_guard.app_server_present, 0) = 1
                 AND c.capabilities_json LIKE '%"codex_app_server_exec"%'
               )
               OR (
                 COALESCE(hs_guard.app_server_present, 0) <> 1
                 AND commands.lease_target_host_session_id IS NULL
                 AND c.capabilities_json LIKE '%"codex_exec"%'
               )
             )
         )`
    )
      .bind(
        row.target_host_session_id,
        targetHostSessionIsAppServer(row) ? 1 : 0,
        connectorId,
        row.target_host_session_id,
        targetHostSessionIsAppServer(row) ? 1 : 0,
        connectorId,
        leaseUntil,
        appServerLeaseTargetHostSessionId(row),
        now,
        row.id,
        now,
        row.target_host_session_row_id,
        row.target_host_session_row_id,
        row.target_host_session_row_id,
        row.target_host_session_row_id,
        connectorId,
        row.target_host_session_row_id,
        connectorId,
        row.target_host_session_row_id,
        connectorId,
        connectorId
      )
      .run();
    if ((result.meta as { changes?: number } | undefined)?.changes) {
      leasedRows.push(row);
    }
  }

  if (leasedRows.length > 0) {
    await updateConnectorActivity(env, connectorId);
  }

  return leasedRows.map((row) => {
    const command = {
      ...commandFromRow(row),
      target_connector_id:
        row.target_connector_id_source === "auto" && targetHostSessionIsAppServer(row)
          ? connectorId
          : row.target_connector_id ?? undefined,
      state: "leased" as const
    };
    const targetHostSession = commandTargetHostSessionFromRow(row);
    return targetHostSession
      ? { command, target_host_session: targetHostSession }
      : { command };
  });
}

export async function releaseLeasedCommandsForConnector(
  env: Env,
  connectorId: string,
  commandIds: string[]
): Promise<number> {
  if (!env.DB) return 0;

  const scopedCommandIds = [...new Set(commandIds)].filter(Boolean);
  if (scopedCommandIds.length === 0) return 0;

  const now = new Date().toISOString();
  let released = 0;
  for (const commandId of scopedCommandIds) {
    const result = await env.DB.prepare(
      `UPDATE commands
       SET state = 'pending', lease_owner_connector_id = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND lease_owner_connector_id = ? AND state = 'leased'`
    )
      .bind(now, commandId, connectorId)
      .run();
    released += (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  }

  if (released > 0) {
    await updateConnectorActivity(env, connectorId);
  }
  return released;
}

export async function failStaleExplicitAppServerCommandTargets(
  env: Env,
  connectorId: string,
  now = new Date().toISOString()
): Promise<ThreadEvent[]> {
  return (await cleanupStaleExplicitAppServerCommandTargets(env, connectorId, now)).failed_events;
}

export async function cleanupStaleExplicitAppServerCommandTargets(
  env: Env,
  connectorId: string,
  now = new Date().toISOString()
): Promise<{ failed_events: ThreadEvent[]; released_connector_ids: string[] }> {
  if (!env.DB) return { failed_events: [], released_connector_ids: [] };

  const commands = await allRows<CommandRow & {
    target_connector_id_source: CommandTargetConnectorIdSource | null;
    lease_owner_connector_id: string | null;
    lease_target_host_session_id: string | null;
  }>(
    env.DB.prepare(
      `SELECT id, workspace_id, thread_id, task_id, type, prompt, state,
              target_connector_id, target_connector_id_source, lease_owner_connector_id, created_at, updated_at,
              lease_target_host_session_id
       FROM commands cmd
       WHERE cmd.type = 'codex'
         AND (
           cmd.target_connector_id = ?
           OR (
             cmd.target_connector_id IS NULL
             AND cmd.target_connector_id_source = 'auto'
             AND EXISTS (
               SELECT 1
               FROM host_sessions hs_scope
               WHERE hs_scope.workspace_id = cmd.workspace_id
                 AND hs_scope.connector_id = ?
                 AND (
                   hs_scope.session_id = cmd.lease_target_host_session_id
                   OR hs_scope.id = COALESCE(
                     (
                       SELECT hs_task.id
                       FROM host_sessions hs_task
                       WHERE hs_task.workspace_id = cmd.workspace_id
                         AND cmd.task_id IS NOT NULL
                         AND hs_task.attached_task_id = cmd.task_id
                       ORDER BY hs_task.updated_at DESC, hs_task.id DESC
                       LIMIT 1
                     ),
                     (
                       SELECT hs_thread.id
                       FROM host_sessions hs_thread
                       WHERE hs_thread.workspace_id = cmd.workspace_id
                         AND cmd.thread_id IS NOT NULL
                         AND hs_thread.attached_thread_id = cmd.thread_id
                         AND (
                           cmd.task_id IS NULL
                           OR NOT EXISTS (
                             SELECT 1
                             FROM host_sessions hst
                             WHERE hst.workspace_id = cmd.workspace_id
                               AND hst.attached_task_id = cmd.task_id
                           )
                         )
                       ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
                       LIMIT 1
                     )
                   )
                 )
             )
           )
         )
         AND cmd.lease_target_host_session_id IS NOT NULL
         AND (
           cmd.state = 'pending'
           OR (
             cmd.state = 'leased'
             AND cmd.lease_owner_connector_id = ?
             AND cmd.lease_until IS NOT NULL
             AND cmd.lease_until < ?
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM host_sessions hs
           INNER JOIN connectors c ON c.id = hs.connector_id
           INNER JOIN workspace_connectors wc
             ON wc.workspace_id = cmd.workspace_id
            AND wc.connector_id = hs.connector_id
           WHERE hs.id = COALESCE(
             (
               SELECT hs_task.id
               FROM host_sessions hs_task
               WHERE hs_task.workspace_id = cmd.workspace_id
                 AND cmd.task_id IS NOT NULL
                 AND hs_task.attached_task_id = cmd.task_id
               ORDER BY hs_task.updated_at DESC, hs_task.id DESC
               LIMIT 1
             ),
             (
               SELECT hs_thread.id
               FROM host_sessions hs_thread
               WHERE hs_thread.workspace_id = cmd.workspace_id
                 AND cmd.thread_id IS NOT NULL
                 AND hs_thread.attached_thread_id = cmd.thread_id
                 AND (
                   cmd.task_id IS NULL
                   OR NOT EXISTS (
                     SELECT 1
                     FROM host_sessions hst
                     WHERE hst.workspace_id = cmd.workspace_id
                       AND hst.attached_task_id = cmd.task_id
                   )
                 )
               ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
               LIMIT 1
             )
           )
             AND hs.connector_id = ?
             AND hs.session_id = cmd.lease_target_host_session_id
             AND COALESCE(hs.app_server_present, 0) = 1
             AND wc.can_execute = 1
             AND c.status = 'online'
             AND c.capabilities_json LIKE '%"codex_app_server_exec"%'
         )
       ORDER BY cmd.created_at ASC
       LIMIT 20`
    ).bind(connectorId, connectorId, connectorId, now, connectorId)
  );

  const failedEvents: ThreadEvent[] = [];
  const releasedConnectorIds = new Set<string>();
  for (const command of commands) {
    const releaseConnectorIds = await releaseStaleAttachedAppServerCommandTarget(env, connectorId, command, now);
    if (releaseConnectorIds.length > 0) {
      for (const releasedConnectorId of releaseConnectorIds) {
        releasedConnectorIds.add(releasedConnectorId);
      }
      continue;
    }

    const result = await env.DB.prepare(
      `UPDATE commands
       SET state = 'failed',
           lease_owner_connector_id = NULL,
           lease_until = NULL,
           updated_at = ?
       WHERE id = ?
         AND type = 'codex'
         AND (
           target_connector_id = ?
           OR (
             target_connector_id IS NULL
             AND target_connector_id_source = 'auto'
           )
         )
         AND lease_target_host_session_id IS NOT NULL
         AND (
           state = 'pending'
           OR (
             state = 'leased'
             AND lease_owner_connector_id = ?
             AND lease_until IS NOT NULL
             AND lease_until < ?
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM host_sessions hs
           INNER JOIN connectors c ON c.id = hs.connector_id
           INNER JOIN workspace_connectors wc
             ON wc.workspace_id = commands.workspace_id
            AND wc.connector_id = hs.connector_id
           WHERE hs.id = COALESCE(
             (
               SELECT hs_task.id
               FROM host_sessions hs_task
               WHERE hs_task.workspace_id = commands.workspace_id
                 AND commands.task_id IS NOT NULL
                 AND hs_task.attached_task_id = commands.task_id
               ORDER BY hs_task.updated_at DESC, hs_task.id DESC
               LIMIT 1
             ),
             (
               SELECT hs_thread.id
               FROM host_sessions hs_thread
               WHERE hs_thread.workspace_id = commands.workspace_id
                 AND commands.thread_id IS NOT NULL
                 AND hs_thread.attached_thread_id = commands.thread_id
                 AND (
                   commands.task_id IS NULL
                   OR NOT EXISTS (
                     SELECT 1
                     FROM host_sessions hst
                     WHERE hst.workspace_id = commands.workspace_id
                       AND hst.attached_task_id = commands.task_id
                   )
                 )
               ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
               LIMIT 1
             )
           )
             AND hs.connector_id = ?
             AND hs.session_id = commands.lease_target_host_session_id
             AND COALESCE(hs.app_server_present, 0) = 1
             AND wc.can_execute = 1
             AND c.status = 'online'
             AND c.capabilities_json LIKE '%"codex_app_server_exec"%'
         )`
    )
      .bind(now, command.id, connectorId, connectorId, now, connectorId)
      .run();
    if (!((result.meta as { changes?: number } | undefined)?.changes)) {
      continue;
    }

    if (command.state === "leased" && command.lease_owner_connector_id) {
      await updateConnectorActivity(env, command.lease_owner_connector_id);
    }

    if (command.task_id) {
      await env.DB.prepare(
        `UPDATE tasks
         SET state = 'failed', updated_at = ?
         WHERE id = ?`
      )
        .bind(now, command.task_id)
        .run();
    }

    if (command.thread_id) {
      const event = await appendEvent(env, {
        workspace_id: command.workspace_id,
        thread_id: command.thread_id,
        command_id: command.id,
        kind: "command.failed",
        priority: "P1",
        summary: unavailableAppServerCommandSummary(command.target_connector_id_source)
      });
      if (event) {
        failedEvents.push(event);
      }
    }
  }

  return {
    failed_events: failedEvents,
    released_connector_ids: [...releasedConnectorIds]
  };
}

function unavailableAppServerCommandSummary(source: CommandTargetConnectorIdSource | null): string {
  return source === "explicit"
    ? "Explicit app-server target changed before the command could start."
    : "App-server target became unavailable before the command could start.";
}

async function releaseStaleAttachedAppServerCommandTarget(
  env: Env,
  connectorId: string,
  command: {
    id: string;
    workspace_id: string;
    state: CommandSummary["state"];
    target_connector_id_source: CommandTargetConnectorIdSource | null;
    lease_owner_connector_id: string | null;
    lease_target_host_session_id: string | null;
  },
  now: string
): Promise<string[]> {
  if (
    !["attached", "auto"].includes(command.target_connector_id_source ?? "") ||
    !command.lease_target_host_session_id
  ) {
    return [];
  }

  const result = await env.DB!.prepare(
    `UPDATE commands
     SET state = 'pending',
         target_connector_id = NULL,
         target_connector_id_source = 'auto',
         lease_owner_connector_id = NULL,
         lease_until = NULL,
         lease_target_host_session_id = (
           SELECT hs.session_id
           FROM host_sessions hs
           WHERE hs.id = COALESCE(
             (
               SELECT hs_task.id
               FROM host_sessions hs_task
               WHERE hs_task.workspace_id = commands.workspace_id
                 AND commands.task_id IS NOT NULL
                 AND hs_task.attached_task_id = commands.task_id
               ORDER BY hs_task.updated_at DESC, hs_task.id DESC
               LIMIT 1
             ),
             (
               SELECT hs_thread.id
               FROM host_sessions hs_thread
               WHERE hs_thread.workspace_id = commands.workspace_id
                 AND commands.thread_id IS NOT NULL
                 AND hs_thread.attached_thread_id = commands.thread_id
                 AND (
                   commands.task_id IS NULL
                   OR NOT EXISTS (
                     SELECT 1
                     FROM host_sessions hst
                     WHERE hst.workspace_id = commands.workspace_id
                       AND hst.attached_task_id = commands.task_id
                   )
                 )
               ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
               LIMIT 1
             )
           )
         ),
         updated_at = ?
     WHERE id = ?
       AND type = 'codex'
       AND (
         target_connector_id = ?
         OR (
           target_connector_id IS NULL
           AND target_connector_id_source = 'auto'
         )
       )
       AND target_connector_id_source IN ('attached', 'auto')
       AND lease_target_host_session_id IS NOT NULL
       AND lease_target_host_session_id = ?
       AND (
         state = 'pending'
         OR (
           state = 'leased'
           AND lease_owner_connector_id = ?
           AND lease_until IS NOT NULL
           AND lease_until < ?
         )
       )
       AND EXISTS (
         SELECT 1
         FROM host_sessions hs
         INNER JOIN connectors c ON c.id = hs.connector_id
         INNER JOIN workspace_connectors wc
           ON wc.workspace_id = commands.workspace_id
          AND wc.connector_id = hs.connector_id
         WHERE hs.id = COALESCE(
           (
             SELECT hs_task.id
             FROM host_sessions hs_task
             WHERE hs_task.workspace_id = commands.workspace_id
               AND commands.task_id IS NOT NULL
               AND hs_task.attached_task_id = commands.task_id
             ORDER BY hs_task.updated_at DESC, hs_task.id DESC
             LIMIT 1
           ),
           (
             SELECT hs_thread.id
             FROM host_sessions hs_thread
             WHERE hs_thread.workspace_id = commands.workspace_id
               AND commands.thread_id IS NOT NULL
               AND hs_thread.attached_thread_id = commands.thread_id
               AND (
                 commands.task_id IS NULL
                 OR NOT EXISTS (
                   SELECT 1
                   FROM host_sessions hst
                   WHERE hst.workspace_id = commands.workspace_id
                     AND hst.attached_task_id = commands.task_id
                 )
               )
             ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
             LIMIT 1
           )
         )
           AND (hs.connector_id <> ? OR hs.session_id <> ?)
           AND COALESCE(hs.app_server_present, 0) = 1
           AND wc.can_execute = 1
           AND c.status = 'online'
           AND c.capabilities_json LIKE '%"codex_app_server_exec"%'
       )`
  )
    .bind(
      now,
      command.id,
      connectorId,
      command.lease_target_host_session_id,
      connectorId,
      now,
      connectorId,
      command.lease_target_host_session_id
    )
    .run();

  const released = Boolean((result.meta as { changes?: number } | undefined)?.changes);
  if (released && command.state === "leased" && command.lease_owner_connector_id) {
    await updateConnectorActivity(env, command.lease_owner_connector_id);
  }
  return released
    ? executableAppServerConnectorIdsForWorkspace(env, command.workspace_id)
    : [];
}

export async function recordAgentEvent(
  env: Env,
  connectorId: string,
  event: AgentCommandEvent
): Promise<RecordAgentEventResult> {
  if (!env.DB) return { accepted: false };

  const command = await env.DB.prepare(
    `SELECT id, workspace_id, thread_id, task_id, type, target_connector_id, target_connector_id_source,
            lease_owner_connector_id, state, lease_target_host_session_id
     FROM commands
     WHERE id = ?
     LIMIT 1`
  )
    .bind(event.command_id)
    .first<{
      id: string;
      workspace_id: string;
      thread_id: string | null;
      task_id: string | null;
      type: CommandSummary["type"];
      target_connector_id: string | null;
      target_connector_id_source: CommandTargetConnectorIdSource | null;
      lease_owner_connector_id: string | null;
      lease_target_host_session_id: string | null;
      state: CommandSummary["state"];
    }>();

  if (!command) return { accepted: false };
  if (command.target_connector_id && command.target_connector_id !== connectorId) {
    return { accepted: false };
  }
  if (command.lease_owner_connector_id !== connectorId) return { accepted: false };
  if (!isActiveCommandState(command.state)) return { accepted: false };
  const requireCurrentAppServerStartTarget = requiresCurrentAppServerStartTarget(command, event);
  const resolutionInteractionId = turnInteractionResolutionInteractionId(event);
  if (resolutionInteractionId && await hasTurnInteractionResolution(env, command.id, resolutionInteractionId)) {
    return { accepted: true };
  }

  const now = new Date().toISOString();
  if (requireCurrentAppServerStartTarget && !event.target_host_session_id) {
    const dispatchPending = await releaseRejectedAppServerStartLease(env, connectorId, command, now);
    const failedEvent = dispatchPending
      ? undefined
      : await failRejectedExplicitAppServerStartLease(env, connectorId, command, now);
    const result: RecordAgentEventResult = { accepted: false, dispatch_pending: dispatchPending };
    if (failedEvent) {
      result.event = failedEvent;
    }
    return result;
  }

  const nextState = commandStateForEvent(event.kind);

  if (nextState) {
    const result = await updateCommandStateForAgentEvent(env, connectorId, command, event, nextState, now, {
      requireCurrentAppServerStartTarget
    });
    if (!((result.meta as { changes?: number } | undefined)?.changes)) {
      const dispatchPending =
        requireCurrentAppServerStartTarget && event.kind === "command.started"
          ? await releaseRejectedAppServerStartLease(env, connectorId, command, now)
          : false;
      const failedEvent =
        !dispatchPending && requireCurrentAppServerStartTarget && event.kind === "command.started"
          ? await failRejectedExplicitAppServerStartLease(env, connectorId, command, now)
          : undefined;
      const rejectedResult: RecordAgentEventResult = { accepted: false, dispatch_pending: dispatchPending };
      if (failedEvent) {
        rejectedResult.event = failedEvent;
      }
      return rejectedResult;
    }
  }

  if (command.task_id) {
    const taskState = taskStateForEvent(event.kind);
    if (taskState) {
      await env.DB.prepare(
        `UPDATE tasks
         SET state = ?, connector_id = ?, assigned_agent = 'chaop-agent', updated_at = ?
         WHERE id = ?`
      )
        .bind(taskState, connectorId, now, command.task_id)
        .run();
    }
  }

  let threadEvent: ThreadEvent | undefined;
  try {
    threadEvent = command.thread_id
      ? await appendEvent(env, {
        workspace_id: command.workspace_id,
        thread_id: command.thread_id,
        command_id: command.id,
        kind: event.kind,
        priority: event.priority,
        summary: event.summary,
        payload: event.payload
      })
      : undefined;
  } catch (error) {
    if (
      resolutionInteractionId &&
      isUniqueConstraintError(error) &&
      await hasTurnInteractionResolution(env, command.id, resolutionInteractionId)
    ) {
      return { accepted: true };
    }
    throw error;
  }

  await env.DB.prepare(
    `UPDATE connectors
     SET last_seen_at = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(now, now, connectorId)
    .run();
  await updateConnectorActivity(env, connectorId);
  const result: RecordAgentEventResult = { accepted: true };
  if (threadEvent) {
    result.event = threadEvent;
  }
  return result;
}

async function releaseRejectedAppServerStartLease(
  env: Env,
  connectorId: string,
  command: {
    id: string;
    lease_target_host_session_id: string | null;
    target_connector_id_source: CommandTargetConnectorIdSource | null;
  },
  now: string
): Promise<boolean> {
  if (!command.lease_target_host_session_id) {
    return false;
  }

  const clearImplicitTarget = command.target_connector_id_source === "attached" ? 1 : 0;
  const result = await env.DB!.prepare(
    `UPDATE commands
     SET state = 'pending',
         target_connector_id = CASE WHEN ? THEN NULL ELSE target_connector_id END,
         target_connector_id_source = CASE WHEN ? THEN 'auto' ELSE target_connector_id_source END,
         lease_owner_connector_id = NULL,
         lease_until = NULL,
         lease_target_host_session_id = (
           SELECT hs.session_id
           FROM host_sessions hs
           WHERE hs.id = COALESCE(
             (
               SELECT hs_task.id
               FROM host_sessions hs_task
               WHERE hs_task.workspace_id = commands.workspace_id
                 AND commands.task_id IS NOT NULL
                 AND hs_task.attached_task_id = commands.task_id
               ORDER BY hs_task.updated_at DESC, hs_task.id DESC
               LIMIT 1
             ),
             (
               SELECT hs_thread.id
               FROM host_sessions hs_thread
               WHERE hs_thread.workspace_id = commands.workspace_id
                 AND commands.thread_id IS NOT NULL
                 AND hs_thread.attached_thread_id = commands.thread_id
                 AND (
                   commands.task_id IS NULL
                   OR NOT EXISTS (
                     SELECT 1
                     FROM host_sessions hst
                     WHERE hst.workspace_id = commands.workspace_id
                       AND hst.attached_task_id = commands.task_id
                   )
                 )
               ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
               LIMIT 1
             )
           )
         ),
         updated_at = ?
     WHERE id = ?
       AND lease_owner_connector_id = ?
       AND state = 'leased'
       AND lease_target_host_session_id IS NOT NULL
       AND lease_target_host_session_id = ?
       AND EXISTS (
         SELECT 1
         FROM host_sessions hs
         INNER JOIN connectors c ON c.id = hs.connector_id
         INNER JOIN workspace_connectors wc
           ON wc.workspace_id = commands.workspace_id
          AND wc.connector_id = hs.connector_id
         WHERE hs.id = COALESCE(
           (
             SELECT hs_task.id
             FROM host_sessions hs_task
             WHERE hs_task.workspace_id = commands.workspace_id
               AND commands.task_id IS NOT NULL
               AND hs_task.attached_task_id = commands.task_id
             ORDER BY hs_task.updated_at DESC, hs_task.id DESC
             LIMIT 1
           ),
           (
             SELECT hs_thread.id
             FROM host_sessions hs_thread
             WHERE hs_thread.workspace_id = commands.workspace_id
               AND commands.thread_id IS NOT NULL
               AND hs_thread.attached_thread_id = commands.thread_id
               AND (
                 commands.task_id IS NULL
                 OR NOT EXISTS (
                   SELECT 1
                   FROM host_sessions hst
                   WHERE hst.workspace_id = commands.workspace_id
                     AND hst.attached_task_id = commands.task_id
                 )
               )
             ORDER BY hs_thread.updated_at DESC, hs_thread.id DESC
             LIMIT 1
           )
         )
           AND (hs.connector_id <> ? OR hs.session_id <> ?)
           AND hs.app_server_present = 1
           AND wc.can_execute = 1
           AND c.status = 'online'
           AND c.capabilities_json LIKE '%"codex_app_server_exec"%'
           AND (? OR commands.target_connector_id IS NULL OR hs.connector_id = commands.target_connector_id)
       )`
  )
    .bind(
      clearImplicitTarget,
      clearImplicitTarget,
      now,
      command.id,
      connectorId,
      command.lease_target_host_session_id,
      connectorId,
      command.lease_target_host_session_id,
      clearImplicitTarget
    )
    .run();
  const released = Boolean((result.meta as { changes?: number } | undefined)?.changes);
  if (released) {
    await updateConnectorActivity(env, connectorId);
  }
  return released;
}

async function failRejectedExplicitAppServerStartLease(
  env: Env,
  connectorId: string,
  command: {
    id: string;
    workspace_id: string;
    thread_id: string | null;
    task_id: string | null;
    lease_target_host_session_id: string | null;
    target_connector_id_source: CommandTargetConnectorIdSource | null;
  },
  now: string
): Promise<ThreadEvent | undefined> {
  if (command.target_connector_id_source !== "explicit" || !command.lease_target_host_session_id) {
    return undefined;
  }

  const result = await env.DB!.prepare(
    `UPDATE commands
     SET state = 'failed',
         lease_owner_connector_id = NULL,
         lease_until = NULL,
         updated_at = ?
     WHERE id = ?
       AND lease_owner_connector_id = ?
       AND state = 'leased'
       AND lease_target_host_session_id IS NOT NULL
       AND lease_target_host_session_id = ?
       AND target_connector_id_source = 'explicit'`
  )
    .bind(now, command.id, connectorId, command.lease_target_host_session_id)
    .run();
  if (!((result.meta as { changes?: number } | undefined)?.changes)) {
    return undefined;
  }

  await updateConnectorActivity(env, connectorId);

  if (command.task_id) {
    await env.DB!.prepare(
      `UPDATE tasks
       SET state = 'failed', updated_at = ?
       WHERE id = ?`
    )
      .bind(now, command.task_id)
      .run();
  }

  if (!command.thread_id) {
    return undefined;
  }

  return await appendEvent(env, {
    workspace_id: command.workspace_id,
    thread_id: command.thread_id,
    command_id: command.id,
    kind: "command.failed",
    priority: "P1",
    summary: "Explicit app-server target changed before the command could start."
  });
}

export async function failActiveCommandsForConnector(
  env: Env,
  connectorId: string,
  options: {
    commandIds?: string[];
    failureSummary?: string;
    refreshConnectorActivity?: boolean;
    now?: string;
  } = {}
): Promise<ThreadEvent[]> {
  if (!env.DB) return [];

  const now = options.now ?? new Date().toISOString();
  const scopedCommandIds = options.commandIds ? [...new Set(options.commandIds)].filter(Boolean) : undefined;
  const activeCommands = scopedCommandIds
    ? (await Promise.all(scopedCommandIds.map((commandId) =>
      env.DB!.prepare(
        `SELECT id, workspace_id, thread_id, task_id, type, prompt, state, target_connector_id, created_at, updated_at
         FROM commands
         WHERE id = ? AND lease_owner_connector_id = ? AND state IN ('leased', 'running')
         LIMIT 1`
      )
        .bind(commandId, connectorId)
        .first<CommandRow>()
    ))).filter((row): row is CommandRow => Boolean(row))
    : await allRows<CommandRow>(
      env.DB.prepare(
        `SELECT id, workspace_id, thread_id, task_id, type, prompt, state, target_connector_id, created_at, updated_at
         FROM commands
         WHERE lease_owner_connector_id = ? AND state IN ('leased', 'running')
         ORDER BY updated_at ASC`
      )
        .bind(connectorId)
    );

  const events: ThreadEvent[] = [];
  for (const command of activeCommands) {
    const result = await env.DB.prepare(
      `UPDATE commands
       SET state = 'failed', lease_owner_connector_id = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND lease_owner_connector_id = ? AND state IN ('leased', 'running')`
    )
      .bind(now, command.id, connectorId)
      .run();
    if (!((result.meta as { changes?: number } | undefined)?.changes)) {
      continue;
    }

    if (command.task_id) {
      await env.DB.prepare(
        `UPDATE tasks
         SET state = 'failed', updated_at = ?
         WHERE id = ?`
      )
        .bind(now, command.task_id)
        .run();
    }

    if (command.thread_id) {
      const event = await appendEvent(env, {
        workspace_id: command.workspace_id,
        thread_id: command.thread_id,
        command_id: command.id,
        kind: "command.failed",
        priority: "P1",
        summary: options.failureSummary ?? "Connector disconnected before the command completed."
      });
      if (event) {
        events.push(event);
      }
    }
  }

  if (options.refreshConnectorActivity !== false) {
    await updateConnectorActivity(env, connectorId);
  }

  return events;
}

export async function markConnectorOffline(env: Env, connectorId: string, now = new Date().toISOString()): Promise<void> {
  if (!env.DB) return;

  await env.DB.prepare(
    `UPDATE connectors
     SET status = 'offline', active_command_count = 0, updated_at = ?
     WHERE id = ?`
  )
    .bind(now, connectorId)
    .run();
}

export async function markConnectorDisconnected(env: Env, connectorId: string): Promise<ThreadEvent[]> {
  if (!env.DB) return [];

  const now = new Date().toISOString();
  const events = await failActiveCommandsForConnector(env, connectorId, {
    now,
    refreshConnectorActivity: false
  });
  if (await dogfoodSafetyActionAllowed(env, "app_server_instances_report", now)) {
    await markAppServerInstancesStoppedForConnector(env, connectorId, now);
  }
  await markConnectorOffline(env, connectorId, now);
  return events;
}

async function ensureUser(env: Env, user: BrowserIdentity): Promise<void> {
  if (!env.DB) return;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, role, created_at)
     VALUES (?, ?, ?, 'operator', ?)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       name = excluded.name`
  )
    .bind(user.id, user.email, user.name, now)
    .run();
}

async function retireDuplicateConnectors(
  env: Env,
  connectorId: string,
  registration: AgentBootstrapRequest,
  now: string
): Promise<void> {
  const duplicates = await allRows<{ id: string }>(
    env.DB!.prepare(
      `SELECT id
       FROM connectors
       WHERE id <> ? AND name = ? AND hostname = ?`
    )
      .bind(connectorId, registration.connector_name, registration.hostname)
  );

  for (const duplicate of duplicates) {
    await markConnectorDisconnected(env, duplicate.id);
    await migrateHostSessionsToConnector(env, duplicate.id, connectorId, registration.hostname, now);
  }

  await env.DB!.prepare(
    `UPDATE connectors
     SET status = 'offline',
         active_command_count = 0,
         token_hash = CASE
           WHEN token_hash LIKE 'retired:%' THEN token_hash
           ELSE 'retired:' || id || ':' || token_hash
         END,
         updated_at = ?
     WHERE id <> ? AND name = ? AND hostname = ?`
  )
    .bind(now, connectorId, registration.connector_name, registration.hostname)
    .run();
}

async function migrateHostSessionsToConnector(
  env: Env,
  fromConnectorId: string,
  toConnectorId: string,
  hostname: string,
  now: string
): Promise<void> {
  const rows = await allRows<HostSessionRow>(
    env.DB!.prepare(
      `SELECT id, connector_id, hostname, workspace_id, session_id, title, title_source, cwd,
        app_server_present, attached_task_id, attached_thread_id, updated_at
       FROM host_sessions
       WHERE connector_id = ?`
    )
      .bind(fromConnectorId)
  );

  for (const row of rows) {
    await env.DB!.prepare(
      `INSERT INTO host_sessions (
         id, connector_id, hostname, workspace_id, session_id, title, title_source, app_server_present,
         cwd, attached_task_id, attached_thread_id, discovered_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connector_id, session_id) DO UPDATE SET
         hostname = excluded.hostname,
         workspace_id = excluded.workspace_id,
         title = excluded.title,
         title_source = excluded.title_source,
         app_server_present = CASE
           WHEN host_sessions.app_server_present = 1 THEN 1
           ELSE excluded.app_server_present
         END,
         cwd = excluded.cwd,
         attached_task_id = COALESCE(host_sessions.attached_task_id, excluded.attached_task_id),
         attached_thread_id = COALESCE(host_sessions.attached_thread_id, excluded.attached_thread_id),
         updated_at = excluded.updated_at`
    )
      .bind(
        hostSessionId(toConnectorId, row.session_id),
        toConnectorId,
        hostname,
        row.workspace_id,
        row.session_id,
        row.title,
        row.title_source,
        row.app_server_present ? 1 : 0,
        row.cwd,
        row.attached_task_id,
        row.attached_thread_id,
        row.updated_at,
        now
      )
      .run();
    await retargetAttachedCommandsForMigratedHostSession(env, row, fromConnectorId, toConnectorId, now);
    await retargetExplicitAppServerCommandsForMigratedHostSession(env, row, fromConnectorId, toConnectorId, now);
  }

  await env.DB!.prepare(
    `DELETE FROM host_sessions
     WHERE connector_id = ?`
  )
    .bind(fromConnectorId)
    .run();
}

async function retargetAttachedCommandsForMigratedHostSession(
  env: Env,
  row: HostSessionRow,
  fromConnectorId: string,
  toConnectorId: string,
  now: string
): Promise<void> {
  const taskId = row.attached_task_id;
  const threadId = row.attached_thread_id;
  if (!taskId && !threadId) {
    return;
  }

  await env.DB!.prepare(
    `UPDATE commands
     SET target_connector_id = ?,
         updated_at = ?
     WHERE workspace_id = ?
       AND state = 'pending'
       AND target_connector_id = ?
       AND target_connector_id_source = 'attached'
       AND (lease_target_host_session_id IS NULL OR lease_target_host_session_id = ?)
       AND (
         (? IS NOT NULL AND task_id = ?)
         OR (? IS NOT NULL AND thread_id = ?)
       )
       AND EXISTS (
         SELECT 1
         FROM host_sessions hs
         WHERE hs.connector_id = ?
           AND hs.session_id = ?
           AND hs.workspace_id = commands.workspace_id
           AND (
             (? IS NOT NULL AND hs.attached_task_id = ?)
             OR (? IS NOT NULL AND hs.attached_thread_id = ?)
           )
       )`
  )
    .bind(
      toConnectorId,
      now,
      row.workspace_id,
      fromConnectorId,
      row.session_id,
      taskId,
      taskId,
      threadId,
      threadId,
      toConnectorId,
      row.session_id,
      taskId,
      taskId,
      threadId,
      threadId
    )
    .run();
}

async function retargetExplicitAppServerCommandsForMigratedHostSession(
  env: Env,
  row: HostSessionRow,
  fromConnectorId: string,
  toConnectorId: string,
  now: string
): Promise<void> {
  await env.DB!.prepare(
    `UPDATE commands
     SET target_connector_id = ?,
         updated_at = ?
     WHERE workspace_id = ?
       AND type = 'codex'
       AND state = 'pending'
       AND target_connector_id = ?
       AND target_connector_id_source = 'explicit'
       AND lease_target_host_session_id = ?
       AND EXISTS (
         SELECT 1
         FROM host_sessions hs
         WHERE hs.connector_id = ?
           AND hs.session_id = ?
           AND hs.workspace_id = commands.workspace_id
           AND hs.app_server_present = 1
       )`
  )
    .bind(toConnectorId, now, row.workspace_id, fromConnectorId, row.session_id, toConnectorId, row.session_id)
    .run();
}

async function listConnectors(env: Env): Promise<ConnectorSummary[]> {
  const rows = await allRows<ConnectorRow>(
    env.DB!.prepare(
      `SELECT id, name, hostname, status, realtime_mode, budget_state,
        logical_agent_count, active_command_count, capabilities_json, last_seen_at, updated_at
       FROM connectors
       WHERE status <> 'offline'
       ORDER BY CASE status WHEN 'online' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END, updated_at DESC`
    )
  );
  return rows.map(connectorSummaryFromRow);
}

export async function getConnectorSummary(
  env: Env,
  connectorId: string,
  options: { includeOffline?: boolean } = {}
): Promise<ConnectorSummary | undefined> {
  if (!env.DB) return undefined;

  const row = await env.DB.prepare(
    `SELECT id, name, hostname, status, realtime_mode, budget_state,
        logical_agent_count, active_command_count, capabilities_json, last_seen_at, updated_at
     FROM connectors
     WHERE id = ?
       AND (? = 1 OR status <> 'offline')`
  )
    .bind(connectorId, options.includeOffline ? 1 : 0)
    .first<ConnectorRow>();
  return row ? connectorSummaryFromRow(row) : undefined;
}

async function listAppServerInstances(env: Env): Promise<AppServerInstanceSummary[]> {
  const rows = await allRows<AppServerInstanceRow>(
    env.DB!.prepare(
      `SELECT asi.id, asi.connector_id, asi.instance_key, asi.scope,
              asi.workspace_id, asi.thread_id, asi.placement_key, asi.endpoint_type, asi.state,
              asi.active_turn_count, asi.generation, asi.status_summary, asi.last_error,
              asi.last_seen_at, asi.state_changed_at, asi.updated_at
       FROM app_server_instances asi
       INNER JOIN connectors c ON c.id = asi.connector_id
       WHERE c.status <> 'offline'
         AND c.capabilities_json LIKE '%"app_server_instance_state"%'
       ORDER BY CASE asi.state
          WHEN 'healthy' THEN 0
          WHEN 'degraded' THEN 1
          WHEN 'restarting' THEN 2
          WHEN 'draining' THEN 3
          WHEN 'stopped' THEN 4
          ELSE 5
        END, asi.updated_at DESC`
    )
  );
  return rows.map(appServerInstanceFromRow);
}

async function listAppServerInstancesForConnector(env: Env, connectorId: string): Promise<AppServerInstanceSummary[]> {
  const rows = await allRows<AppServerInstanceRow>(
    env.DB!.prepare(
      `SELECT id, connector_id, instance_key, scope, workspace_id, thread_id, placement_key,
              endpoint_type, state,
              active_turn_count, generation, status_summary, last_error,
              last_seen_at, state_changed_at, updated_at
       FROM app_server_instances
       WHERE connector_id = ?
       ORDER BY instance_key ASC`
    ).bind(connectorId)
  );
  return rows.map(appServerInstanceFromRow);
}

async function currentUsageWindow(
  env: Env,
  windowType: BudgetWindowType,
  generatedAt: string
): Promise<UsageWindowRow | undefined> {
  const row = await env.DB!.prepare(
    `SELECT id, window_type, window_start, window_end, budget_state, used_pct,
            events_received, events_compacted, events_delayed, local_spool_bytes, updated_at
     FROM usage_windows
     WHERE window_type = ? AND window_start <= ? AND window_end > ?
     ORDER BY window_end DESC, updated_at DESC, id DESC
     LIMIT 1`
  )
    .bind(windowType, generatedAt, generatedAt)
    .first<UsageWindowRow>();
  return row ?? undefined;
}

async function listConnectorBudgetStates(env: Env): Promise<BudgetStateCountRow[]> {
  return await allRows<BudgetStateCountRow>(
    env.DB!.prepare(
      `SELECT budget_state, COUNT(*) AS count
       FROM connectors
       WHERE status <> 'offline'
       GROUP BY budget_state`
    )
  );
}

async function listTaskBudgetStates(env: Env): Promise<BudgetStateCountRow[]> {
  return await allRows<BudgetStateCountRow>(
    env.DB!.prepare(
      `SELECT budget_state, COUNT(*) AS count
       FROM tasks
       WHERE archived_at IS NULL
       GROUP BY budget_state`
    )
  );
}

function connectorBudgetStateCounts(connectors: ConnectorSummary[]): BudgetStateCountRow[] {
  return budgetStateCounts(
    connectors.filter((connector) => connector.status !== "offline").map((connector) => connector.budget_state)
  );
}

function taskBudgetStateCounts(tasks: TaskSummary[]): BudgetStateCountRow[] {
  return budgetStateCounts(tasks.filter((task) => task.archived_at === undefined).map((task) => task.budget_state));
}

function budgetStateCounts(states: BudgetState[]): BudgetStateCountRow[] {
  const counts = new Map<BudgetState, number>();
  for (const state of states) {
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts].map(([budget_state, count]) => ({ budget_state, count }));
}

function connectorSummaryFromRow(row: ConnectorRow): ConnectorSummary {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    status: row.status,
    capabilities: parseCapabilities(row.capabilities_json),
    logical_agent_count: row.logical_agent_count,
    active_command_count: row.active_command_count,
    realtime_mode: row.realtime_mode,
    budget_state: row.budget_state,
    last_seen_at: row.last_seen_at ?? undefined,
    updated_at: row.updated_at ?? undefined
  };
}

function appServerInstanceFromRow(row: AppServerInstanceRow): AppServerInstanceSummary {
  return {
    id: row.id,
    connector_id: row.connector_id,
    instance_key: row.instance_key,
    scope: row.scope,
    workspace_id: row.workspace_id ?? undefined,
    thread_id: row.thread_id ?? undefined,
    endpoint_type: row.endpoint_type,
    state: row.state,
    active_turn_count: row.active_turn_count,
    generation: row.generation,
    status_summary: row.status_summary ?? undefined,
    last_error: row.last_error ?? undefined,
    last_seen_at: row.last_seen_at,
    state_changed_at: row.state_changed_at,
    updated_at: row.updated_at
  };
}

async function stopAppServerInstanceRow(
  env: Env,
  row: AppServerInstanceRow,
  stoppedSummary: string,
  syncedAt: string
): Promise<AppServerInstanceSummary> {
  const fingerprint = appServerStoppedFingerprint(row, stoppedSummary);
  await env.DB!.prepare(
    `UPDATE app_server_instances
     SET state = 'stopped',
         active_turn_count = 0,
         status_summary = ?,
         last_error = NULL,
         report_fingerprint = ?,
         last_seen_at = ?,
         state_changed_at = ?,
         summary_changed_at = ?,
         updated_at = ?
     WHERE id = ?`
  )
    .bind(
      stoppedSummary,
      fingerprint,
      syncedAt,
      syncedAt,
      syncedAt,
      syncedAt,
      row.id
    )
    .run();
  return appServerInstanceFromRow({
    ...row,
    state: "stopped",
    active_turn_count: 0,
    status_summary: stoppedSummary,
    last_error: null,
    report_fingerprint: fingerprint,
    last_seen_at: syncedAt,
    state_changed_at: syncedAt,
    summary_changed_at: syncedAt,
    updated_at: syncedAt
  });
}

function shouldPersistAppServerInstance(
  existing: AppServerInstanceRow | null,
  instance: AgentAppServerInstancesReport["instances"][number],
  fingerprint: string,
  syncedAt: string
): boolean {
  if (!existing) return true;
  if (existing.state !== instance.state) return true;
  if (existing.endpoint_type !== instance.endpoint_type) return true;
  if (existing.scope !== instance.scope) return true;
  if ((existing.workspace_id ?? null) !== (instance.workspace_id ?? null)) return true;
  if ((existing.thread_id ?? null) !== (instance.thread_id ?? null)) return true;
  if (existing.active_turn_count !== (instance.active_turn_count ?? 0)) return true;
  if (existing.generation !== (instance.generation ?? 0)) return true;
  if (existing.report_fingerprint !== fingerprint) return true;
  const lastSeen = Date.parse(existing.last_seen_at);
  const current = Date.parse(syncedAt);
  if (Number.isNaN(lastSeen) || Number.isNaN(current)) return true;
  return current - lastSeen >= APP_SERVER_UNCHANGED_SUMMARY_DEBOUNCE_MS;
}

function appServerInstanceFingerprint(instance: AgentAppServerInstancesReport["instances"][number]): string {
  return stableFingerprint([
    instance.instance_key,
    instance.scope,
    appServerInstancePlacementKey(instance),
    instance.workspace_id ?? "",
    instance.thread_id ?? "",
    instance.endpoint_type,
    instance.state,
    String(instance.active_turn_count ?? 0),
    String(instance.generation ?? 0),
    instance.status_summary ?? "",
    instance.last_error ?? ""
  ]);
}

function appServerSummaryFingerprint(row: AppServerInstanceRow): string {
  return stableFingerprint([
    row.instance_key,
    row.scope,
    row.placement_key,
    row.workspace_id ?? "",
    row.thread_id ?? "",
    row.endpoint_type,
    row.state,
    String(row.active_turn_count),
    String(row.generation),
    row.status_summary ?? "",
    row.last_error ?? ""
  ]);
}

function appServerStoppedFingerprint(row: AppServerInstanceRow, summary: string): string {
  return stableFingerprint([
    row.instance_key,
    row.scope,
    row.placement_key,
    row.workspace_id ?? "",
    row.thread_id ?? "",
    row.endpoint_type,
    "stopped",
    "0",
    String(row.generation),
    summary,
    ""
  ]);
}

function appServerInstancePlacementKey(instance: Pick<AgentAppServerInstance, "scope" | "workspace_id" | "thread_id">): string {
  if (instance.scope === "workspace") return `workspace:${instance.workspace_id ?? ""}`;
  if (instance.scope === "thread") return `thread:${instance.thread_id ?? ""}`;
  return "connector";
}

function appServerInstanceIdentityKey(instanceKey: string, placementKey: string): string {
  return stableFingerprint([instanceKey, placementKey]);
}

function appServerInstanceId(connectorId: string, instanceKey: string, placementKey: string): string {
  const identity = placementKey === "connector"
    ? [connectorId, instanceKey]
    : [connectorId, instanceKey, placementKey];
  return `app-server-${stableFingerprint(identity)}`;
}

function parseCapabilities(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function listWorkspaces(env: Env): Promise<WorkspaceSummary[]> {
  const rows = await allRows<WorkspaceRow>(
    env.DB!.prepare(
      `SELECT id, name, repo_url
       FROM workspaces
       ORDER BY updated_at DESC`
    )
  );
  const links = await allRows<{ workspace_id: string; connector_id: string }>(
    env.DB!.prepare(
      `SELECT wc.workspace_id, wc.connector_id
       FROM workspace_connectors wc
       INNER JOIN connectors c ON c.id = wc.connector_id
       WHERE wc.can_execute = 1 AND c.status <> 'offline'`
    )
  );
  const connectorIdsByWorkspace = new Map<string, string[]>();
  for (const link of links) {
    connectorIdsByWorkspace.set(link.workspace_id, [
      ...(connectorIdsByWorkspace.get(link.workspace_id) ?? []),
      link.connector_id
    ]);
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    repo_url: row.repo_url ?? undefined,
    connector_ids: connectorIdsByWorkspace.get(row.id) ?? [],
    active_thread_count: 0
  }));
}

async function listThreads(env: Env): Promise<ThreadSummary[]> {
  const rows = await allRows<ThreadRow>(
    env.DB!.prepare(
      `SELECT id, workspace_id, title, state, last_seq, updated_at, realtime_mode
       FROM threads
       ORDER BY updated_at DESC`
    )
  );
  return rows.map((row) => ({ ...row }));
}

async function listHostSessions(env: Env): Promise<HostSessionSummary[]> {
  const rows = await allRows<HostSessionRow>(
    env.DB!.prepare(
      `SELECT hs.id, hs.connector_id, hs.hostname, hs.workspace_id, hs.session_id, hs.title, hs.title_source,
        hs.app_server_present, hs.cwd, hs.updated_at, hs.attached_task_id, hs.attached_thread_id
       FROM host_sessions hs
       INNER JOIN connectors c ON c.id = hs.connector_id
       WHERE c.status <> 'offline'
       ORDER BY
         CASE WHEN hs.attached_task_id IS NOT NULL OR hs.attached_thread_id IS NOT NULL THEN 0 ELSE 1 END,
         hs.updated_at DESC
       LIMIT 200`
    )
  );
  return rows.map(hostSessionFromRow);
}

async function listHostSessionSyncs(env: Env): Promise<HostSessionSyncSummary[]> {
  return allRows<HostSessionSyncSummary>(
    env.DB!.prepare(
      `SELECT connector_id, synced_at, reported_session_count, stored_session_count
       FROM host_session_syncs
       ORDER BY synced_at DESC`
    )
  );
}

async function listTaskCategories(env: Env): Promise<TaskCategory[]> {
  const rows = await allRows<TaskCategory>(
    env.DB!.prepare(
      `SELECT id, name, colour
       FROM task_categories
       ORDER BY sort_order ASC, name ASC`
    )
  );
  return rows.length > 0 ? rows : taskCategories;
}

async function listTasks(env: Env): Promise<TaskSummary[]> {
  const rows = await allRows<TaskRow>(
    env.DB!.prepare(
      `SELECT id, workspace_id, thread_id, title, category_id, state, connector_id,
        assigned_agent, realtime_mode, budget_state, archived_at, updated_at
       FROM tasks
       ORDER BY updated_at DESC`
    )
  );
  return rows.map((row) => ({
    ...row,
    connector_id: row.connector_id ?? undefined,
    assigned_agent: row.assigned_agent ?? undefined,
    archived_at: row.archived_at ?? undefined
  }));
}

async function loadTask(env: Env, taskId: string): Promise<TaskSummary | undefined> {
  const row = await env.DB!.prepare(
    `SELECT id, workspace_id, thread_id, title, category_id, state, connector_id,
      assigned_agent, realtime_mode, budget_state, archived_at, updated_at
     FROM tasks
     WHERE id = ?
     LIMIT 1`
  )
    .bind(taskId)
    .first<TaskRow>();
  return row
    ? {
      ...row,
      connector_id: row.connector_id ?? undefined,
      assigned_agent: row.assigned_agent ?? undefined,
      archived_at: row.archived_at ?? undefined
    }
    : undefined;
}

async function loadThread(env: Env, threadId: string): Promise<ThreadSummary | undefined> {
  const row = await env.DB!.prepare(
    `SELECT id, workspace_id, title, state, last_seq, updated_at, realtime_mode
     FROM threads
     WHERE id = ?
     LIMIT 1`
  )
    .bind(threadId)
    .first<ThreadRow>();
  return row ? { ...row } : undefined;
}

async function findHostSession(
  env: Env,
  sessionId: string,
  connectorId?: string
): Promise<HostSessionSummary | undefined> {
  const statement = connectorId
    ? env.DB!.prepare(
      `SELECT hs.id, hs.connector_id, hs.hostname, hs.workspace_id, hs.session_id, hs.title, hs.title_source,
        hs.app_server_present, hs.cwd, hs.updated_at, hs.attached_task_id, hs.attached_thread_id
       FROM host_sessions hs
       INNER JOIN connectors c ON c.id = hs.connector_id
       WHERE hs.session_id = ? AND hs.connector_id = ? AND c.status <> 'offline'
       ORDER BY hs.updated_at DESC
       LIMIT 1`
    ).bind(sessionId, connectorId)
    : env.DB!.prepare(
      `SELECT hs.id, hs.connector_id, hs.hostname, hs.workspace_id, hs.session_id, hs.title, hs.title_source,
        hs.app_server_present, hs.cwd, hs.updated_at, hs.attached_task_id, hs.attached_thread_id
       FROM host_sessions hs
       INNER JOIN connectors c ON c.id = hs.connector_id
       WHERE hs.session_id = ? AND c.status <> 'offline'
       ORDER BY hs.updated_at DESC
       LIMIT 1`
    ).bind(sessionId);
  const row = await statement.first<HostSessionRow>();
  return row ? hostSessionFromRow(row) : undefined;
}

async function listRecentCommands(env: Env): Promise<CommandSummary[]> {
  const rows = await allRows<CommandRow>(
    env.DB!.prepare(
      `SELECT id, workspace_id, thread_id, task_id, type, prompt, state,
        execution_mode, target_connector_id, created_at, updated_at
       FROM commands
       ORDER BY created_at DESC
       LIMIT 10`
    )
  );
  return rows.map(commandFromRow);
}

async function listRecentEvents(env: Env): Promise<ThreadEvent[]> {
  const rows = await allRows<ThreadEventRow>(
    env.DB!.prepare(
      `SELECT id, thread_id, command_id, seq, kind, priority, summary, payload_json, created_at
       FROM events
       ORDER BY created_at DESC, seq DESC
       LIMIT 30`
    )
  );
  return rows.reverse().map(threadEventFromRow);
}

function threadEventFromRow(row: ThreadEventRow): ThreadEvent {
  const event: ThreadEvent = {
    id: row.id,
    thread_id: row.thread_id,
    command_id: row.command_id ?? undefined,
    seq: row.seq,
    kind: row.kind,
    priority: row.priority,
    summary: row.summary,
    created_at: row.created_at
  };
  if (row.payload_json) {
    try {
      event.payload = JSON.parse(row.payload_json) as ThreadEvent["payload"];
    } catch {
      // Ignore malformed optional payloads; the event summary remains usable.
    }
  }
  return event;
}

function parseTurnInteractionRequestPayload(payloadJson: string | null): TurnInteractionRequestPayload | undefined {
  if (!payloadJson) return undefined;
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (!isTurnInteractionRequestPayload(payload)) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

function turnInteractionAutoResolutionExpired(
  payload: TurnInteractionRequestPayload,
  createdAt: string,
  nowMs = Date.now()
): boolean {
  if (payload.request_kind !== "input") return false;
  const autoResolutionMs = payload.auto_resolution_ms;
  if (typeof autoResolutionMs !== "number" || !Number.isFinite(autoResolutionMs) || autoResolutionMs < 0) {
    return false;
  }
  const graceMs =
    typeof payload.auto_resolution_response_grace_ms === "number" &&
    Number.isFinite(payload.auto_resolution_response_grace_ms) &&
    payload.auto_resolution_response_grace_ms >= 0
      ? payload.auto_resolution_response_grace_ms
      : DEFAULT_TURN_INTERACTION_AUTO_RESOLUTION_RESPONSE_GRACE_MS;
  if (typeof payload.auto_resolution_expires_at === "string") {
    const expiresAtMs = Date.parse(payload.auto_resolution_expires_at);
    if (Number.isFinite(expiresAtMs)) {
      return nowMs >= expiresAtMs + graceMs;
    }
  }
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return false;
  return nowMs >= createdMs + autoResolutionMs + graceMs;
}

function validateTurnInteractionResponseForRequest(
  response: ResolveTurnInteractionRequest,
  request: TurnInteractionRequestPayload
): void {
  if (response.kind !== request.request_kind) {
    throw new CommandTargetError("Turn interaction response does not match the request kind", 400);
  }
  if (response.kind === "approval") {
    const available = request.available_decisions;
    if (available && available.length > 0 && !available.some((decision) => jsonValueEquals(decision, response.decision))) {
      throw new CommandTargetError("Turn interaction approval decision is not available for this request", 400);
    }
    return;
  }

  const questions = request.questions ?? [];
  const expectedIds = new Set(questions.map((question) => question.id).filter((id) => id.trim().length > 0));
  const answerIds = Object.keys(response.answers);
  for (const answerId of answerIds) {
    if (!expectedIds.has(answerId)) {
      throw new CommandTargetError("Turn interaction input response includes an unknown question", 400);
    }
  }
  for (const questionId of expectedIds) {
    const answer = response.answers[questionId];
    if (!answer || !Array.isArray(answer.answers) || answer.answers.length === 0) {
      throw new CommandTargetError("Turn interaction input response is missing a required answer", 400);
    }
    if (answer.answers.some((item) => item.trim().length === 0)) {
      throw new CommandTargetError("Turn interaction input response includes an empty answer", 400);
    }
  }
}

function jsonValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => jsonValueEquals(item, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index] && jsonValueEquals(left[key], right[key]));
  }
  return false;
}

async function hasTurnInteractionResolution(
  env: Env,
  commandId: string,
  interactionId: string
): Promise<boolean> {
  return Boolean(await findTurnInteractionResolution(env, commandId, interactionId));
}

async function findTurnInteractionResolution(
  env: Env,
  commandId: string,
  interactionId: string
): Promise<ThreadEvent | undefined> {
  const row = await env.DB!.prepare(
    `SELECT id, thread_id, command_id, seq, kind, priority, summary, payload_json, created_at
     FROM events
     WHERE command_id = ?
       AND kind IN ('approval.resolved', 'input.received')
       AND json_extract(payload_json, '$.interaction_id') = ?
     ORDER BY created_at DESC, seq DESC
     LIMIT 1`
  )
    .bind(commandId, interactionId)
    .first<ThreadEventRow>();
  return row ? threadEventFromRow(row) : undefined;
}

function turnInteractionResolutionInteractionId(event: AgentCommandEvent): string | undefined {
  if (event.kind !== "approval.resolved" && event.kind !== "input.received") return undefined;
  const payload = event.payload;
  if (!payload || payload.type !== "turn_interaction_resolution") return undefined;
  const interactionId = payload.interaction_id.trim();
  return interactionId.length > 0 ? interactionId : undefined;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT|constraint failed/i.test(message);
}

async function claimTurnInteractionResolution(
  env: Env,
  eventId: string,
  commandId: string,
  interactionId: string,
  responseKind: ResolveTurnInteractionRequest["kind"]
): Promise<void> {
  await deleteStaleTurnInteractionResolutionClaim(env, commandId, interactionId);
  const result = await env.DB!.prepare(
    `INSERT INTO turn_interaction_resolution_claims (
       interaction_id, request_event_id, command_id, response_kind, created_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(command_id, interaction_id) DO NOTHING`
  )
    .bind(interactionId, eventId, commandId, responseKind, new Date().toISOString())
    .run();
  if (result.meta?.changes === 0) {
    throw new CommandTargetError("Turn interaction has already been resolved", 409);
  }
}

async function deleteStaleTurnInteractionResolutionClaim(
  env: Env,
  commandId: string,
  interactionId: string
): Promise<void> {
  const staleBefore = new Date(Date.now() - TURN_INTERACTION_RESOLUTION_CLAIM_TTL_MS).toISOString();
  await env.DB!.prepare(
    `DELETE FROM turn_interaction_resolution_claims
     WHERE command_id = ?
       AND interaction_id = ?
       AND created_at < ?
       AND NOT EXISTS (
         SELECT 1
         FROM events
         WHERE command_id = ?
           AND kind IN ('approval.resolved', 'input.received')
           AND json_extract(payload_json, '$.interaction_id') = ?
       )`
  )
    .bind(commandId, interactionId, staleBefore, commandId, interactionId)
    .run();
}

function isTurnInteractionRequestPayload(value: unknown): value is TurnInteractionRequestPayload {
  if (!isRecord(value)) return false;
  return (
    value.type === "turn_interaction" &&
    typeof value.interaction_id === "string" &&
    value.interaction_id.trim().length > 0 &&
    value.status === "pending" &&
    typeof value.method === "string" &&
    (value.request_kind === "approval" || value.request_kind === "input") &&
    typeof value.app_server_thread_id === "string" &&
    typeof value.app_server_turn_id === "string" &&
    typeof value.title === "string" &&
    (value.auto_resolution_expires_at === undefined || typeof value.auto_resolution_expires_at === "string") &&
    (
      value.auto_resolution_response_grace_ms === undefined ||
      value.auto_resolution_response_grace_ms === null ||
      typeof value.auto_resolution_response_grace_ms === "number"
    )
  );
}

function turnInteractionResolutionEvent(
  response: ResolveTurnInteractionRequest,
  request: TurnInteractionRequestPayload
): { summary: string; payload: NonNullable<ThreadEvent["payload"]> } {
  if (response.kind === "input") {
    const answerCount = Object.keys(response.answers).length;
    return {
      summary: `Input provided for ${request.title}.`,
      payload: {
        type: "turn_interaction_resolution",
        interaction_id: request.interaction_id,
        status: "answered",
        answer_count: answerCount
      }
    };
  }
  const status = turnInteractionApprovalResolutionStatus(response.decision);
  return {
    summary: `Approval ${status.replaceAll("_", " ")} for ${request.title}.`,
    payload: {
      type: "turn_interaction_resolution",
      interaction_id: request.interaction_id,
      status,
      decision: response.decision
    }
  };
}

function turnInteractionApprovalResolutionStatus(
  decision: Extract<ResolveTurnInteractionRequest, { kind: "approval" }>["decision"]
): "accepted" | "accepted_for_session" | "accepted_with_execpolicy_amendment" | "declined" | "cancelled" {
  if (decision === "accept") return "accepted";
  if (decision === "acceptForSession") return "accepted_for_session";
  if (decision === "decline") return "declined";
  if (decision === "cancel") return "cancelled";
  return "accepted_with_execpolicy_amendment";
}

async function chooseConnectorForWorkspace(
  env: Env,
  workspaceId: string,
  commandType: CommandSummary["type"]
): Promise<string | undefined> {
  const row = await env.DB!.prepare(
    `SELECT c.id
     FROM connectors c
     INNER JOIN workspace_connectors wc ON wc.connector_id = c.id
     WHERE wc.workspace_id = ? AND wc.can_execute = 1 AND c.status = 'online'
       AND (? <> 'codex' OR c.capabilities_json LIKE '%"codex_exec"%')
     ORDER BY c.last_seen_at DESC, c.updated_at DESC
     LIMIT 1`
  )
    .bind(workspaceId, commandType)
    .first<{ id: string }>();
  return row?.id;
}

async function findAttachedCommandTarget(
  env: Env,
  scope: { workspaceId: string; threadId?: string | undefined; taskId?: string | undefined }
): Promise<{ connector_id: string; session_id: string; app_server_present: boolean } | undefined> {
  if (scope.taskId) {
    const row = await env.DB!.prepare(
      `SELECT hs.connector_id, hs.session_id, hs.app_server_present
       FROM host_sessions hs
       WHERE hs.workspace_id = ? AND hs.attached_task_id = ?
       ORDER BY hs.updated_at DESC, hs.id DESC
       LIMIT 1`
    )
      .bind(scope.workspaceId, scope.taskId)
      .first<{ connector_id: string; session_id: string; app_server_present: number | boolean | null }>();
    if (row?.connector_id) {
      return {
        connector_id: row.connector_id,
        session_id: row.session_id,
        app_server_present: row.app_server_present === 1 || row.app_server_present === true
      };
    }
  }

  if (scope.threadId) {
    const row = await env.DB!.prepare(
      `SELECT hs.connector_id, hs.session_id, hs.app_server_present
       FROM host_sessions hs
       WHERE hs.workspace_id = ? AND hs.attached_thread_id = ?
       ORDER BY hs.updated_at DESC, hs.id DESC
       LIMIT 1`
    )
      .bind(scope.workspaceId, scope.threadId)
      .first<{ connector_id: string; session_id: string; app_server_present: number | boolean | null }>();
    if (row?.connector_id) {
      return {
        connector_id: row.connector_id,
        session_id: row.session_id,
        app_server_present: row.app_server_present === 1 || row.app_server_present === true
      };
    }
  }

  return undefined;
}

async function findBestLocalThreadConnector(
  env: Env,
  workspaceId: string
): Promise<{ id: string } | undefined> {
  const row = await env.DB!.prepare(
    `SELECT c.id
     FROM connectors c
     INNER JOIN workspace_connectors wc ON wc.connector_id = c.id
     WHERE wc.workspace_id = ? AND wc.can_execute = 1 AND c.status = 'online'
       AND c.capabilities_json LIKE '%"app_server_threads"%'
     ORDER BY c.last_seen_at DESC, c.updated_at DESC
     LIMIT 1`
  )
    .bind(workspaceId)
    .first<{ id: string }>();
  return row ?? undefined;
}

async function findLocalThreadConnector(
  env: Env,
  workspaceId: string,
  connectorId: string
): Promise<{ id: string } | undefined> {
  const row = await env.DB!.prepare(
    `SELECT c.id
     FROM connectors c
     INNER JOIN workspace_connectors wc ON wc.connector_id = c.id
     WHERE c.id = ? AND wc.workspace_id = ? AND wc.can_execute = 1 AND c.status = 'online'
       AND c.capabilities_json LIKE '%"app_server_threads"%'
     LIMIT 1`
  )
    .bind(connectorId, workspaceId)
    .first<{ id: string }>();
  return row ?? undefined;
}

async function resolveCommandScope(
  env: Env,
  request: CreateCommandRequest
): Promise<{ workspaceId: string; threadId?: string | undefined; taskId?: string | undefined }> {
  const workspace = await env.DB!.prepare(
    "SELECT id FROM workspaces WHERE id = ? LIMIT 1"
  )
    .bind(request.workspace_id)
    .first<{ id: string }>();
  if (!workspace) {
    throw new CommandTargetError("Workspace not available");
  }

  let threadId = request.thread_id;
  if (threadId) {
    const thread = await loadCommandThread(env, threadId);
    if (!thread || thread.workspace_id !== request.workspace_id) {
      throw new CommandTargetError("Command thread not available");
    }
  }

  if (request.task_id) {
    const task = await env.DB!.prepare(
      "SELECT id, workspace_id, thread_id FROM tasks WHERE id = ? LIMIT 1"
    )
      .bind(request.task_id)
      .first<{ id: string; workspace_id: string; thread_id: string }>();
    if (!task || task.workspace_id !== request.workspace_id) {
      throw new CommandTargetError("Command task not available");
    }
    if (threadId && task.thread_id !== threadId) {
      throw new CommandTargetError("Command task does not belong to the selected thread");
    }
    if (!threadId) {
      const thread = await loadCommandThread(env, task.thread_id);
      if (!thread || thread.workspace_id !== request.workspace_id) {
        throw new CommandTargetError("Command thread not available");
      }
      threadId = task.thread_id;
    }
  }

  return {
    workspaceId: request.workspace_id,
    threadId,
    taskId: request.task_id
  };
}

async function loadCommandThread(
  env: Env,
  threadId: string
): Promise<{ id: string; workspace_id: string } | null> {
  return await env.DB!.prepare(
    "SELECT id, workspace_id FROM threads WHERE id = ? LIMIT 1"
  )
    .bind(threadId)
    .first<{ id: string; workspace_id: string }>();
}

async function assertConnectorCanExecute(
  env: Env,
  connectorId: string,
  workspaceId: string,
  commandType: CommandSummary["type"],
  options: { requireAppServerExec?: boolean } = {}
): Promise<void> {
  const connector = await env.DB!.prepare(
    `SELECT c.id
     FROM connectors c
     INNER JOIN workspace_connectors wc ON wc.connector_id = c.id
     WHERE c.id = ? AND wc.workspace_id = ? AND wc.can_execute = 1 AND c.status = 'online'
       AND (
         ? <> 'codex'
         OR (
           ? = 1
           AND c.capabilities_json LIKE '%"codex_app_server_exec"%'
         )
         OR (
           ? = 0
           AND c.capabilities_json LIKE '%"codex_exec"%'
         )
       )
     LIMIT 1`
  )
    .bind(
      connectorId,
      workspaceId,
      commandType,
      options.requireAppServerExec ? 1 : 0,
      options.requireAppServerExec ? 1 : 0
    )
    .first<{ id: string }>();
  if (!connector) {
    throw new CommandTargetError("Target connector not available");
  }
}

async function appendEvent(
  env: Env,
  input: EventInput
): Promise<ThreadEvent | undefined> {
  const now = new Date().toISOString();
  const sequence = await env.DB!.prepare(
    `UPDATE threads
     SET last_seq = last_seq + 1, updated_at = ?
     WHERE id = ?
     RETURNING last_seq`
  )
    .bind(now, input.thread_id)
    .first<{ last_seq: number }>();

  if (!sequence) return undefined;

  const seq = sequence.last_seq;
  const event: ThreadEvent = {
    id: `event-${cryptoRandomId().slice(0, 16)}`,
    thread_id: input.thread_id,
    command_id: input.command_id ?? undefined,
    seq,
    kind: input.kind,
    priority: input.priority,
    summary: input.summary,
    payload: input.payload,
    created_at: now
  };
  const payloadJson = input.payload ? JSON.stringify(input.payload) : null;
  try {
    await env.DB!.prepare(
      `INSERT INTO events (id, workspace_id, thread_id, command_id, seq, kind, priority, summary, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        event.id,
        input.workspace_id,
        event.thread_id,
        event.command_id ?? null,
        event.seq,
        event.kind,
        event.priority,
        event.summary,
        payloadJson,
        event.created_at
      )
      .run();
  } catch (error) {
    await rollbackAppendEventSequenceBestEffort(env, event.thread_id, event.seq);
    throw error;
  }
  await recordUsageWindowsForEventsBestEffort(env, [event]);
  return event;
}

async function rollbackAppendEventSequenceBestEffort(env: Env, threadId: string, seq: number): Promise<void> {
  try {
    await env.DB!.prepare(
      `UPDATE threads
       SET last_seq = last_seq - 1
       WHERE id = ?
         AND last_seq = ?`
    )
      .bind(threadId, seq)
      .run();
  } catch {
    // A failed event insert should not mask the original database error.
  }
}

async function recordUsageWindowsForEventsBestEffort(env: Env, events: ThreadEvent[], accountedAt?: string): Promise<void> {
  if (events.length === 0) return;
  try {
    await recordUsageWindowsForEvents(env, events, accountedAt);
  } catch (error) {
    console.warn("Usage window update failed", {
      event_count: events.length,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function recordUsageWindowsForEvents(env: Env, events: ThreadEvent[], accountedAt?: string): Promise<void> {
  const aggregates = new Map<string, UsageWindowAggregate>();
  for (const event of events) {
    const accountingTimestamp = accountedAt ?? event.created_at;
    const timestamp = new Date(accountingTimestamp);
    if (Number.isNaN(timestamp.getTime())) continue;

    const metrics = usageMetricsForEvent(event);
    for (const window of usageWindowSpecs(env, timestamp)) {
      const existing = aggregates.get(window.id);
      if (existing) {
        existing.metrics.eventsReceived += 1;
        existing.metrics.compacted += metrics.compacted;
        existing.metrics.delayed += metrics.delayed;
        existing.metrics.spoolBytes += metrics.spoolBytes;
        existing.updatedAt = newerIso(existing.updatedAt, accountingTimestamp);
      } else {
        aggregates.set(window.id, {
          window,
          metrics: {
            eventsReceived: 1,
            compacted: metrics.compacted,
            delayed: metrics.delayed,
            spoolBytes: metrics.spoolBytes
          },
          updatedAt: accountingTimestamp
        });
      }
    }
  }

  for (const aggregate of aggregates.values()) {
    await upsertUsageWindow(env, aggregate.window, aggregate.metrics, aggregate.updatedAt);
  }
}

async function upsertUsageWindow(
  env: Env,
  window: UsageWindowSpec,
  metrics: UsageEventMetrics,
  updatedAt: string
): Promise<void> {
  const initialState = budgetStateForUsageCount(metrics.eventsReceived, window.thresholds);
  const initialPct = usedPctForCount(metrics.eventsReceived, window.budgetUnits);
  await env.DB!.prepare(
    `INSERT INTO usage_windows (
       id, window_type, window_start, window_end, budget_state, used_pct,
       events_received, events_compacted, events_delayed, local_spool_bytes, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       budget_state = CASE
         WHEN events_received + excluded.events_received >= ? THEN 'hard_limited'
         WHEN events_received + excluded.events_received >= ? THEN 'throttled'
         WHEN events_received + excluded.events_received >= ? THEN 'conservative'
         ELSE 'normal'
       END,
       used_pct = ROUND(((events_received + excluded.events_received) * 1000.0) / ?) / 10.0,
       events_received = events_received + excluded.events_received,
       events_compacted = events_compacted + excluded.events_compacted,
       events_delayed = events_delayed + excluded.events_delayed,
       local_spool_bytes = local_spool_bytes + excluded.local_spool_bytes,
       updated_at = CASE
         WHEN updated_at > excluded.updated_at THEN updated_at
         ELSE excluded.updated_at
       END`
  )
    .bind(
      window.id,
      window.windowType,
      window.windowStart,
      window.windowEnd,
      initialState,
      initialPct,
      metrics.eventsReceived,
      metrics.compacted,
      metrics.delayed,
      metrics.spoolBytes,
      updatedAt,
      window.thresholds.hardLimit,
      window.thresholds.throttledAt,
      window.thresholds.conservativeAt,
      window.budgetUnits
    )
    .run();
}

function usageWindowSpecs(
  env: Pick<Env, "CHAOP_DAILY_BUDGET_UNITS" | "CHAOP_4H_SOFT_BUDGET_UNITS" | "CHAOP_4H_HARD_BUDGET_UNITS" | "CHAOP_BURST_EVENTS_PER_MINUTE">,
  timestamp: Date
): UsageWindowSpec[] {
  const dailyBudget = positiveIntegerEnv(env.CHAOP_DAILY_BUDGET_UNITS, DEFAULT_DAILY_BUDGET_UNITS);
  const fourHourSoftBudget = positiveIntegerEnv(env.CHAOP_4H_SOFT_BUDGET_UNITS, DEFAULT_FOUR_HOUR_SOFT_BUDGET_UNITS);
  const fourHourHardBudget = Math.max(
    positiveIntegerEnv(env.CHAOP_4H_HARD_BUDGET_UNITS, DEFAULT_FOUR_HOUR_HARD_BUDGET_UNITS),
    fourHourSoftBudget
  );
  const burstBudget = positiveIntegerEnv(env.CHAOP_BURST_EVENTS_PER_MINUTE, DEFAULT_BURST_EVENTS_PER_MINUTE);
  const dailyStart = Date.UTC(timestamp.getUTCFullYear(), timestamp.getUTCMonth(), timestamp.getUTCDate());
  const fourHourStart = Date.UTC(
    timestamp.getUTCFullYear(),
    timestamp.getUTCMonth(),
    timestamp.getUTCDate(),
    Math.floor(timestamp.getUTCHours() / 4) * 4
  );
  const burstStart = Date.UTC(
    timestamp.getUTCFullYear(),
    timestamp.getUTCMonth(),
    timestamp.getUTCDate(),
    timestamp.getUTCHours(),
    timestamp.getUTCMinutes()
  );

  return [
    usageWindowSpec("daily", dailyStart, dailyStart + 24 * 60 * 60 * 1000, dailyBudget, thresholdSet(dailyBudget)),
    usageWindowSpec(
      "four_hour",
      fourHourStart,
      fourHourStart + FOUR_HOURS_MS,
      fourHourHardBudget,
      thresholdSet(fourHourHardBudget, fourHourSoftBudget)
    ),
    usageWindowSpec(
      "burst",
      burstStart,
      burstStart + ONE_MINUTE_MS,
      burstBudget,
      thresholdSet(burstBudget)
    )
  ];
}

function usageWindowSpec(
  windowType: BudgetWindowType,
  windowStartMs: number,
  windowEndMs: number,
  budgetUnits: number,
  thresholds: UsageWindowThresholds
): UsageWindowSpec {
  const windowStart = new Date(windowStartMs).toISOString();
  return {
    id: `usage:${windowType}:${windowStart}`,
    windowType,
    windowStart,
    windowEnd: new Date(windowEndMs).toISOString(),
    budgetUnits,
    thresholds
  };
}

function thresholdSet(hardLimit: number, softLimit?: number): UsageWindowThresholds {
  const hard = Math.max(1, Math.floor(hardLimit));
  const throttledAt = Math.min(
    hard,
    softLimit === undefined ? Math.max(1, Math.ceil(hard * 0.9)) : Math.max(1, Math.floor(softLimit))
  );
  const conservativeBase = softLimit === undefined ? hard : throttledAt;
  const conservativeAt = Math.max(1, Math.min(throttledAt, Math.ceil(conservativeBase * 0.75)));
  return {
    hardLimit: hard,
    throttledAt,
    conservativeAt
  };
}

function budgetStateForUsageCount(count: number, thresholds: UsageWindowThresholds): BudgetState {
  if (count >= thresholds.hardLimit) return "hard_limited";
  if (count >= thresholds.throttledAt) return "throttled";
  if (count >= thresholds.conservativeAt) return "conservative";
  return "normal";
}

function usedPctForCount(count: number, budgetUnits: number): number {
  return Math.round((count * 1000) / budgetUnits) / 10;
}

function newerIso(current: string, incoming: string): string {
  return current > incoming ? current : incoming;
}

function usageMetricsForEvent(event: ThreadEvent): EventUsageMetrics {
  return {
    compacted: event.kind === "command.output" ? 1 : 0,
    delayed: event.priority === "P2" || event.priority === "P3" ? 1 : 0,
    spoolBytes: new TextEncoder().encode(event.summary).length
  };
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function updateConnectorActivity(env: Env, connectorId: string): Promise<void> {
  const row = await env.DB!.prepare(
    `SELECT COUNT(*) AS active_count
     FROM commands
     WHERE lease_owner_connector_id = ? AND state IN ('leased', 'running')`
  )
    .bind(connectorId)
    .first<{ active_count: number }>();
  await env.DB!.prepare(
    `UPDATE connectors
     SET active_command_count = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(row?.active_count ?? 0, new Date().toISOString(), connectorId)
    .run();
}

function commandFromRow(row: CommandRow): CommandSummary {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    thread_id: row.thread_id ?? undefined,
    task_id: row.task_id ?? undefined,
    type: row.type,
    execution_mode: row.execution_mode ?? undefined,
    prompt: row.prompt,
    state: row.state,
    target_connector_id: row.target_connector_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function commandTargetHostSessionFromRow(row: PendingCommandRow): CommandTargetHostSession | undefined {
  if (!row.target_host_session_id) return undefined;
  return {
    session_id: row.target_host_session_id,
    app_server_present: targetHostSessionIsAppServer(row),
    cwd: row.target_host_session_cwd ?? undefined
  };
}

function targetHostSessionIsAppServer(row: PendingCommandRow): boolean {
  return row.target_host_session_app_server_present === 1 || row.target_host_session_app_server_present === true;
}

function appServerLeaseTargetHostSessionId(row: PendingCommandRow): string | null {
  if (row.type !== "codex") {
    return null;
  }
  const targetHostSession = commandTargetHostSessionFromRow(row);
  return targetHostSession?.app_server_present === true ? targetHostSession.session_id : null;
}

async function updateCommandStateForAgentEvent(
  env: Env,
  connectorId: string,
  command: {
    id: string;
    workspace_id: string;
    thread_id: string | null;
    task_id: string | null;
    lease_target_host_session_id: string | null;
    type: CommandSummary["type"];
  },
  event: AgentCommandEvent,
  nextState: CommandSummary["state"],
  now: string,
  options: { requireCurrentAppServerStartTarget: boolean }
): Promise<D1Result> {
  if (options.requireCurrentAppServerStartTarget) {
    const result = await env.DB!.prepare(
      `UPDATE commands
       SET state = ?, lease_owner_connector_id = ?, updated_at = ?
       WHERE id = ?
         AND lease_owner_connector_id = ?
         AND state IN ('leased', 'running')
         AND lease_target_host_session_id IS NOT NULL
         AND lease_target_host_session_id = ?
         AND EXISTS (
           SELECT 1
           FROM host_sessions hs
           WHERE hs.id = (
             SELECT hs2.id
             FROM host_sessions hs2
             WHERE hs2.workspace_id = ?
               AND (
                 (? IS NOT NULL AND hs2.attached_task_id = ?)
                 OR (
                   ? IS NOT NULL
                   AND hs2.attached_thread_id = ?
                   AND (
                     ? IS NULL
                     OR NOT EXISTS (
                       SELECT 1
                       FROM host_sessions hst
                       WHERE hst.workspace_id = hs2.workspace_id
                         AND hst.attached_task_id = ?
                     )
                   )
                 )
               )
             ORDER BY
               CASE WHEN ? IS NOT NULL AND hs2.attached_task_id = ? THEN 0 ELSE 1 END,
               hs2.updated_at DESC,
               hs2.id DESC
             LIMIT 1
           )
             AND hs.connector_id = ?
             AND hs.session_id = ?
             AND hs.app_server_present = 1
         )`
    )
      .bind(
        nextState,
        connectorId,
        now,
        command.id,
        connectorId,
        event.target_host_session_id ?? null,
        command.workspace_id,
        command.task_id ?? null,
        command.task_id ?? null,
        command.thread_id ?? null,
        command.thread_id ?? null,
        command.task_id ?? null,
        command.task_id ?? null,
        command.task_id ?? null,
        command.task_id ?? null,
        connectorId,
        event.target_host_session_id ?? null
      )
      .run();
    return result;
  }

  return env.DB!.prepare(
    `UPDATE commands
     SET state = ?, lease_owner_connector_id = ?, updated_at = ?
     WHERE id = ?
       AND lease_owner_connector_id = ?
       AND state IN ('leased', 'running')`
  )
    .bind(nextState, connectorId, now, command.id, connectorId)
    .run();
}

function requiresCurrentAppServerStartTarget(
  command: {
    lease_target_host_session_id: string | null;
    type: CommandSummary["type"];
  },
  event: AgentCommandEvent
): boolean {
  if (event.kind !== "command.started" || command.type !== "codex") {
    return false;
  }
  return Boolean(command.lease_target_host_session_id || event.target_host_session_id);
}

function hostSessionFromRow(row: HostSessionRow): HostSessionSummary {
  return {
    id: row.id,
    connector_id: row.connector_id,
    hostname: row.hostname,
    workspace_id: row.workspace_id,
    session_id: row.session_id,
    title: row.title,
    title_source: row.title_source,
    app_server_present: Boolean(row.app_server_present),
    cwd: row.cwd ?? undefined,
    updated_at: row.updated_at,
    attached_task_id: row.attached_task_id ?? undefined,
    attached_thread_id: row.attached_thread_id ?? undefined
  };
}

function agentHostSessionAppServerPresent(session: AgentHostSession): boolean {
  return session.app_server_present === true || session.title_source === "app_server";
}

function categorySortOrder(category: TaskCategory): number {
  return taskCategories.findIndex((item) => item.id === category.id) * 10;
}

function commandStateForEvent(kind: AgentCommandEvent["kind"]): CommandSummary["state"] | undefined {
  if (kind === "command.started") return "running";
  if (kind === "command.finished") return "succeeded";
  if (kind === "command.failed") return "failed";
  return undefined;
}

function isActiveCommandState(state: CommandSummary["state"]): boolean {
  return state === "leased" || state === "running";
}

function taskStateForEvent(kind: AgentCommandEvent["kind"]): TaskSummary["state"] | undefined {
  if (kind === "command.started" || kind === "approval.resolved" || kind === "input.received") return "running";
  if (kind === "approval.requested") return "waiting_for_approval";
  if (kind === "input.requested") return "waiting_for_input";
  if (kind === "command.finished") return "done";
  if (kind === "command.failed") return "failed";
  return undefined;
}

async function allRows<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results ?? [];
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hostSessionId(connectorId: string, sessionId: string): string {
  return stableScopedId("host-session", connectorId, sessionId);
}

function stableScopedId(prefix: string, connectorId: string, sessionId: string): string {
  return `${prefix}-${slugPart(sessionId)}-${slugPart(connectorId).slice(-16)}`;
}

function stableBackfillEventId(
  hostSession: HostSessionSummary,
  event: AgentBackfillEvent
): string {
  const key = [
    hostSession.connector_id,
    hostSession.session_id,
    hostSession.attached_thread_id,
    event.idempotency_key
  ].join("\0");
  return `event-backfill-${slugPart(hostSession.session_id).slice(0, 24)}-${stableHash(key)}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableFingerprint(parts: string[]): string {
  return stableHash(parts.join("\u001f"));
}

function normaliseBackfillCreatedAt(value: string): string {
  const trimmed = value.trim();
  return Number.isNaN(Date.parse(trimmed)) ? "1970-01-01T00:00:00.000Z" : trimmed;
}

function slugPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "unknown";
}

async function loadCloudflareTelemetryBestEffort(
  env: Env,
  generatedAt: string
): Promise<CloudflareTelemetrySample | undefined> {
  if (
    !env.CF_TELEMETRY_API_TOKEN ||
    !env.CF_TELEMETRY_ACCOUNT_ID ||
    !env.CF_TELEMETRY_API_WORKER ||
    !env.CF_TELEMETRY_D1_DATABASE_ID
  ) {
    return undefined;
  }

  try {
    const cacheKey = cloudflareTelemetryCacheKey(env, generatedAt);
    const now = Date.now();
    if (cloudflareTelemetryCache?.key === cacheKey && cloudflareTelemetryCache.expiresAt > now) {
      if (cloudflareTelemetryCache.pending) {
        const sample = await cloudflareTelemetryCache.pending;
        return mergeCloudflareTelemetrySamples(sample, cachedCloudflareTelemetryDailySample(env, generatedAt));
      }
      return mergeCloudflareTelemetrySamples(
        cloudflareTelemetryCache.sample,
        cachedCloudflareTelemetryDailySample(env, generatedAt)
      );
    }

    const cacheSeconds = positiveIntegerEnv(env.CF_TELEMETRY_CACHE_SECONDS, DEFAULT_CF_TELEMETRY_CACHE_SECONDS);
    const cacheMs = cacheSeconds * 1000;
    const failureCacheMs = Math.min(cacheSeconds, DEFAULT_CF_TELEMETRY_FAILURE_CACHE_SECONDS) * 1000;
    const dailyCacheKey = cloudflareTelemetryDailyCacheKey(env, generatedAt);
    const pending = loadCloudflareTelemetry(env, generatedAt).then(
      (sample) => {
        const expiresAt = Date.now() + cacheMs;
        const mergedSample = updateCloudflareTelemetryDailyCache(
          dailyCacheKey,
          sample,
          cloudflareTelemetryDailyCacheExpiresAt(generatedAt, cacheMs)
        );
        cloudflareTelemetryCache = {
          key: cacheKey,
          sample: mergedSample,
          expiresAt
        };
        return mergedSample;
      },
      (error) => {
        cloudflareTelemetryCache = {
          key: cacheKey,
          sample: undefined,
          expiresAt: Date.now() + failureCacheMs
        };
        throw error;
      }
    );
    cloudflareTelemetryCache = {
      key: cacheKey,
      pending,
      expiresAt: now + cacheMs
    };
    return await pending;
  } catch (error) {
    console.warn("Cloudflare telemetry query failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return cachedCloudflareTelemetryDailySample(env, generatedAt);
  }
}

async function loadCachedCloudflareTelemetryBestEffort(
  env: Env,
  generatedAt: string
): Promise<CloudflareTelemetrySample | undefined> {
  if (
    !env.CF_TELEMETRY_API_TOKEN ||
    !env.CF_TELEMETRY_ACCOUNT_ID ||
    !env.CF_TELEMETRY_API_WORKER ||
    !env.CF_TELEMETRY_D1_DATABASE_ID
  ) {
    return undefined;
  }

  const cacheKey = cloudflareTelemetryCacheKey(env, generatedAt);
  if (cloudflareTelemetryCache?.key === cacheKey && cloudflareTelemetryCache.expiresAt > Date.now()) {
    let bucketSample: CloudflareTelemetrySample | undefined;
    try {
      bucketSample = cloudflareTelemetryCache.pending
        ? await cloudflareTelemetryCache.pending
        : cloudflareTelemetryCache.sample;
    } catch {
      bucketSample = undefined;
    }
    const dailySample = cachedCloudflareTelemetryDailySample(env, generatedAt);
    const mergedSample = mergeCloudflareTelemetrySamples(bucketSample, dailySample);
    if (mergedSample) return mergedSample;
  }

  return cachedCloudflareTelemetryDailySample(env, generatedAt);
}

function cachedCloudflareTelemetryDailySample(
  env: Env,
  generatedAt: string
): CloudflareTelemetrySample | undefined {
  const dailyCacheKey = cloudflareTelemetryDailyCacheKey(env, generatedAt);
  if (cloudflareTelemetryDailyCache?.key !== dailyCacheKey || cloudflareTelemetryDailyCache.expiresAt <= Date.now()) {
    return undefined;
  }
  return cloudflareTelemetryDailyCache.sample;
}

function updateCloudflareTelemetryDailyCache(
  key: string,
  sample: CloudflareTelemetrySample,
  expiresAt: number
): CloudflareTelemetrySample {
  const existingSample =
    cloudflareTelemetryDailyCache?.key === key && cloudflareTelemetryDailyCache.expiresAt > Date.now()
      ? cloudflareTelemetryDailyCache.sample
      : undefined;
  const mergedSample = mergeCloudflareTelemetrySamples(sample, existingSample) ?? sample;
  cloudflareTelemetryDailyCache = {
    key,
    sample: mergedSample,
    expiresAt
  };
  return mergedSample;
}

function cloudflareTelemetryDailyCacheExpiresAt(generatedAt: string, fallbackMs: number): number {
  const effectiveAt = safeDate(generatedAt);
  const utcDayEnd = Date.UTC(
    effectiveAt.getUTCFullYear(),
    effectiveAt.getUTCMonth(),
    effectiveAt.getUTCDate() + 1
  );
  return Math.max(Date.now() + fallbackMs, utcDayEnd);
}

async function loadMaxPersistedCloudflareTelemetrySample(
  env: Env,
  generatedAt: string
): Promise<CloudflareTelemetrySample | undefined> {
  if (!env.DB) return undefined;

  try {
    const effectiveAt = safeDate(generatedAt);
    const windowStart = new Date(Date.UTC(
      effectiveAt.getUTCFullYear(),
      effectiveAt.getUTCMonth(),
      effectiveAt.getUTCDate()
    )).toISOString();
    const row = await env.DB.prepare(
      `SELECT MAX(sampled_at) AS sampled_at, window_start, MAX(window_end) AS window_end,
              MAX(d1_rows_written_daily) AS d1_rows_written_daily,
              MAX(d1_rows_read_daily) AS d1_rows_read_daily,
              MAX(worker_requests_daily) AS worker_requests_daily,
              MAX(durable_object_requests_daily) AS durable_object_requests_daily
       FROM budget_telemetry_samples
       WHERE sample_type = ? AND selector_hash = ? AND window_start = ?
       GROUP BY window_start
       LIMIT 1`
    )
      .bind("cloudflare_daily", cloudflareTelemetrySelectorHash(env), windowStart)
      .first<BudgetTelemetryLatestSampleRow>();
    if (!row) return undefined;
    return {
      windowStart: row.window_start,
      windowEnd: row.window_end,
      updatedAt: row.sampled_at,
      workerRequestsDaily: optionalNonNegativeInteger(row.worker_requests_daily),
      durableObjectRequestEquivalentsDaily: optionalNonNegativeInteger(row.durable_object_requests_daily),
      d1RowsReadDaily: optionalNonNegativeInteger(row.d1_rows_read_daily),
      d1RowsWrittenDaily: optionalNonNegativeInteger(row.d1_rows_written_daily)
    };
  } catch (error) {
    console.warn("Persisted Cloudflare telemetry sample could not be loaded", {
      message: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

function mergeCloudflareTelemetrySamples(
  live: CloudflareTelemetrySample | undefined,
  persisted: CloudflareTelemetrySample | undefined
): CloudflareTelemetrySample | undefined {
  if (!live) return persisted;
  if (!persisted) return live;
  return {
    windowStart: live.windowStart,
    windowEnd: live.windowEnd,
    updatedAt: newerIso(live.updatedAt, persisted.updatedAt),
    workerRequestsDaily: maxOptionalMetric(live.workerRequestsDaily, persisted.workerRequestsDaily),
    durableObjectRequestEquivalentsDaily: maxOptionalMetric(
      live.durableObjectRequestEquivalentsDaily,
      persisted.durableObjectRequestEquivalentsDaily
    ),
    d1RowsReadDaily: maxOptionalMetric(live.d1RowsReadDaily, persisted.d1RowsReadDaily),
    d1RowsWrittenDaily: maxOptionalMetric(live.d1RowsWrittenDaily, persisted.d1RowsWrittenDaily)
  };
}

function maxOptionalMetric(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function cloudflareTelemetryCacheKey(env: Env, generatedAt: string): string {
  const end = new Date(generatedAt);
  const effectiveEnd = Number.isNaN(end.getTime()) ? new Date() : end;
  const sampleSeconds = positiveIntegerEnv(env.CF_TELEMETRY_SAMPLE_SECONDS, DEFAULT_BUDGET_TELEMETRY_SAMPLE_SECONDS);
  const sampleBucket = telemetrySampleBucketStart(effectiveEnd.toISOString(), sampleSeconds).toISOString();
  const date = new Date(Date.UTC(
    effectiveEnd.getUTCFullYear(),
    effectiveEnd.getUTCMonth(),
    effectiveEnd.getUTCDate()
  )).toISOString().slice(0, 10);
  return [
    env.CF_TELEMETRY_ACCOUNT_ID,
    env.CF_TELEMETRY_API_WORKER,
    env.CF_TELEMETRY_WEB_WORKER ?? "",
    env.CF_TELEMETRY_D1_DATABASE_ID,
    env.CF_TELEMETRY_DO_NAMESPACE_NAME ?? "",
    date,
    sampleBucket
  ].join("\0");
}

function cloudflareTelemetryDailyCacheKey(env: Env, generatedAt: string): string {
  const end = new Date(generatedAt);
  const effectiveEnd = Number.isNaN(end.getTime()) ? new Date() : end;
  const date = new Date(Date.UTC(
    effectiveEnd.getUTCFullYear(),
    effectiveEnd.getUTCMonth(),
    effectiveEnd.getUTCDate()
  )).toISOString().slice(0, 10);
  return [
    env.CF_TELEMETRY_ACCOUNT_ID,
    env.CF_TELEMETRY_API_WORKER,
    env.CF_TELEMETRY_WEB_WORKER ?? "",
    env.CF_TELEMETRY_D1_DATABASE_ID,
    env.CF_TELEMETRY_DO_NAMESPACE_NAME ?? "",
    date
  ].join("\0");
}

async function loadCloudflareTelemetry(env: Env, generatedAt: string): Promise<CloudflareTelemetrySample> {
  const end = new Date(generatedAt);
  const effectiveEnd = Number.isNaN(end.getTime()) ? new Date() : end;
  const windowStart = new Date(Date.UTC(
    effectiveEnd.getUTCFullYear(),
    effectiveEnd.getUTCMonth(),
    effectiveEnd.getUTCDate()
  ));
  const date = windowStart.toISOString().slice(0, 10);
  const webWorker = env.CF_TELEMETRY_WEB_WORKER;
  const includeWebWorker = Boolean(webWorker && webWorker !== env.CF_TELEMETRY_API_WORKER);
  const includeDoPeriodic = Boolean(env.CF_TELEMETRY_DO_NAMESPACE_NAME);
  const variables = {
    accountTag: env.CF_TELEMETRY_ACCOUNT_ID!,
    apiScriptName: env.CF_TELEMETRY_API_WORKER!,
    webScriptName: webWorker || env.CF_TELEMETRY_API_WORKER!,
    databaseId: env.CF_TELEMETRY_D1_DATABASE_ID!,
    doNamespaceName: env.CF_TELEMETRY_DO_NAMESPACE_NAME ?? "__chaop_disabled__",
    start: windowStart.toISOString(),
    end: effectiveEnd.toISOString(),
    dateStart: date,
    dateEnd: date
  };
  const timeoutMs = positiveIntegerEnv(env.CF_TELEMETRY_TIMEOUT_MS, DEFAULT_CF_TELEMETRY_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(CLOUDFLARE_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CF_TELEMETRY_API_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ query: CLOUDFLARE_TELEMETRY_QUERY, variables }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`GraphQL HTTP ${response.status}`);
    }

    const body = await response.json() as CloudflareGraphqlResponse;
    if (body.errors?.length) {
      throw new Error(body.errors.map((error) => error.message).join("; "));
    }

    const account = body.data?.viewer?.accounts?.[0];
    if (!account) {
      throw new Error("GraphQL account telemetry was empty");
    }

    const doInboundWebsocketMessages = sumGraphqlMetric(account.durableObjectsPeriodicGroups, "inboundWebsocketMsgCount");
    const doRequests = sumGraphqlMetric(account.durableObjectsInvocationsAdaptiveGroups, "requests");
    return {
      windowStart: windowStart.toISOString(),
      windowEnd: new Date(windowStart.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: effectiveEnd.toISOString(),
      workerRequestsDaily:
        sumGraphqlMetric(account.apiWorkerInvocations, "requests")
        + (includeWebWorker ? sumGraphqlMetric(account.webWorkerInvocations, "requests") : 0),
      durableObjectRequestEquivalentsDaily:
        doRequests
        + (includeDoPeriodic ? Math.ceil(doInboundWebsocketMessages / WS_INCOMING_MESSAGES_PER_DO_REQUEST) : 0),
      d1RowsReadDaily: sumGraphqlMetric(account.d1AnalyticsAdaptiveGroups, "rowsRead"),
      d1RowsWrittenDaily: sumGraphqlMetric(account.d1AnalyticsAdaptiveGroups, "rowsWritten")
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sumGraphqlMetric(rows: CloudflareGraphqlMetricRow[] | undefined, field: string): number {
  return (rows ?? []).reduce((total, row) => total + nonNegativeInteger(row.sum?.[field]), 0);
}

async function persistBudgetTelemetrySampleBestEffort(
  env: Env,
  telemetry: CloudflareTelemetrySample | undefined,
  generatedAt: string
): Promise<boolean> {
  if (!env.DB || !telemetry) return false;

  try {
    const sampleSeconds = positiveIntegerEnv(env.CF_TELEMETRY_SAMPLE_SECONDS, DEFAULT_BUDGET_TELEMETRY_SAMPLE_SECONDS);
    const sampledAt = telemetrySampleBucketStart(generatedAt, sampleSeconds).toISOString();
    const selectorHash = cloudflareTelemetrySelectorHash(env);
    const result = await env.DB.prepare(
      `INSERT INTO budget_telemetry_samples (
         id, sample_type, selector_hash, sampled_at, window_start, window_end,
         d1_rows_written_daily, d1_rows_read_daily, worker_requests_daily,
         durable_object_requests_daily, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         window_start = excluded.window_start,
         window_end = excluded.window_end,
         d1_rows_written_daily = CASE
           WHEN excluded.d1_rows_written_daily IS NULL THEN budget_telemetry_samples.d1_rows_written_daily
           WHEN budget_telemetry_samples.d1_rows_written_daily IS NULL THEN excluded.d1_rows_written_daily
           WHEN excluded.d1_rows_written_daily > budget_telemetry_samples.d1_rows_written_daily THEN excluded.d1_rows_written_daily
           ELSE budget_telemetry_samples.d1_rows_written_daily
         END,
         d1_rows_read_daily = CASE
           WHEN excluded.d1_rows_read_daily IS NULL THEN budget_telemetry_samples.d1_rows_read_daily
           WHEN budget_telemetry_samples.d1_rows_read_daily IS NULL THEN excluded.d1_rows_read_daily
           WHEN excluded.d1_rows_read_daily > budget_telemetry_samples.d1_rows_read_daily THEN excluded.d1_rows_read_daily
           ELSE budget_telemetry_samples.d1_rows_read_daily
         END,
         worker_requests_daily = CASE
           WHEN excluded.worker_requests_daily IS NULL THEN budget_telemetry_samples.worker_requests_daily
           WHEN budget_telemetry_samples.worker_requests_daily IS NULL THEN excluded.worker_requests_daily
           WHEN excluded.worker_requests_daily > budget_telemetry_samples.worker_requests_daily THEN excluded.worker_requests_daily
           ELSE budget_telemetry_samples.worker_requests_daily
         END,
         durable_object_requests_daily = CASE
           WHEN excluded.durable_object_requests_daily IS NULL THEN budget_telemetry_samples.durable_object_requests_daily
           WHEN budget_telemetry_samples.durable_object_requests_daily IS NULL THEN excluded.durable_object_requests_daily
           WHEN excluded.durable_object_requests_daily > budget_telemetry_samples.durable_object_requests_daily THEN excluded.durable_object_requests_daily
           ELSE budget_telemetry_samples.durable_object_requests_daily
         END,
         created_at = CASE
           WHEN excluded.created_at > budget_telemetry_samples.created_at THEN excluded.created_at
           ELSE budget_telemetry_samples.created_at
         END
       WHERE
         (
           excluded.d1_rows_written_daily IS NOT NULL
           AND (
             budget_telemetry_samples.d1_rows_written_daily IS NULL
             OR excluded.d1_rows_written_daily > budget_telemetry_samples.d1_rows_written_daily
           )
         )
         OR (
           excluded.d1_rows_read_daily IS NOT NULL
           AND (
             budget_telemetry_samples.d1_rows_read_daily IS NULL
             OR excluded.d1_rows_read_daily > budget_telemetry_samples.d1_rows_read_daily
           )
         )
         OR (
           excluded.worker_requests_daily IS NOT NULL
           AND (
             budget_telemetry_samples.worker_requests_daily IS NULL
             OR excluded.worker_requests_daily > budget_telemetry_samples.worker_requests_daily
           )
         )
         OR (
           excluded.durable_object_requests_daily IS NOT NULL
           AND (
             budget_telemetry_samples.durable_object_requests_daily IS NULL
             OR excluded.durable_object_requests_daily > budget_telemetry_samples.durable_object_requests_daily
           )
         )`
    )
      .bind(
        `budget-telemetry:cloudflare_daily:${selectorHash}:${sampledAt}`,
        "cloudflare_daily",
        selectorHash,
        sampledAt,
        telemetry.windowStart,
        telemetry.windowEnd,
        telemetry.d1RowsWrittenDaily,
        telemetry.d1RowsReadDaily,
        telemetry.workerRequestsDaily,
        telemetry.durableObjectRequestEquivalentsDaily,
        generatedAt
      )
      .run();
    return Boolean((result.meta as { changes?: number } | undefined)?.changes);
  } catch (error) {
    console.warn("Budget telemetry sample could not be persisted", {
      message: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

async function loadBudgetTelemetryHistoryBestEffort(
  env: Env,
  generatedAt: string,
  options: { force?: boolean | undefined } = {}
): Promise<BudgetTelemetryHistory | undefined> {
  if (!env.DB) return undefined;

  try {
    const cacheKey = budgetTelemetryHistoryCacheKey(env, generatedAt);
    const now = Date.now();
    if (!options.force && budgetTelemetryHistoryCache?.key === cacheKey && budgetTelemetryHistoryCache.expiresAt > now) {
      return budgetTelemetryHistoryCache.history;
    }

    const effectiveAt = safeDate(generatedAt);
    const since = new Date(effectiveAt.getTime() - BUDGET_TELEMETRY_HISTORY_HOURS * 60 * 60 * 1000).toISOString();
    const rows = await allRows<BudgetTelemetrySampleRow>(
      env.DB.prepare(
        `SELECT sampled_at, d1_rows_written_daily, d1_rows_read_daily,
                worker_requests_daily, durable_object_requests_daily
         FROM budget_telemetry_samples
         WHERE sample_type = ? AND selector_hash = ? AND sampled_at >= ?
         ORDER BY sampled_at DESC
         LIMIT ?`
      )
        .bind("cloudflare_daily", cloudflareTelemetrySelectorHash(env), since, BUDGET_TELEMETRY_HISTORY_LIMIT)
    );
    const points = rows.reverse().map(budgetTelemetryPointFromRow);
    const history: BudgetTelemetryHistory = {
      source: "cloudflare_analytics",
      latest_sample_at: points.at(-1)?.sampled_at,
      points,
      slopes: budgetTelemetrySlopes(points)
    };
    budgetTelemetryHistoryCache = {
      key: cacheKey,
      history,
      expiresAt: now + positiveIntegerEnv(
        env.CF_TELEMETRY_HISTORY_CACHE_SECONDS,
        DEFAULT_BUDGET_TELEMETRY_HISTORY_CACHE_SECONDS
      ) * 1000
    };
    return history;
  } catch (error) {
    console.warn("Budget telemetry history could not be loaded", {
      message: error instanceof Error ? error.message : String(error)
    });
    budgetTelemetryHistoryCache = {
      key: budgetTelemetryHistoryCacheKey(env, generatedAt),
      history: undefined,
      expiresAt: Date.now() + DEFAULT_CF_TELEMETRY_FAILURE_CACHE_SECONDS * 1000
    };
    return undefined;
  }
}

function budgetTelemetryHistoryCacheKey(env: Env, generatedAt: string): string {
  const sampleSeconds = positiveIntegerEnv(env.CF_TELEMETRY_SAMPLE_SECONDS, DEFAULT_BUDGET_TELEMETRY_SAMPLE_SECONDS);
  const sampleBucket = telemetrySampleBucketStart(generatedAt, sampleSeconds).toISOString();
  return [
    cloudflareTelemetrySelectorHash(env),
    sampleBucket
  ].join("\0");
}

function cloudflareTelemetrySelectorHash(env: Env): string {
  return stableStringHash([
    env.CF_TELEMETRY_ACCOUNT_ID ?? "",
    env.CF_TELEMETRY_API_WORKER ?? "",
    env.CF_TELEMETRY_WEB_WORKER ?? "",
    env.CF_TELEMETRY_D1_DATABASE_ID ?? "",
    env.CF_TELEMETRY_DO_NAMESPACE_NAME ?? ""
  ].join("\0"));
}

function stableStringHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function budgetTelemetryPointFromRow(row: BudgetTelemetrySampleRow): BudgetTelemetryPoint {
  return {
    sampled_at: row.sampled_at,
    d1_rows_written_daily: nullableNonNegativeInteger(row.d1_rows_written_daily),
    d1_rows_read_daily: nullableNonNegativeInteger(row.d1_rows_read_daily),
    worker_requests_daily: nullableNonNegativeInteger(row.worker_requests_daily),
    durable_object_requests_daily: nullableNonNegativeInteger(row.durable_object_requests_daily)
  };
}

function budgetTelemetrySlopes(points: BudgetTelemetryPoint[]): BudgetTelemetrySlope[] {
  return [
    budgetTelemetrySlope(points, "15m", 15 * 60 * 1000),
    budgetTelemetrySlope(points, "1h", 60 * 60 * 1000)
  ];
}

function budgetTelemetrySlope(
  points: BudgetTelemetryPoint[],
  window: BudgetTelemetrySlope["window"],
  windowMs: number
): BudgetTelemetrySlope {
  const eligible = points
    .filter((point): point is BudgetTelemetryPoint & { d1_rows_written_daily: number } =>
      point.d1_rows_written_daily !== null
    )
    .sort((left, right) => Date.parse(left.sampled_at) - Date.parse(right.sampled_at));
  const latest = eligible.at(-1);
  if (!latest) {
    return emptyBudgetTelemetrySlope(window);
  }

  const latestAt = safeDate(latest.sampled_at);
  const windowStartMs = latestAt.getTime() - windowMs;
  const sameDay = utcDateKey(latestAt);
  const windowPoints = eligible.filter((point) => {
    const sampledAt = safeDate(point.sampled_at);
    return sampledAt.getTime() >= windowStartMs && utcDateKey(sampledAt) === sameDay;
  });
  const first = windowPoints[0];
  if (!first || windowPoints.length < 2) {
    return {
      ...emptyBudgetTelemetrySlope(window),
      sample_count: windowPoints.length
    };
  }

  const firstAt = safeDate(first.sampled_at);
  const minutes = Math.max(0, (latestAt.getTime() - firstAt.getTime()) / 60_000);
  const delta = Math.max(0, latest.d1_rows_written_daily - first.d1_rows_written_daily);
  const perMinute = minutes > 0 ? Math.round((delta / minutes) * 10) / 10 : null;
  const projected = perMinute === null
    ? null
    : Math.round(latest.d1_rows_written_daily + perMinute * minutesUntilUtcDayEnd(latestAt));

  return {
    window,
    sample_count: windowPoints.length,
    minutes: Math.round(minutes * 10) / 10,
    d1_rows_written_delta: delta,
    d1_rows_written_per_minute: perMinute,
    projected_d1_rows_written_daily: projected
  };
}

function emptyBudgetTelemetrySlope(window: BudgetTelemetrySlope["window"]): BudgetTelemetrySlope {
  return {
    window,
    sample_count: 0,
    minutes: 0,
    d1_rows_written_delta: null,
    d1_rows_written_per_minute: null,
    projected_d1_rows_written_daily: null
  };
}

function budgetD1ActivitySignals(
  env: Pick<Env, "CHAOP_DAILY_BUDGET_UNITS" | "CHAOP_4H_SOFT_BUDGET_UNITS" | "CHAOP_4H_HARD_BUDGET_UNITS" | "CHAOP_BURST_EVENTS_PER_MINUTE">,
  generatedAt: string,
  daily: UsageWindowRow | undefined,
  telemetry: CloudflareTelemetrySample | undefined
): BudgetD1Activity {
  const model = budgetD1WriteModel(env);
  const eventEstimate = daily ? nonNegativeInteger(daily.events_received) * model.budgeted_rows_written_per_event : null;
  const measuredDaily = telemetry?.d1RowsWrittenDaily ?? null;
  const residual = measuredDaily === null || eventEstimate === null ? null : Math.max(0, measuredDaily - eventEstimate);
  return {
    generated_at: generatedAt,
    source: "d1_write_activity_signals",
    signals: [
      {
        id: "cloudflare_d1_rows_written_daily",
        label: "Measured D1 writes today",
        detail: "Cloudflare GraphQL Analytics cumulative rows_written for the current UTC day.",
        source: "cloudflare_analytics",
        rows_written_daily: measuredDaily,
        sampled: measuredDaily !== null,
        updated_at: telemetry?.updatedAt
      },
      {
        id: "estimated_event_persistence_daily",
        label: "Estimated guarded event writes",
        detail: "Current daily usage-window event count multiplied by the conservative schema-derived rows-written budget per event.",
        source: daily ? "d1_usage_windows" : "schema_model",
        rows_written_daily: eventEstimate,
        sampled: eventEstimate !== null,
        updated_at: daily?.updated_at
      },
      {
        id: "estimated_non_event_residual_daily",
        label: "Measured minus event estimate",
        detail: "Residual writes after subtracting Chaop's persisted-event estimate. This can include indexes, control-plane rows, inventory sync, manual D1 work, and model error.",
        source: "cloudflare_analytics",
        rows_written_daily: residual,
        sampled: residual !== null,
        updated_at: telemetry?.updatedAt
      }
    ]
  };
}

function telemetrySampleBucketStart(generatedAt: string, sampleSeconds: number): Date {
  const timestamp = safeDate(generatedAt);
  const bucketMs = Math.max(1, sampleSeconds) * 1000;
  return new Date(Math.floor(timestamp.getTime() / bucketMs) * bucketMs);
}

function minutesUntilUtcDayEnd(timestamp: Date): number {
  const end = new Date(Date.UTC(
    timestamp.getUTCFullYear(),
    timestamp.getUTCMonth(),
    timestamp.getUTCDate() + 1
  ));
  return Math.max(0, (end.getTime() - timestamp.getTime()) / 60_000);
}

function utcDateKey(timestamp: Date): string {
  return timestamp.toISOString().slice(0, 10);
}

function safeDate(value: string): Date {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

const CLOUDFLARE_TELEMETRY_QUERY = `query ChaopCloudflareTelemetry(
  $accountTag: string!
  $apiScriptName: string!
  $webScriptName: string!
  $databaseId: string!
  $doNamespaceName: string!
  $start: Time!
  $end: Time!
  $dateStart: Date!
  $dateEnd: Date!
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      apiWorkerInvocations: workersInvocationsAdaptive(
        limit: 1000
        filter: { scriptName: $apiScriptName, datetime_geq: $start, datetime_leq: $end }
      ) {
        sum { requests }
      }
      webWorkerInvocations: workersInvocationsAdaptive(
        limit: 1000
        filter: { scriptName: $webScriptName, datetime_geq: $start, datetime_leq: $end }
      ) {
        sum { requests }
      }
      d1AnalyticsAdaptiveGroups(
        limit: 1000
        filter: { databaseId: $databaseId, date_geq: $dateStart, date_leq: $dateEnd }
      ) {
        sum { rowsRead rowsWritten }
      }
      durableObjectsInvocationsAdaptiveGroups(
        limit: 1000
        filter: { scriptName: $apiScriptName, datetime_geq: $start, datetime_leq: $end }
      ) {
        sum { requests }
      }
      durableObjectsPeriodicGroups(
        limit: 1000
        filter: { name: $doNamespaceName, datetime_geq: $start, datetime_leq: $end }
      ) {
        sum { inboundWebsocketMsgCount }
      }
    }
  }
}`;

async function loadDogfoodSafetyPause(
  env: Env,
  generatedAt = new Date().toISOString()
): Promise<DogfoodSafetyPauseSetting | undefined> {
  if (!env.DB) return undefined;
  try {
    const row = await env.DB.prepare(
      "SELECT value_json, updated_at FROM control_plane_settings WHERE key = ? LIMIT 1"
    )
      .bind(DOGFOOD_SAFETY_PAUSE_KEY)
      .first<{ value_json: string; updated_at: string }>();
    if (!row) return undefined;
    const parsed = JSON.parse(row.value_json) as unknown;
    if (!isRecord(parsed) || typeof parsed.paused !== "boolean") {
      return {
        paused: true,
        reason: "Dogfood safety pause state is malformed; guarded dogfood actions are blocked until the control-plane setting is corrected.",
        updated_at: row.updated_at
      };
    }
    if (!parsed.paused) return undefined;
    return {
      paused: true,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      updated_by: typeof parsed.updated_by === "string" ? parsed.updated_by : undefined,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : row.updated_at
    };
  } catch (error) {
    console.warn("Dogfood safety pause state could not be loaded", {
      message: error instanceof Error ? error.message : String(error)
    });
    return {
      paused: true,
      reason: "Dogfood safety pause state could not be loaded; guarded dogfood actions are blocked until the control-plane setting is readable.",
      updated_at: generatedAt
    };
  }
}

function dogfoodSafetyPosture({
  generatedAt,
  paused,
  constraints,
  budgetStates = []
}: {
  generatedAt: string;
  paused: DogfoodSafetyPauseSetting | undefined;
  constraints: BudgetConstraint[];
  budgetStates?: BudgetState[] | undefined;
}): DogfoodSafetyPosture {
  const bottleneck = budgetBottleneckConstraint(constraints);
  const sampledStates = constraints
    .filter((constraint) => constraint.sampled && constraint.hard && constraint.state !== "missing")
    .map((constraint) => constraint.state as BudgetState);
  const state = paused ? "hard_limited" : worstBudgetState([...sampledStates, ...budgetStates]);
  const visibleBottleneck = dogfoodSafetyBottleneckForState(state, bottleneck);
  const actions = DOGFOOD_SAFETY_ACTIONS.map((action) =>
    dogfoodSafetyGuard(action, state, paused, visibleBottleneck)
  );
  return {
    state,
    paused: paused !== undefined,
    paused_reason: paused?.reason,
    paused_by: paused?.updated_by,
    paused_at: paused?.updated_at,
    generated_at: generatedAt,
    summary: dogfoodSafetySummary(state, paused, visibleBottleneck),
    bottleneck_constraint: visibleBottleneck,
    actions
  };
}

function dogfoodSafetyBottleneckForState(
  state: BudgetState,
  bottleneck: BudgetConstraint | undefined
): BudgetConstraint | undefined {
  if (!bottleneck) return undefined;
  if (bottleneck.state === "missing") return undefined;
  if (state === "normal" || state === "recovery") return bottleneck;
  return BUDGET_STATE_RANK[bottleneck.state] >= BUDGET_STATE_RANK[state] ? bottleneck : undefined;
}

function dogfoodSafetyGuard(
  action: DogfoodSafetyAction,
  state: BudgetState,
  paused: DogfoodSafetyPauseSetting | undefined,
  bottleneck: BudgetConstraint | undefined
): DogfoodSafetyActionGuard {
  const blocked = dogfoodSafetyActionBlocked(action, state, paused);
  return {
    action,
    state: blocked ? "blocked" : "allowed",
    reason: blocked
      ? dogfoodSafetyBlockedReason(action, state, paused, bottleneck)
      : dogfoodSafetyAllowedReason(action, state, bottleneck),
    budget_state: state,
    constraint_id: bottleneck?.id,
    constraint_label: bottleneck?.label,
    remaining_event_capacity: bottleneck?.remaining_event_capacity
  };
}

function dogfoodSafetyActionBlocked(
  action: DogfoodSafetyAction,
  state: BudgetState,
  paused: DogfoodSafetyPauseSetting | undefined
): boolean {
  if (paused) return true;
  if (state === "hard_limited" || state === "throttled") return true;
  return action === "host_session_refresh" && state === "conservative";
}

function dogfoodSafetyBlockedReason(
  action: DogfoodSafetyAction,
  state: BudgetState,
  paused: DogfoodSafetyPauseSetting | undefined,
  bottleneck: BudgetConstraint | undefined
): string {
  if (paused) {
    return paused.reason
      ? `Dogfood emergency pause is active: ${paused.reason}`
      : "Dogfood emergency pause is active.";
  }
  if (action === "host_session_refresh" && state === "conservative") {
    return "Host Session refresh is paused while cost posture is conservative; use existing attached threads or resume when the bottleneck clears.";
  }
  const bottleneckLabel = bottleneck ? ` Current bottleneck: ${bottleneck.label}.` : "";
  return `Cost posture is ${state.replace("_", " ")}; this write or refresh action is blocked.${bottleneckLabel}`;
}

function dogfoodSafetyAllowedReason(
  action: DogfoodSafetyAction,
  state: BudgetState,
  bottleneck: BudgetConstraint | undefined
): string {
  if (state === "conservative" && action !== "host_session_refresh") {
    return "Allowed, but broad refresh remains blocked until cost posture returns to normal.";
  }
  if (bottleneck) {
    return `Allowed. Current bottleneck is ${bottleneck.label}.`;
  }
  return "Allowed. No sampled hard budget bottleneck is currently available.";
}

function dogfoodSafetySummary(
  state: BudgetState,
  paused: DogfoodSafetyPauseSetting | undefined,
  bottleneck: BudgetConstraint | undefined
): string {
  if (paused) {
    return paused.reason
      ? `Emergency pause active: ${paused.reason}`
      : "Emergency pause active.";
  }
  if (state === "hard_limited" || state === "throttled") {
    return bottleneck
      ? `Cost posture is ${state.replace("_", " ")}; ${bottleneck.label} is blocking guarded dogfood actions.`
      : `Cost posture is ${state.replace("_", " ")}; guarded dogfood actions are blocked.`;
  }
  if (state === "conservative") {
    return bottleneck
      ? `Cost posture is conservative; ${bottleneck.label} is the current bottleneck.`
      : "Cost posture is conservative; broad refresh is blocked.";
  }
  return bottleneck
    ? `Guarded dogfood actions are allowed. Current bottleneck: ${bottleneck.label}.`
    : "Guarded dogfood actions are allowed.";
}

function boundedSafetyReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 240);
}

const DOGFOOD_SAFETY_ACTIONS: DogfoodSafetyAction[] = [
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

function emptyBudgetSummary(generatedAt: string): BudgetSummary {
  const constraints = budgetConstraints({}, []);
  return {
    state: "normal",
    daily_used_pct: null,
    four_hour_used_pct: null,
    burst_used_pct: null,
    delayed_event_count: 0,
    compacted_event_count: 0,
    local_spool_bytes: 0,
    source: "empty",
    generated_at: generatedAt,
    window_sample_count: 0,
    constraint_sample_count: 0,
    windows: [],
    constraints,
    bottleneck_constraint: undefined,
    d1_write_model: budgetD1WriteModel({})
  };
}

function budgetWindowSignalFromRow(env: Env, row: UsageWindowRow): BudgetWindowSignal {
  const budgetUnits = budgetUnitsForUsageWindow(env, row);
  const eventsReceived = nonNegativeInteger(row.events_received);
  return {
    window_type: budgetWindowTypeFromString(row.window_type),
    window_start: row.window_start,
    window_end: row.window_end,
    budget_state: budgetStateForUsageWindow(env, row),
    used_pct: usedPctForCount(eventsReceived, budgetUnits),
    budget_units: budgetUnits,
    events_received: eventsReceived,
    events_compacted: nonNegativeInteger(row.events_compacted),
    events_delayed: nonNegativeInteger(row.events_delayed),
    local_spool_bytes: nonNegativeInteger(row.local_spool_bytes),
    estimated_d1_rows_written: eventsReceived * D1_BUDGETED_ROWS_WRITTEN_PER_EVENT,
    updated_at: row.updated_at
  };
}

function localBudgetWindowBaselines(
  env: Pick<Env, "CHAOP_DAILY_BUDGET_UNITS" | "CHAOP_4H_SOFT_BUDGET_UNITS" | "CHAOP_4H_HARD_BUDGET_UNITS" | "CHAOP_BURST_EVENTS_PER_MINUTE">,
  generatedAt: string
): Map<BudgetWindowType, BudgetWindowSignal> {
  const timestamp = new Date(generatedAt);
  const safeTimestamp = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
  return new Map(
    usageWindowSpecs(env, safeTimestamp)
      .filter((spec) => spec.windowType === "four_hour" || spec.windowType === "burst")
      .map((spec) => [spec.windowType, zeroBudgetWindowSignal(spec)])
  );
}

function zeroBudgetWindowSignal(spec: UsageWindowSpec): BudgetWindowSignal {
  return {
    window_type: spec.windowType,
    window_start: spec.windowStart,
    window_end: spec.windowEnd,
    budget_state: "normal",
    used_pct: 0,
    budget_units: spec.budgetUnits,
    events_received: 0,
    events_compacted: 0,
    events_delayed: 0,
    local_spool_bytes: 0,
    estimated_d1_rows_written: 0,
    updated_at: spec.windowStart
  };
}

function budgetConstraints(
  env: Pick<Env, "CHAOP_DAILY_BUDGET_UNITS" | "CHAOP_4H_SOFT_BUDGET_UNITS" | "CHAOP_4H_HARD_BUDGET_UNITS" | "CHAOP_BURST_EVENTS_PER_MINUTE">,
  windows: BudgetWindowSignal[],
  telemetry?: CloudflareTelemetrySample | undefined,
  localBaselines = new Map<BudgetWindowType, BudgetWindowSignal>()
): BudgetConstraint[] {
  const model = budgetD1WriteModel(env);
  const windowsByType = new Map(windows.map((window) => [window.window_type, window]));
  const fourHourWindow = windowsByType.get("four_hour");
  const burstWindow = windowsByType.get("burst");
  const fourHourBaseline = fourHourWindow ? undefined : localBaselines.get("four_hour");
  const burstBaseline = burstWindow ? undefined : localBaselines.get("burst");
  return [
    d1WriteConstraint(
      "d1_rows_written_daily",
      "D1 rows written / day",
      "Cloudflare Free D1 rows-written limit, converted to Chaop event capacity with the current schema-derived write model.",
      "daily",
      model.daily_budget_units,
      windowsByType.get("daily"),
      model.budgeted_rows_written_per_event,
      telemetry?.d1RowsWrittenDaily
    ),
    d1WriteConstraint(
      "d1_rows_written_four_hour",
      "D1 rows written / 4h",
      "Chaop local four-hour guardrail that prevents one busy period from consuming the full daily D1 rows-written posture.",
      "four_hour",
      model.four_hour_hard_budget_units,
      fourHourWindow ?? fourHourBaseline,
      model.budgeted_rows_written_per_event,
      undefined,
      fourHourBaseline ? "schema_model" : undefined,
      model.four_hour_soft_budget_units
    ),
    d1WriteConstraint(
      "d1_rows_written_burst",
      "D1 rows written / minute",
      "Chaop burst guardrail for short spikes, modelled from D1 rows written per persisted event.",
      "burst",
      model.burst_budget_units,
      burstWindow ?? burstBaseline,
      model.budgeted_rows_written_per_event,
      undefined,
      burstBaseline ? "schema_model" : undefined
    ),
    cloudflareTelemetryConstraint(
      "worker_requests_daily",
      "Worker requests / day",
      "Cloudflare GraphQL Analytics API Worker request usage for the Chaop API and Web Workers.",
      "daily",
      "worker_request",
      model.free_worker_requests_per_day,
      telemetry?.workerRequestsDaily,
      telemetry
    ),
    cloudflareTelemetryConstraint(
      "durable_object_requests_daily",
      "Durable Object requests / day",
      "Cloudflare GraphQL Analytics API Durable Object request-equivalent usage, including periodic inbound WebSocket messages at the 20:1 request ratio when exposed.",
      "daily",
      "durable_object_request",
      CLOUDFLARE_FREE_DURABLE_OBJECT_REQUESTS_PER_DAY,
      telemetry?.durableObjectRequestEquivalentsDaily,
      telemetry
    ),
    cloudflareTelemetryConstraint(
      "d1_rows_read_daily",
      "D1 rows read / day",
      "Cloudflare GraphQL Analytics API D1 rows-read usage for the Chaop control database.",
      "daily",
      "d1_row_read",
      CLOUDFLARE_FREE_D1_ROWS_READ_PER_DAY,
      telemetry?.d1RowsReadDaily,
      telemetry
    )
  ];
}

function d1WriteConstraint(
  id: string,
  label: string,
  detail: string,
  windowType: BudgetWindowType,
  eventBudget: number,
  window: BudgetWindowSignal | undefined,
  rowsPerEvent: number,
  telemetryUsedRows?: number | undefined,
  localSource?: BudgetConstraint["source"] | undefined,
  softEventBudget?: number | undefined
): BudgetConstraint {
  const limitUnits = eventBudget * rowsPerEvent;
  const softLimitUnits = softEventBudget === undefined ? undefined : softEventBudget * rowsPerEvent;
  const localUsedRows = window ? window.events_received * rowsPerEvent : null;
  const usedUnits = d1RowsWrittenConstraintUsedUnits(localUsedRows, telemetryUsedRows);
  const sampled = localSource === "schema_model" ? false : usedUnits !== null;
  const source = d1RowsWrittenConstraintSource(localUsedRows, telemetryUsedRows, localSource);
  return sampledConstraint({
    id,
    label,
    detail,
    windowType,
    unit: "d1_row",
    limitUnits,
    usedUnits,
    perEventUnits: rowsPerEvent,
    state: usedUnits === null ? "missing" : budgetStateForUsageCount(usedUnits, thresholdSet(limitUnits, softLimitUnits)),
    source,
    sampled,
    window
  });
}

function d1RowsWrittenConstraintUsedUnits(localUsedRows: number | null, telemetryUsedRows: number | undefined): number | null {
  if (telemetryUsedRows === undefined) return localUsedRows;
  return localUsedRows === null ? telemetryUsedRows : Math.max(localUsedRows, telemetryUsedRows);
}

function d1RowsWrittenConstraintSource(
  localUsedRows: number | null,
  telemetryUsedRows: number | undefined,
  localSource?: BudgetConstraint["source"] | undefined
): BudgetConstraint["source"] | undefined {
  if (telemetryUsedRows === undefined) return localSource;
  if (localUsedRows !== null && localUsedRows > telemetryUsedRows) return localSource ?? "d1_usage_windows";
  return "cloudflare_analytics";
}

function sampledConstraint({
  id,
  label,
  detail,
  windowType,
  unit,
  limitUnits,
  usedUnits,
  perEventUnits,
  state,
  source,
  sampled,
  window
}: {
  id: string;
  label: string;
  detail: string;
  windowType: BudgetWindowType;
  unit: BudgetConstraint["unit"];
  limitUnits: number;
  usedUnits: number | null;
  perEventUnits: number;
  state: BudgetConstraint["state"];
  source?: BudgetConstraint["source"] | undefined;
  sampled?: boolean | undefined;
  window: BudgetWindowSignal | undefined;
}): BudgetConstraint {
  const remainingUnits = usedUnits === null ? null : Math.max(0, limitUnits - usedUnits);
  const remainingRatio = remainingUnits === null ? null : ratio(remainingUnits, limitUnits);
  return {
    id,
    label,
    detail,
    window_type: windowType,
    unit,
    hard: true,
    sampled: sampled ?? usedUnits !== null,
    state,
    source: usedUnits === null ? "missing" : source ?? "d1_usage_windows",
    limit_units: limitUnits,
    used_units: usedUnits,
    used_pct: usedUnits === null ? null : usedPctForUnits(usedUnits, limitUnits),
    remaining_units: remainingUnits,
    remaining_ratio: remainingRatio,
    per_event_units: perEventUnits,
    remaining_event_capacity: remainingUnits === null ? null : Math.floor(remainingUnits / perEventUnits),
    window_start: window?.window_start,
    window_end: window?.window_end,
    updated_at: window?.updated_at
  };
}

function cloudflareTelemetryConstraint(
  id: string,
  label: string,
  detail: string,
  windowType: BudgetConstraint["window_type"],
  unit: BudgetConstraint["unit"],
  limitUnits: number,
  usedUnits: number | undefined,
  telemetry: CloudflareTelemetrySample | undefined
): BudgetConstraint {
  if (usedUnits !== undefined) {
    const remainingUnits = Math.max(0, limitUnits - usedUnits);
    return {
      id,
      label,
      detail,
      window_type: windowType,
      unit,
      hard: true,
      sampled: true,
      state: budgetStateForUsageCount(usedUnits, thresholdSet(limitUnits)),
      source: "cloudflare_analytics",
      limit_units: limitUnits,
      used_units: usedUnits,
      used_pct: usedPctForUnits(usedUnits, limitUnits),
      remaining_units: remainingUnits,
      remaining_ratio: ratio(remainingUnits, limitUnits),
      per_event_units: null,
      remaining_event_capacity: null,
      window_start: telemetry?.windowStart,
      window_end: telemetry?.windowEnd,
      updated_at: telemetry?.updatedAt
    };
  }

  return {
    id,
    label,
    detail,
    window_type: windowType,
    unit,
    hard: true,
    sampled: false,
    state: "missing",
    source: "missing",
    limit_units: limitUnits,
    used_units: null,
    used_pct: null,
    remaining_units: null,
    remaining_ratio: null,
    per_event_units: null,
    remaining_event_capacity: null
  };
}

function budgetBottleneckConstraint(constraints: BudgetConstraint[]): BudgetConstraint | undefined {
  return constraints
    .filter((constraint) =>
      constraint.hard
      && constraint.sampled
      && constraint.remaining_ratio !== null
      && constraint.state !== "missing"
    )
    .sort(compareBudgetConstraintsByRemainingRatio)[0];
}

function compareBudgetConstraintsByRemainingRatio(left: BudgetConstraint, right: BudgetConstraint): number {
  const ratioDelta = (left.remaining_ratio ?? Number.POSITIVE_INFINITY) - (right.remaining_ratio ?? Number.POSITIVE_INFINITY);
  if (ratioDelta !== 0) return ratioDelta;
  const capacityDelta =
    (left.remaining_event_capacity ?? Number.POSITIVE_INFINITY)
    - (right.remaining_event_capacity ?? Number.POSITIVE_INFINITY);
  if (capacityDelta !== 0) return capacityDelta;
  return left.id.localeCompare(right.id);
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function usedPctForUnits(usedUnits: number, limitUnits: number): number {
  if (limitUnits <= 0) return 0;
  return Math.round((usedUnits * 1000) / limitUnits) / 10;
}

function budgetD1WriteModel(env: Pick<Env, "CHAOP_DAILY_BUDGET_UNITS" | "CHAOP_4H_SOFT_BUDGET_UNITS" | "CHAOP_4H_HARD_BUDGET_UNITS" | "CHAOP_BURST_EVENTS_PER_MINUTE">): BudgetD1WriteModel {
  const dailyBudget = positiveIntegerEnv(env.CHAOP_DAILY_BUDGET_UNITS, DEFAULT_DAILY_BUDGET_UNITS);
  const fourHourSoftBudget = positiveIntegerEnv(env.CHAOP_4H_SOFT_BUDGET_UNITS, DEFAULT_FOUR_HOUR_SOFT_BUDGET_UNITS);
  const fourHourHardBudget = Math.max(
    positiveIntegerEnv(env.CHAOP_4H_HARD_BUDGET_UNITS, DEFAULT_FOUR_HOUR_HARD_BUDGET_UNITS),
    fourHourSoftBudget
  );
  const burstBudget = positiveIntegerEnv(env.CHAOP_BURST_EVENTS_PER_MINUTE, DEFAULT_BURST_EVENTS_PER_MINUTE);
  return {
    source: "schema_derived",
    free_rows_written_per_day: CLOUDFLARE_FREE_D1_ROWS_WRITTEN_PER_DAY,
    free_worker_requests_per_day: CLOUDFLARE_FREE_WORKER_REQUESTS_PER_DAY,
    budgeted_rows_written_per_event: D1_BUDGETED_ROWS_WRITTEN_PER_EVENT,
    daily_budget_units: dailyBudget,
    four_hour_soft_budget_units: fourHourSoftBudget,
    four_hour_hard_budget_units: fourHourHardBudget,
    burst_budget_units: burstBudget,
    steady_persisted_event_rows_written: D1_STEADY_PERSISTED_EVENT_ROWS_WRITTEN,
    first_event_in_minute_rows_written: D1_FIRST_EVENT_IN_MINUTE_ROWS_WRITTEN,
    first_event_in_four_hour_rows_written: D1_FIRST_EVENT_IN_FOUR_HOUR_ROWS_WRITTEN,
    first_event_in_day_rows_written: D1_FIRST_EVENT_IN_DAY_ROWS_WRITTEN,
    backfill_rows_written_per_event: D1_BACKFILL_ROWS_WRITTEN_PER_EVENT,
    backfill_same_minute_fixed_rows_written: D1_BACKFILL_SAME_MINUTE_FIXED_ROWS_WRITTEN,
    command_lifecycle_without_task_rows_written: D1_COMMAND_LIFECYCLE_WITHOUT_TASK_ROWS_WRITTEN,
    command_lifecycle_with_task_rows_written: D1_COMMAND_LIFECYCLE_WITH_TASK_ROWS_WRITTEN,
    components: [
      {
        id: "thread_sequence",
        label: "Thread sequence update",
        rows_written: D1_THREAD_SEQUENCE_UPDATE_ROWS,
        frequency: "per persisted thread event",
        detail: "Updates the threads row and idx_threads_workspace_updated."
      },
      {
        id: "event_insert",
        label: "Event insert",
        rows_written: D1_EVENT_INSERT_ROWS,
        frequency: "per persisted thread event",
        detail: "Writes the events row, primary-key index, unique thread sequence index, and explicit thread sequence index."
      },
      {
        id: "usage_windows",
        label: "Usage-window accounting",
        rows_written: D1_USAGE_WINDOW_COUNT * D1_USAGE_WINDOW_EXISTING_UPDATE_ROWS,
        frequency: "per realtime event after current windows exist",
        detail: "Updates daily, four-hour, and burst rows plus the latest-window index."
      },
      {
        id: "command_lifecycle",
        label: "Command lifecycle overhead",
        rows_written: D1_COMMAND_LIFECYCLE_WITH_TASK_ROWS_WRITTEN - D1_STEADY_PERSISTED_EVENT_ROWS_WRITTEN,
        frequency: "per command event with an attached task",
        detail: "Updates command state, task state, and connector activity in addition to the persisted event."
      },
      {
        id: "guardrail_budget",
        label: "No-telemetry guardrail budget",
        rows_written: D1_BUDGETED_ROWS_WRITTEN_PER_EVENT,
        frequency: "per event for local fallback capacity",
        detail: "Budgets an attached command lifecycle at a daily usage-window boundary when Cloudflare telemetry is unavailable or lower than the local estimate."
      },
      {
        id: "backfill_batch",
        label: "Backfill batch floor",
        rows_written: D1_BACKFILL_ROWS_WRITTEN_PER_EVENT,
        frequency: "per imported backfill event before fixed window updates",
        detail: "Backfills update thread sequence and insert events per row, then update active usage windows once per batch."
      }
    ]
  };
}

function windowPct(env: Env, row: UsageWindowRow | undefined): number | null {
  return row ? usedPctForCount(nonNegativeInteger(row.events_received), budgetUnitsForUsageWindow(env, row)) : null;
}

function budgetStateForUsageWindow(env: Env, row: UsageWindowRow): BudgetState {
  return budgetStateForUsageCount(nonNegativeInteger(row.events_received), usageWindowSpecForRow(env, row).thresholds);
}

function budgetUnitsForUsageWindow(env: Env, row: UsageWindowRow): number {
  return usageWindowSpecForRow(env, row).budgetUnits;
}

function usageWindowSpecForRow(env: Env, row: UsageWindowRow): UsageWindowSpec {
  const timestamp = new Date(row.window_start);
  const safeTimestamp = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
  const windowType = budgetWindowTypeFromString(row.window_type);
  return usageWindowSpecs(env, safeTimestamp).find((window) => window.windowType === windowType)
    ?? usageWindowSpec(windowType, safeTimestamp.getTime(), safeTimestamp.getTime() + ONE_MINUTE_MS, 1, thresholdSet(1));
}

function budgetWindowTypeFromString(value: string): BudgetWindowType {
  return value === "four_hour" || value === "burst" ? value : "daily";
}

function budgetStateFromString(value: string): BudgetState {
  return value === "conservative" || value === "throttled" || value === "hard_limited" || value === "recovery"
    ? value
    : "normal";
}

function worstBudgetState(states: BudgetState[]): BudgetState {
  return states.reduce<BudgetState>(
    (worst, state) => (BUDGET_STATE_RANK[state] > BUDGET_STATE_RANK[worst] ? state : worst),
    "normal"
  );
}

function nonNegativeInteger(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function optionalNonNegativeInteger(value: number | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : nonNegativeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableNonNegativeInteger(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : nonNegativeInteger(value);
}

type ConnectorRow = {
  id: string;
  name: string;
  hostname: string;
  status: ConnectorSummary["status"];
  capabilities_json: string | null;
  logical_agent_count: number;
  active_command_count: number;
  realtime_mode: ConnectorSummary["realtime_mode"];
  budget_state: ConnectorSummary["budget_state"];
  last_seen_at: string | null;
  updated_at: string | null;
};

type AppServerInstanceRow = Omit<AppServerInstanceSummary, "workspace_id" | "thread_id" | "status_summary" | "last_error"> & {
  workspace_id: string | null;
  thread_id: string | null;
  placement_key: string;
  status_summary: string | null;
  last_error: string | null;
  report_fingerprint: string;
  summary_changed_at: string;
  created_at: string;
};

type UsageWindowRow = {
  id: string;
  window_type: string;
  window_start: string;
  window_end: string;
  budget_state: string;
  used_pct: number;
  events_received: number;
  events_compacted: number;
  events_delayed: number;
  local_spool_bytes: number;
  updated_at: string;
};

type BudgetStateCountRow = {
  budget_state: string;
  count: number;
};

type CloudflareTelemetrySample = {
  windowStart: string;
  windowEnd: string;
  updatedAt: string;
  workerRequestsDaily?: number | undefined;
  durableObjectRequestEquivalentsDaily?: number | undefined;
  d1RowsReadDaily?: number | undefined;
  d1RowsWrittenDaily?: number | undefined;
};

type BudgetTelemetrySampleRow = {
  sampled_at: string;
  d1_rows_written_daily: number | null;
  d1_rows_read_daily: number | null;
  worker_requests_daily: number | null;
  durable_object_requests_daily: number | null;
};

type BudgetTelemetryLatestSampleRow = BudgetTelemetrySampleRow & {
  window_start: string;
  window_end: string;
};

type DogfoodSafetyPauseSetting = {
  paused: true;
  reason?: string | undefined;
  updated_by?: string | undefined;
  updated_at: string;
};

type CloudflareGraphqlMetricRow = {
  sum?: Record<string, number | undefined> | undefined;
};

type CloudflareGraphqlResponse = {
  data?: {
    viewer?: {
      accounts?: Array<{
        apiWorkerInvocations?: CloudflareGraphqlMetricRow[];
        webWorkerInvocations?: CloudflareGraphqlMetricRow[];
        d1AnalyticsAdaptiveGroups?: CloudflareGraphqlMetricRow[];
        durableObjectsInvocationsAdaptiveGroups?: CloudflareGraphqlMetricRow[];
        durableObjectsPeriodicGroups?: CloudflareGraphqlMetricRow[];
      }>;
    };
  };
  errors?: Array<{ message: string }>;
};

type CloudflareTelemetryCacheEntry = {
  key: string;
  sample?: CloudflareTelemetrySample | undefined;
  pending?: Promise<CloudflareTelemetrySample> | undefined;
  expiresAt: number;
};

type BudgetTelemetryHistoryCacheEntry = {
  key: string;
  history?: BudgetTelemetryHistory | undefined;
  expiresAt: number;
};

type UsageWindowSpec = {
  id: string;
  windowType: BudgetWindowType;
  windowStart: string;
  windowEnd: string;
  budgetUnits: number;
  thresholds: UsageWindowThresholds;
};

type UsageWindowThresholds = {
  hardLimit: number;
  throttledAt: number;
  conservativeAt: number;
};

type UsageEventMetrics = {
  eventsReceived: number;
  compacted: number;
  delayed: number;
  spoolBytes: number;
};

type EventUsageMetrics = Omit<UsageEventMetrics, "eventsReceived">;

type UsageWindowAggregate = {
  window: UsageWindowSpec;
  metrics: UsageEventMetrics;
  updatedAt: string;
};

type WorkspaceRow = {
  id: string;
  name: string;
  repo_url: string | null;
};

type ThreadRow = ThreadSummary;

type TaskRow = Omit<TaskSummary, "thread_id" | "connector_id" | "assigned_agent" | "archived_at"> & {
  thread_id: string;
  connector_id: string | null;
  assigned_agent: string | null;
  archived_at: string | null;
};

type HostSessionRow = Omit<
  HostSessionSummary,
  "app_server_present" | "cwd" | "attached_task_id" | "attached_thread_id"
> & {
  app_server_present: number | boolean | null;
  cwd: string | null;
  attached_task_id: string | null;
  attached_thread_id: string | null;
};

type CommandRow = Omit<CommandSummary, "thread_id" | "task_id" | "target_connector_id"> & {
  thread_id: string | null;
  task_id: string | null;
  execution_mode?: CommandSummary["execution_mode"] | null;
  target_connector_id: string | null;
};

type CommandTargetConnectorIdSource = "explicit" | "attached" | "auto";

type PendingCommandRow = CommandRow & {
  target_connector_id_source: CommandTargetConnectorIdSource | null;
  target_host_session_row_id: string | null;
  target_host_session_id: string | null;
  target_host_session_app_server_present: number | boolean | null;
  target_host_session_cwd: string | null;
};

type ThreadEventRow = Omit<ThreadEvent, "command_id" | "payload"> & {
  command_id: string | null;
  payload_json: string | null;
};

type EventInput = Omit<ThreadEvent, "id" | "seq" | "created_at"> & {
  workspace_id: string;
};
