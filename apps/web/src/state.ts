import type {
  BootstrapPayload,
  CommandSummary,
  CreateCommandRequest,
  ConnectorSummary,
  HostSessionBackfillSummary,
  HostSessionSummary,
  HostSessionSyncSummary,
  TaskArchiveResponse,
  ThreadSummary
} from "@chaop/protocol";

export type CommandExecutionMode = "placeholder" | "app_server" | "codex_cli_fallback";

export const MANAGED_APP_SERVER_UNAVAILABLE = "No managed app-server connector is online.";

export function mergeBootstrapPayload(
  current: BootstrapPayload | undefined,
  incoming: BootstrapPayload
): BootstrapPayload {
  if (!current) return incoming;

  const hostSessionSyncs = mergeHostSessionSyncs(incoming.host_session_syncs, current.host_session_syncs);
  return {
    ...incoming,
    threads: mergeById(incoming.threads, current.threads, newerThread),
    tasks: mergeById(incoming.tasks, current.tasks, newerByUpdatedAt),
    running_commands: mergeById(incoming.running_commands, current.running_commands, newerByUpdatedAt),
    events: mergeById(incoming.events, current.events, newerByCreatedAt),
    host_sessions: mergeHostSessions(incoming.host_sessions, current.host_sessions),
    host_session_syncs: hostSessionSyncs
  };
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
      connector.status !== "offline" &&
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
      connector.status !== "offline" &&
      connector.capabilities.includes("codex_exec")
  );
}

export function normaliseCommandMode(
  mode: CommandExecutionMode,
  data: BootstrapPayload | undefined,
  threadId: string | undefined,
  options: { showCliFallback: boolean }
): CommandExecutionMode {
  if (mode === "app_server" && !managedAppServerCommandAvailable(data, threadId)) {
    return "placeholder";
  }

  if (mode === "codex_cli_fallback") {
    const thread = data?.threads.find((item) => item.id === threadId);
    if (!options.showCliFallback || !codexCliFallbackAvailable(data, thread?.workspace_id)) {
      return "placeholder";
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
  return connector.status !== "offline" && connector.capabilities.includes("codex_app_server_exec");
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

function mergeHostSessions(
  incoming: HostSessionSummary[],
  current: HostSessionSummary[]
): HostSessionSummary[] {
  const merged = new Map<string, HostSessionSummary>();

  for (const item of incoming) {
    merged.set(item.id, item);
  }

  for (const item of current) {
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
