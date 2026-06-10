import type {
  AgentBootstrapRequest,
  AgentCommandEvent,
  BootstrapPayload,
  CommandSummary,
  ConnectorSummary,
  CreateCommandRequest,
  CreateCommandResponse,
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

export class CommandTargetError extends Error {
  readonly status = 404;
}

export async function loadBootstrapFromDb(
  env: Env,
  user: BrowserIdentity
): Promise<BootstrapPayload | undefined> {
  if (!env.DB) {
    return undefined;
  }

  await ensureUser(env, user);

  const [
    connectors,
    workspaces,
    threads,
    categories,
    tasks,
    runningCommands,
    events
  ] = await Promise.all([
    listConnectors(env),
    listWorkspaces(env),
    listThreads(env),
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
    task_categories: categories,
    tasks,
    running_commands: runningCommands,
    events,
    budget,
    server_time: new Date().toISOString()
  };
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
  const targetConnectorId =
    request.target_connector_id ?? (await chooseConnectorForWorkspace(env, request.workspace_id, commandType));

  if (request.target_connector_id && !targetConnectorId) {
    throw new CommandTargetError("Target connector not available");
  }

  if (targetConnectorId) {
    await assertConnectorCanExecute(env, targetConnectorId, request.workspace_id, commandType);
  }

  const now = new Date().toISOString();
  const command: CommandSummary = {
    id: `command-${cryptoRandomId().slice(0, 12)}`,
    workspace_id: request.workspace_id,
    thread_id: request.thread_id,
    task_id: request.task_id,
    type: commandType,
    prompt: request.prompt,
    state: "pending",
    target_connector_id: targetConnectorId,
    created_at: now,
    updated_at: now
  };

  await env.DB.prepare(
    `INSERT INTO commands (
       id, workspace_id, thread_id, task_id, type, prompt, state,
       target_connector_id, created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      user.id,
      command.created_at,
      command.updated_at
    )
    .run();

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

  if (command.task_id && targetConnectorId) {
    await env.DB.prepare(
      `UPDATE tasks
       SET state = 'running', connector_id = ?, assigned_agent = 'chaop-agent', updated_at = ?
       WHERE id = ?`
    )
      .bind(targetConnectorId, now, command.task_id)
      .run();
  }

  return { response: { accepted: true, command }, targetConnectorId };
}

export async function pendingCommandsForConnector(
  env: Env,
  connectorId: string
): Promise<CommandSummary[]> {
  if (!env.DB) return [];

  const now = new Date().toISOString();
  const rows = await allRows<CommandRow>(
    env.DB.prepare(
      `SELECT id, workspace_id, thread_id, task_id, type, prompt, state, target_connector_id, created_at, updated_at
       FROM commands cmd
       WHERE (
           cmd.state = 'pending'
           OR (cmd.state = 'leased' AND cmd.lease_until IS NOT NULL AND cmd.lease_until < ?)
         )
         AND (cmd.target_connector_id = ? OR cmd.target_connector_id IS NULL)
         AND EXISTS (
           SELECT 1
           FROM workspace_connectors wc
           INNER JOIN connectors c ON c.id = wc.connector_id
           WHERE wc.workspace_id = cmd.workspace_id
             AND wc.connector_id = ?
             AND wc.can_execute = 1
             AND c.status <> 'offline'
             AND (cmd.type <> 'codex' OR c.capabilities_json LIKE '%"codex_exec"%')
         )
       ORDER BY created_at ASC
       LIMIT 1`
    ).bind(now, connectorId, connectorId)
  );

  const leaseUntil = new Date(Date.now() + 60_000).toISOString();
  const leasedRows: CommandRow[] = [];

  for (const row of rows) {
    const result = await env.DB.prepare(
      `UPDATE commands
       SET state = 'leased', lease_owner_connector_id = ?, lease_until = ?, updated_at = ?
       WHERE id = ?
         AND (
           state = 'pending'
           OR (state = 'leased' AND lease_until IS NOT NULL AND lease_until < ?)
         )`
    )
      .bind(connectorId, leaseUntil, now, row.id, now)
      .run();
    if ((result.meta as { changes?: number } | undefined)?.changes) {
      leasedRows.push(row);
    }
  }

  if (leasedRows.length > 0) {
    await updateConnectorActivity(env, connectorId);
  }

  return leasedRows.map((row) => ({ ...commandFromRow(row), state: "leased" }));
}

export async function recordAgentEvent(
  env: Env,
  connectorId: string,
  event: AgentCommandEvent
): Promise<void> {
  if (!env.DB) return;

  const command = await env.DB.prepare(
    `SELECT id, workspace_id, thread_id, task_id, target_connector_id
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
      target_connector_id: string | null;
    }>();

  if (!command) return;
  if (command.target_connector_id && command.target_connector_id !== connectorId) return;

  const now = new Date().toISOString();
  const nextState = commandStateForEvent(event.kind);

  if (nextState) {
    await env.DB.prepare(
      `UPDATE commands
       SET state = ?, lease_owner_connector_id = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(nextState, connectorId, now, command.id)
      .run();
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

  if (command.thread_id) {
    await appendEvent(env, {
      workspace_id: command.workspace_id,
      thread_id: command.thread_id,
      command_id: command.id,
      kind: event.kind,
      priority: event.priority,
      summary: event.summary
    });
  }

  await env.DB.prepare(
    `UPDATE connectors
     SET last_seen_at = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(now, now, connectorId)
    .run();
  await updateConnectorActivity(env, connectorId);
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
  await env.DB!.prepare(
    `UPDATE connectors
     SET status = 'offline', active_command_count = 0, updated_at = ?
     WHERE id <> ? AND name = ? AND hostname = ?`
  )
    .bind(now, connectorId, registration.connector_name, registration.hostname)
    .run();
}

async function listConnectors(env: Env): Promise<ConnectorSummary[]> {
  const rows = await allRows<ConnectorRow>(
    env.DB!.prepare(
      `SELECT id, name, hostname, status, realtime_mode, budget_state,
        logical_agent_count, active_command_count, last_seen_at
       FROM connectors
       WHERE status <> 'offline'
       ORDER BY CASE status WHEN 'online' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END, updated_at DESC`
    )
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    status: row.status,
    logical_agent_count: row.logical_agent_count,
    active_command_count: row.active_command_count,
    realtime_mode: row.realtime_mode,
    budget_state: row.budget_state,
    last_seen_at: row.last_seen_at ?? undefined
  }));
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
        assigned_agent, realtime_mode, budget_state, updated_at
       FROM tasks
       ORDER BY updated_at DESC`
    )
  );
  return rows.map((row) => ({
    ...row,
    thread_id: row.thread_id ?? undefined,
    connector_id: row.connector_id ?? undefined,
    assigned_agent: row.assigned_agent ?? undefined
  }));
}

async function listRecentCommands(env: Env): Promise<CommandSummary[]> {
  const rows = await allRows<CommandRow>(
    env.DB!.prepare(
      `SELECT id, workspace_id, thread_id, task_id, type, prompt, state,
        target_connector_id, created_at, updated_at
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
     WHERE wc.workspace_id = ? AND wc.can_execute = 1 AND c.status <> 'offline'
       AND (? <> 'codex' OR c.capabilities_json LIKE '%"codex_exec"%')
     ORDER BY c.last_seen_at DESC, c.updated_at DESC
     LIMIT 1`
  )
    .bind(workspaceId, commandType)
    .first<{ id: string }>();
  return row?.id;
}

async function assertConnectorCanExecute(
  env: Env,
  connectorId: string,
  workspaceId: string,
  commandType: CommandSummary["type"]
): Promise<void> {
  const connector = await env.DB!.prepare(
    `SELECT c.id
     FROM connectors c
     INNER JOIN workspace_connectors wc ON wc.connector_id = c.id
     WHERE c.id = ? AND wc.workspace_id = ? AND wc.can_execute = 1 AND c.status <> 'offline'
       AND (? <> 'codex' OR c.capabilities_json LIKE '%"codex_exec"%')
     LIMIT 1`
  )
    .bind(connectorId, workspaceId, commandType)
    .first<{ id: string }>();
  if (!connector) {
    throw new CommandTargetError("Target connector not available");
  }
}

async function appendEvent(
  env: Env,
  input: EventInput
): Promise<void> {
  const current = await env.DB!.prepare(
    `SELECT last_seq
     FROM threads
     WHERE id = ?
     LIMIT 1`
  )
    .bind(input.thread_id)
    .first<{ last_seq: number }>();

  if (!current) return;

  const seq = current.last_seq + 1;
  const now = new Date().toISOString();
  await env.DB!.prepare(
    `INSERT INTO events (id, workspace_id, thread_id, command_id, seq, kind, priority, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      `event-${cryptoRandomId().slice(0, 16)}`,
      input.workspace_id,
      input.thread_id,
      input.command_id ?? null,
      seq,
      input.kind,
      input.priority,
      input.summary,
      now
    )
    .run();
  await env.DB!.prepare(
    `UPDATE threads
     SET last_seq = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(seq, now, input.thread_id)
    .run();
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
    prompt: row.prompt,
    state: row.state,
    target_connector_id: row.target_connector_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
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

function finalTaskStateForEvent(kind: AgentCommandEvent["kind"]): TaskSummary["state"] | undefined {
  if (kind === "command.finished" || kind === "command.failed") return "done";
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

type ConnectorRow = {
  id: string;
  name: string;
  hostname: string;
  status: ConnectorSummary["status"];
  logical_agent_count: number;
  active_command_count: number;
  realtime_mode: ConnectorSummary["realtime_mode"];
  budget_state: ConnectorSummary["budget_state"];
  last_seen_at: string | null;
};

type WorkspaceRow = {
  id: string;
  name: string;
  repo_url: string | null;
};

type ThreadRow = ThreadSummary;

type TaskRow = Omit<TaskSummary, "thread_id" | "connector_id" | "assigned_agent"> & {
  thread_id: string | null;
  connector_id: string | null;
  assigned_agent: string | null;
};

type CommandRow = Omit<CommandSummary, "thread_id" | "task_id" | "target_connector_id"> & {
  thread_id: string | null;
  task_id: string | null;
  target_connector_id: string | null;
};

type ThreadEventRow = Omit<ThreadEvent, "command_id"> & {
  command_id: string | null;
};

type EventInput = Omit<ThreadEvent, "id" | "seq" | "created_at"> & {
  workspace_id: string;
};
