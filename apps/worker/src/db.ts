import type {
  AgentBackfillEvent,
  AgentAppServerInstancesReport,
  AgentBootstrapRequest,
  AgentCommandEvent,
  AgentHostSessionsReport,
  AppServerInstanceSummary,
  AttachHostSessionResponse,
  BootstrapPayload,
  CommandDispatch,
  CommandTargetHostSession,
  CommandSummary,
  ConnectorSummary,
  CreateLocalThreadRequest,
  CreateLocalThreadResponse,
  CreateCommandRequest,
  CreateCommandResponse,
  AgentHostSession,
  DetachHostSessionResponse,
  HostSessionSummary,
  HostSessionSyncSummary,
  TaskCategory,
  TaskSummary,
  ThreadEvent,
  ThreadSummary,
  WorkspaceSummary
} from "@chaop/protocol";
import { budget, taskCategories } from "./sample-data.js";
import type { Env } from "./types.js";
import type { BrowserIdentity } from "./auth.js";

const DEFAULT_WORKSPACE_ID = "workspace-api";
const DEFAULT_THREAD_ID = "thread-orders-500";
const DEFAULT_TASK_ID = "task-orders-500";
const APP_SERVER_UNCHANGED_SUMMARY_DEBOUNCE_MS = 15 * 60 * 1000;

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

export class NotFoundError extends Error {
  readonly status = 404;
}

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
    budget,
    server_time: new Date().toISOString()
  };
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
  const reportedKeys = new Set<string>();
  for (const instance of report.instances) {
    reportedKeys.add(instance.instance_key);
    const fingerprint = appServerInstanceFingerprint(instance);
    const existing = await env.DB.prepare(
      `SELECT id, connector_id, instance_key, scope, endpoint_type, state,
              active_turn_count, generation, status_summary, last_error,
              report_fingerprint, last_seen_at, state_changed_at,
              summary_changed_at, created_at, updated_at
       FROM app_server_instances
       WHERE connector_id = ? AND instance_key = ?
       LIMIT 1`
    )
      .bind(connectorId, instance.instance_key)
      .first<AppServerInstanceRow>();
    const shouldPersist = shouldPersistAppServerInstance(existing, instance, fingerprint, syncedAt);
    if (!shouldPersist) continue;

    const id = existing?.id ?? appServerInstanceId(connectorId, instance.instance_key);
    const stateChangedAt = existing && existing.state === instance.state
      ? existing.state_changed_at
      : syncedAt;
    const summaryChangedAt = existing && existing.report_fingerprint === fingerprint
      ? existing.summary_changed_at
      : syncedAt;
    await env.DB.prepare(
      `INSERT INTO app_server_instances (
         id, connector_id, instance_key, scope, endpoint_type, state,
         active_turn_count, generation, status_summary, last_error,
         report_fingerprint, last_seen_at, state_changed_at, summary_changed_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connector_id, instance_key) DO UPDATE SET
         scope = excluded.scope,
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
      `SELECT id, connector_id, instance_key, scope, endpoint_type, state,
              active_turn_count, generation, status_summary, last_error,
              last_seen_at, state_changed_at, updated_at
       FROM app_server_instances
       WHERE connector_id = ? AND instance_key = ?
       LIMIT 1`
    )
      .bind(connectorId, instance.instance_key)
      .first<AppServerInstanceRow>();
    if (row) persisted.push(appServerInstanceFromRow(row));
  }

  if (report.snapshot === true) {
    const omitted = await allRows<AppServerInstanceRow>(
      env.DB.prepare(
        `SELECT id, connector_id, instance_key, scope, endpoint_type, state,
                active_turn_count, generation, status_summary, last_error,
                report_fingerprint, last_seen_at, state_changed_at,
                summary_changed_at, created_at, updated_at
         FROM app_server_instances
         WHERE connector_id = ?
           AND state <> 'stopped'`
      ).bind(connectorId)
    );
    for (const row of omitted) {
      if (reportedKeys.has(row.instance_key)) continue;
      const stoppedSummary = "Instance was omitted from the latest connector snapshot.";
      const stoppedFingerprint = appServerStoppedFingerprint(row, stoppedSummary);
      await env.DB.prepare(
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
          stoppedFingerprint,
          syncedAt,
          syncedAt,
          syncedAt,
          syncedAt,
          row.id
        )
        .run();
      persisted.push(appServerInstanceFromRow({
        ...row,
        state: "stopped",
        active_turn_count: 0,
        status_summary: stoppedSummary,
        last_error: null,
        last_seen_at: syncedAt,
        state_changed_at: syncedAt,
        updated_at: syncedAt
      }));
    }
  }

  if (report.snapshot === true && persisted.length > 0) {
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
      `SELECT id, connector_id, instance_key, scope, endpoint_type, state,
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
    const stoppedSummary = "Connector went offline before reporting app-server state.";
    const fingerprint = appServerStoppedFingerprint(row, stoppedSummary);
    await env.DB.prepare(
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
    stopped.push(appServerInstanceFromRow({
      ...row,
      state: "stopped",
      active_turn_count: 0,
      status_summary: stoppedSummary,
      last_error: null,
      last_seen_at: syncedAt,
      state_changed_at: syncedAt,
      updated_at: syncedAt
    }));
  }
  return stopped;
}

export async function recordHostSessions(
  env: Env,
  connectorId: string,
  report: AgentHostSessionsReport,
  syncedAt = new Date().toISOString(),
  options: { workspaceId?: string | undefined } = {}
): Promise<{ host_sessions: HostSessionSummary[]; synced_at: string; released_connector_ids: string[]; failed_events: ThreadEvent[] }> {
  if (!env.DB) return { host_sessions: [], synced_at: syncedAt, released_connector_ids: [], failed_events: [] };

  const connector = await env.DB.prepare(
    `SELECT hostname
     FROM connectors
     WHERE id = ?
     LIMIT 1`
  )
    .bind(connectorId)
    .first<{ hostname: string }>();
  if (!connector) return { host_sessions: [], synced_at: syncedAt, released_connector_ids: [], failed_events: [] };

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
    await env.DB.prepare(
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
         updated_at = excluded.updated_at`
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
    const stored = await findHostSession(env, session.session_id, connectorId);
    if (stored) {
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
    .bind(connectorId, syncedAt, reportedSessions.length, upserted.length)
    .run();

  await env.DB.prepare(
    `UPDATE connectors
     SET last_seen_at = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(syncedAt, syncedAt, connectorId)
    .run();

  return {
    host_sessions: upserted,
    synced_at: syncedAt,
    released_connector_ids: [...releasedConnectorIds],
    failed_events: failedEvents
  };
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
  events: AgentBackfillEvent[]
): Promise<ThreadEvent[]> {
  if (!env.DB || !hostSession.attached_thread_id) {
    return [];
  }

  const thread = await loadThread(env, hostSession.attached_thread_id);
  if (!thread) {
    throw new NotFoundError("Attached thread not found");
  }

  const imported: ThreadEvent[] = [];
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
      `SELECT id, thread_id, command_id, seq, kind, priority, summary, created_at
       FROM events
       WHERE thread_id = ?
       ORDER BY seq DESC
       LIMIT ?`
    )
      .bind(thread.id, boundedLimit)
  );
  return rows.reverse().map((row) => ({
    ...row,
    command_id: row.command_id ?? undefined
  }));
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
  const scope = await resolveCommandScope(env, request);
  const useAttachedTarget = request.execution_mode !== "codex_cli_fallback";
  const attachedTarget = useAttachedTarget ? await findAttachedCommandTarget(env, scope) : null;
  if (request.execution_mode === "app_server" && attachedTarget?.app_server_present !== true) {
    throw new CommandTargetError("App-server execution requires an attached app-server host session");
  }
  const attachedTargetForInsert = attachedTarget
    ? {
      connectorId: attachedTarget.connector_id,
      sessionId: attachedTarget.session_id,
      appServerPresent: attachedTarget.app_server_present
    }
    : undefined;
  const appServerTargetHostSessionId =
    attachedTarget?.app_server_present === true && commandType === "codex" ? attachedTarget.session_id : null;
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
      requireAppServerExec: attachedTarget?.app_server_present === true && commandType === "codex"
    });
  }

  const now = new Date().toISOString();
  const command: CommandSummary = {
    id: `command-${cryptoRandomId().slice(0, 12)}`,
    workspace_id: scope.workspaceId,
    thread_id: scope.threadId,
    task_id: scope.taskId,
    type: commandType,
    execution_mode: commandType === "codex" ? request.execution_mode : undefined,
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
    const taskState = event.kind === "command.started" ? "running" : finalTaskStateForEvent(event.kind);
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

  const threadEvent = command.thread_id
    ? await appendEvent(env, {
      workspace_id: command.workspace_id,
      thread_id: command.thread_id,
      command_id: command.id,
      kind: event.kind,
      priority: event.priority,
      summary: event.summary
    })
    : undefined;

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
  options: { commandIds?: string[]; refreshConnectorActivity?: boolean; now?: string } = {}
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
        summary: "Connector disconnected before the command completed."
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
  await markAppServerInstancesStoppedForConnector(env, connectorId, now);
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
      `SELECT asi.id, asi.connector_id, asi.instance_key, asi.scope, asi.endpoint_type, asi.state,
              asi.active_turn_count, asi.generation, asi.status_summary, asi.last_error,
              asi.last_seen_at, asi.state_changed_at, asi.updated_at
       FROM app_server_instances asi
       INNER JOIN connectors c ON c.id = asi.connector_id
       WHERE c.status <> 'offline'
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
      `SELECT id, connector_id, instance_key, scope, endpoint_type, state,
              active_turn_count, generation, status_summary, last_error,
              last_seen_at, state_changed_at, updated_at
       FROM app_server_instances
       WHERE connector_id = ?
       ORDER BY instance_key ASC`
    ).bind(connectorId)
  );
  return rows.map(appServerInstanceFromRow);
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
    row.endpoint_type,
    "stopped",
    "0",
    String(row.generation),
    summary,
    ""
  ]);
}

function appServerInstanceId(connectorId: string, instanceKey: string): string {
  return `app-server-${stableFingerprint([connectorId, instanceKey])}`;
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
      `SELECT id, thread_id, command_id, seq, kind, priority, summary, created_at
       FROM events
       ORDER BY created_at DESC, seq DESC
       LIMIT 30`
    )
  );
  return rows.reverse().map((row) => ({
    ...row,
    command_id: row.command_id ?? undefined
  }));
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
    created_at: now
  };
  await env.DB!.prepare(
    `INSERT INTO events (id, workspace_id, thread_id, command_id, seq, kind, priority, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      event.created_at
    )
    .run();
  return event;
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

function finalTaskStateForEvent(kind: AgentCommandEvent["kind"]): TaskSummary["state"] | undefined {
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

type AppServerInstanceRow = Omit<AppServerInstanceSummary, "status_summary" | "last_error"> & {
  status_summary: string | null;
  last_error: string | null;
  report_fingerprint: string;
  summary_changed_at: string;
  created_at: string;
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

type ThreadEventRow = Omit<ThreadEvent, "command_id"> & {
  command_id: string | null;
};

type EventInput = Omit<ThreadEvent, "id" | "seq" | "created_at"> & {
  workspace_id: string;
};
