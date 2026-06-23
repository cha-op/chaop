import {
  createEnvelope,
  type AgentAppServerInstancesReport,
  type AgentCommandEvent,
  type HostSessionAppServerEnsureDispatch,
  type HostSessionAppServerEnsureResult,
  type HostSessionBackfillDispatch,
  type HostSessionBackfillResult,
  type AgentHostSessionsReport,
  type AppServerInstancesUpdatePayload,
  type ConnectorsUpdatePayload,
  type HostSessionsUpdatePayload,
  type LocalThreadCreateDispatch,
  type LocalThreadCreateResult,
  type ThreadArchiveSyncDispatch,
  type ThreadArchiveSyncResult,
  type ThreadEvent
} from "@chaop/protocol";
import {
  cleanupStaleExplicitAppServerCommandTargets,
  failActiveCommandsForConnector,
  getConnectorSummary,
  markAppServerInstancesStoppedForConnector,
  markConnectorDegraded,
  markConnectorOffline,
  markConnectorOnline,
  pendingCommandsForConnector,
  recordAgentEvent,
  recordAppServerInstances,
  recordHostSessions,
  releaseLeasedCommandsForConnector,
  updateConnectorCapabilities
} from "./db.js";
import type { Env } from "./types.js";

const THREAD_CREATE_TIMEOUT_MS = 15_000;
const HOST_SESSION_APP_SERVER_ENSURE_TIMEOUT_MS = 15_000;
const HOST_SESSION_BACKFILL_TIMEOUT_MS = 15_000;
const THREAD_ARCHIVE_SYNC_TIMEOUT_MS = 20_000;
const APP_SERVER_REPORT_CACHE_MS = 60_000;
const HOST_SESSIONS_REFRESH_COOLDOWN_MS = 60_000;
const HOST_SESSIONS_REFRESH_DISPATCH_WAIT_MS = 30_000;

type SocketAttachment = {
  socketType?: string;
  connectorId?: string;
  connectedAt?: number;
  agentReady?: boolean;
  pendingHostSessionsDispatch?: boolean;
  pendingHostSessionsDispatchDeadline?: number;
  activeCommandIds?: string[];
};

export class WorkspaceDO implements DurableObject {
  private readonly pendingThreadCreates = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      resolve: (result: LocalThreadCreateResult) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly pendingHostSessionBackfills = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      resolve: (result: HostSessionBackfillResult) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly pendingHostSessionAppServerEnsures = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      resolve: (result: HostSessionAppServerEnsureResult) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly pendingThreadArchiveSyncs = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      resolve: (result: ThreadArchiveSyncResult) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly appServerReportCache = new Map<
    string,
    {
      fingerprint: string;
      acceptedAt: number;
    }
  >();
  private readonly hostSessionsRefreshSentAt = new Map<string, number>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/dispatch-pending") {
      return this.dispatchPending(request);
    }

    if (url.pathname === "/internal/refresh-host-sessions") {
      return this.refreshHostSessions();
    }

    if (url.pathname === "/internal/create-local-thread") {
      return this.createLocalThread(request);
    }

    if (url.pathname === "/internal/backfill-host-session") {
      return this.backfillHostSession(request);
    }

    if (url.pathname === "/internal/ensure-host-session-app-server") {
      return this.ensureHostSessionAppServer(request);
    }

    if (url.pathname === "/internal/sync-thread-archive") {
      return this.syncThreadArchive(request);
    }

    if (url.pathname === "/internal/broadcast-thread-events") {
      return this.broadcastThreadEvents(request);
    }

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const socketPair = new WebSocketPair();
    const client = socketPair[0];
    const server = socketPair[1];
    const socketType = request.headers.get("x-chaop-socket-type") === "agent" ? "agent" : "browser";
    const connectorId = request.headers.get("x-chaop-connector-id") ?? undefined;
    const tags = connectorId ? [socketType, `${socketType}:${connectorId}`] : [socketType];

    this.ctx.acceptWebSocket(server, tags);
    server.serializeAttachment({ socketType, connectorId, connectedAt: Date.now() });
    server.send(
      JSON.stringify(
        createEnvelope("server.hello", { type: "worker", id: "workspace-do-global" }, { socket_type: socketType })
      )
    );
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (attachment?.socketType === "agent" && attachment.connectorId) {
      await this.handleAgentMessage(ws, attachment.connectorId, text);
      return;
    }

    ws.send(
      JSON.stringify(
        createEnvelope("server.ack", { type: "worker", id: "workspace-do-global" }, { received: text.length })
      )
    );
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleSocketGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleSocketGone(ws);
  }

  private async dispatchPending(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => ({})) as { connector_id?: string };
    const sockets = await this.sendPendingCommandsToAgents(payload.connector_id);
    return new Response(JSON.stringify({ dispatched_to: sockets.length }), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  private async handleAgentMessage(ws: WebSocket, connectorId: string, text: string): Promise<void> {
    const message = parseMessage(text);
    if (!message) {
      ws.send(JSON.stringify(createEnvelope("server.error", { type: "worker", id: "workspace-do-global" }, { error: "Invalid JSON" })));
      return;
    }

    if (message.kind === "agent.ready") {
      if (
        message.payload !== undefined &&
        message.payload !== null &&
        !isAgentReadyPayload(message.payload)
      ) {
        ws.send(
          JSON.stringify(
            createEnvelope("server.error", { type: "worker", id: "workspace-do-global" }, {
              error: "Invalid agent.ready payload"
            })
          )
        );
        return;
      }
      const wasReady = isReadyAgentSocket(ws, connectorId);
      const readyPayload = isAgentReadyPayload(message.payload) ? message.payload : undefined;
      const capabilitiesChanged = readyPayload
        ? await updateConnectorCapabilities(this.env, connectorId, readyPayload.capabilities)
        : false;
      this.markAgentReady(ws, connectorId);
      ws.send(
        JSON.stringify(
          createEnvelope("server.ack", { type: "worker", id: "workspace-do-global" }, {
            kind: "agent.ready",
            capabilities: readyPayload ? readyPayload.capabilities : []
          })
        )
      );
      if (readyPayload && (!wasReady || capabilitiesChanged)) {
        this.dispatchHostSessionsRefreshToSocket(ws, connectorId);
        await this.broadcastConnectorUpdate(connectorId);
        await this.sendPendingCommandsAndReleased(ws, connectorId);
      }
      if (!readyPayload && !wasReady) {
        await markConnectorOnline(this.env, connectorId);
        this.dispatchHostSessionsRefreshToSocket(ws, connectorId);
        await this.broadcastConnectorUpdate(connectorId);
        await this.sendPendingCommandsAndReleased(ws, connectorId);
      }
      return;
    }

    if (message.kind === "agent.host_sessions" && isAgentHostSessionsReport(message.payload)) {
      const result = await recordHostSessions(this.env, connectorId, message.payload);
      ws.send(
        JSON.stringify(
          createEnvelope("server.ack", { type: "worker", id: "workspace-do-global" }, {
            kind: "agent.host_sessions",
            count: result.host_sessions.length,
            synced_at: result.synced_at
          })
        )
      );
      this.broadcastToBrowsers(hostSessionsMessage({
        host_sessions: result.host_sessions,
        connector_id: connectorId,
        synced_at: result.synced_at,
        snapshot: message.payload.inventory_scope === "full"
      }));
      for (const event of result.failed_events) {
        this.broadcastToBrowsers(threadEventMessage(event));
      }
      for (const releasedConnectorId of result.released_connector_ids) {
        await this.sendPendingCommandsToAgents(releasedConnectorId);
      }
      if (this.consumePendingHostSessionsDispatch(ws, connectorId)) {
        await this.sendPendingCommandsAndReleased(ws, connectorId);
      }
      return;
    }

    if (message.kind === "agent.app_server_instances") {
      if (!isAgentAppServerInstancesReport(message.payload)) {
        ws.send(
          JSON.stringify(
            createEnvelope("server.error", { type: "worker", id: "workspace-do-global" }, {
              error: "Invalid agent.app_server_instances payload"
            })
          )
        );
        return;
      }
      const reportFingerprint = cacheableAppServerReportFingerprint(message.payload);
      const deduped = this.shouldSkipDuplicateAppServerReport(connectorId, reportFingerprint);
      const result = deduped
        ? { app_server_instances: [], synced_at: new Date().toISOString(), snapshot: message.payload.snapshot === true }
        : await recordAppServerInstances(this.env, connectorId, message.payload);
      if (!deduped) {
        this.rememberAppServerReport(connectorId, reportFingerprint);
      }
      ws.send(
        JSON.stringify(
          createEnvelope("server.ack", { type: "worker", id: "workspace-do-global" }, {
            kind: "agent.app_server_instances",
            count: result.app_server_instances.length,
            synced_at: result.synced_at,
            deduped,
            report_id: message.payload.report_id
          })
        )
      );
      if (result.app_server_instances.length > 0 || result.snapshot) {
        this.broadcastToBrowsers(appServerInstancesMessage({
          app_server_instances: result.app_server_instances,
          connector_id: connectorId,
          synced_at: result.synced_at,
          snapshot: result.snapshot
        }));
      }
      return;
    }

    if (message.kind === "agent.event" && isAgentCommandEvent(message.payload)) {
      const result = await recordAgentEvent(this.env, connectorId, message.payload);
      ws.send(
        JSON.stringify(
          createEnvelope("server.ack", { type: "worker", id: "workspace-do-global" }, {
            command_id: message.payload.command_id,
            kind: message.payload.kind,
            accepted: result.accepted
          })
        )
      );
      if (result.event) {
        this.broadcastToBrowsers(threadEventMessage(result.event));
      }
      const finalCommandEvent =
        message.payload.kind === "command.finished" || message.payload.kind === "command.failed";
      const resultFinalCommandEvent =
        result.event?.kind === "command.finished" || result.event?.kind === "command.failed";
      if (result.accepted && (finalCommandEvent || resultFinalCommandEvent)) {
        this.clearSocketCommand(ws, connectorId, message.payload.command_id);
        await this.sendPendingCommandsAndReleased(ws, connectorId);
      } else if (!result.accepted && result.dispatch_pending) {
        this.clearSocketCommand(ws, connectorId, message.payload.command_id);
        await this.sendPendingCommandsToAgents();
      } else if (!result.accepted && (finalCommandEvent || resultFinalCommandEvent)) {
        this.clearSocketCommand(ws, connectorId, message.payload.command_id);
        await this.sendPendingCommandsAndReleased(ws, connectorId);
      }
      return;
    }

    if (message.kind === "thread.create_result" && isLocalThreadCreateResult(message.payload)) {
      this.resolveLocalThreadCreate(message.payload);
      ws.send(
        JSON.stringify(
          createEnvelope("server.ack", { type: "worker", id: "workspace-do-global" }, {
            kind: "thread.create_result",
            request_id: message.payload.request_id
          })
        )
      );
      return;
    }

    if (message.kind === "host_session.backfill_result" && isHostSessionBackfillResult(message.payload)) {
      this.resolveHostSessionBackfill(message.payload);
      ws.send(
        JSON.stringify(
          createEnvelope("server.ack", { type: "worker", id: "workspace-do-global" }, {
            kind: "host_session.backfill_result",
            request_id: message.payload.request_id
          })
        )
      );
      return;
    }

    if (message.kind === "host_session.app_server_ensure_result" && isHostSessionAppServerEnsureResult(message.payload)) {
      this.resolveHostSessionAppServerEnsure(message.payload);
      ws.send(
        JSON.stringify(
          createEnvelope("server.ack", { type: "worker", id: "workspace-do-global" }, {
            kind: "host_session.app_server_ensure_result",
            request_id: message.payload.request_id
          })
        )
      );
      return;
    }

    if (message.kind === "thread.archive_sync_result" && isThreadArchiveSyncResult(message.payload)) {
      this.resolveThreadArchiveSync(message.payload);
      ws.send(
        JSON.stringify(
          createEnvelope("server.ack", { type: "worker", id: "workspace-do-global" }, {
            kind: "thread.archive_sync_result",
            request_id: message.payload.request_id
          })
        )
      );
      return;
    }

    ws.send(JSON.stringify(createEnvelope("server.ack", { type: "worker", id: "workspace-do-global" }, { received: text.length })));
  }

  private broadcastToBrowsers(message: string): void {
    for (const socket of this.ctx.getWebSockets("browser")) {
      socket.send(message);
    }
  }

  private async broadcastConnectorUpdate(
    connectorId: string,
    options: { degraded?: boolean; includeOffline?: boolean } = {}
  ): Promise<void> {
    const connector = await getConnectorSummary(this.env, connectorId, options);
    if (!connector) return;
    const syncedAt = new Date().toISOString();
    this.broadcastToBrowsers(connectorsMessage({
      connectors: [
        options.degraded
          ? { ...connector, status: "degraded", capabilities: [], updated_at: syncedAt }
          : connector
      ],
      synced_at: syncedAt
    }));
  }

  private shouldSkipDuplicateAppServerReport(
    connectorId: string,
    fingerprint: string | undefined
  ): boolean {
    if (!fingerprint) return false;
    const cached = this.appServerReportCache.get(connectorId);
    const now = Date.now();
    return Boolean(
      cached &&
      cached.fingerprint === fingerprint &&
      now - cached.acceptedAt < APP_SERVER_REPORT_CACHE_MS
    );
  }

  private rememberAppServerReport(connectorId: string, fingerprint: string | undefined): void {
    if (!fingerprint) {
      this.appServerReportCache.delete(connectorId);
      return;
    }
    this.appServerReportCache.set(connectorId, { fingerprint, acceptedAt: Date.now() });
  }

  private async broadcastThreadEvents(request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined) as { events?: unknown } | undefined;
    const events = Array.isArray(body?.events) ? body.events.filter(isThreadEvent) : [];
    for (const event of events) {
      this.broadcastToBrowsers(threadEventMessage(event));
    }
    return new Response(JSON.stringify({ broadcasted: events.length }), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  private async handleSocketGone(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (attachment?.socketType !== "agent" || !attachment.connectorId) {
      return;
    }
    if (attachment.pendingHostSessionsDispatch) {
      this.hostSessionsRefreshSentAt.delete(attachment.connectorId);
    }
    const hasAuthenticatedPeer = hasPeerAgentSocket(this.ctx, attachment.connectorId, ws);
    const hasReadyPeer = hasReadyPeerAgentSocket(this.ctx, attachment.connectorId, ws);
    const activeCommandIds = socketActiveCommandIds(ws, attachment.connectorId);

    if (!hasReadyPeer || activeCommandIds.length > 0) {
      const events = await failActiveCommandsForConnector(
        this.env,
        attachment.connectorId,
        hasReadyPeer ? { commandIds: activeCommandIds } : {}
      );
      for (const event of events) {
        this.broadcastToBrowsers(threadEventMessage(event));
      }
      if (!hasReadyPeer) {
        const stoppedAt = new Date().toISOString();
        this.appServerReportCache.delete(attachment.connectorId);
        const stoppedInstances = await markAppServerInstancesStoppedForConnector(this.env, attachment.connectorId, stoppedAt);
        if (stoppedInstances.length > 0) {
          this.broadcastToBrowsers(appServerInstancesMessage({
            app_server_instances: stoppedInstances,
            connector_id: attachment.connectorId,
            synced_at: stoppedAt
          }));
        }
      }
      if (!hasReadyPeer && hasAuthenticatedPeer) {
        await markConnectorDegraded(this.env, attachment.connectorId);
        await this.broadcastConnectorUpdate(attachment.connectorId, { degraded: true });
      }
    }
    if (!hasAuthenticatedPeer) {
      await markConnectorOffline(this.env, attachment.connectorId);
      await this.broadcastConnectorUpdate(attachment.connectorId, { includeOffline: true });
    }
  }

  private refreshHostSessions(): Response {
    const sockets = this.ctx.getWebSockets("agent");
    const latestReadySocketByConnector = new Map<string, WebSocket>();
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
      const connectorId = attachment?.connectorId;
      if (!connectorId || !isReadyAgentSocket(socket, connectorId)) {
        continue;
      }
      const previous = latestReadySocketByConnector.get(connectorId);
      if (!previous || socketConnectedAt(socket) > socketConnectedAt(previous)) {
        latestReadySocketByConnector.set(connectorId, socket);
      }
    }

    const now = Date.now();
    let dispatchedTo = 0;
    let debouncedConnectorCount = 0;
    for (const [connectorId, socket] of latestReadySocketByConnector) {
      const lastSentAt = this.hostSessionsRefreshSentAt.get(connectorId);
      if (
        lastSentAt !== undefined &&
        now - lastSentAt < HOST_SESSIONS_REFRESH_COOLDOWN_MS
      ) {
        debouncedConnectorCount += 1;
        continue;
      }

      if (this.dispatchHostSessionsRefreshToSocket(socket, connectorId, now)) {
        dispatchedTo += 1;
      } else {
        debouncedConnectorCount += 1;
      }
    }
    return new Response(JSON.stringify({
      dispatched_to: dispatchedTo,
      debounced_connector_count: debouncedConnectorCount,
      cooldown_ms: HOST_SESSIONS_REFRESH_COOLDOWN_MS
    }), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  private dispatchHostSessionsRefreshToSocket(socket: WebSocket, connectorId: string, now = Date.now()): boolean {
    if (this.hasPendingHostSessionsDispatchForConnector(connectorId)) {
      return false;
    }
    const lastSentAt = this.hostSessionsRefreshSentAt.get(connectorId);
    if (
      lastSentAt !== undefined &&
      now - lastSentAt < HOST_SESSIONS_REFRESH_COOLDOWN_MS
    ) {
      return false;
    }

    socket.send(
      JSON.stringify(
        createEnvelope("host_sessions.refresh", { type: "worker", id: "workspace-do-global" }, {}, {
          target: { type: "connector", id: connectorId }
        })
      )
    );
    this.hostSessionsRefreshSentAt.set(connectorId, now);
    this.markHostSessionsRefreshPending(socket, connectorId);
    return true;
  }

  private async createLocalThread(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => ({})) as Partial<LocalThreadCreateDispatch> & {
      connector_id?: unknown;
    };
    const connectorId = typeof payload.connector_id === "string" ? payload.connector_id : undefined;
    if (!connectorId) {
      return jsonResponse({ error: "Missing connector_id" }, 400);
    }
    if (!isLocalThreadCreateDispatch(payload)) {
      return jsonResponse({ error: "Invalid local thread create payload" }, 400);
    }

    const sockets = agentSocketsForConnector(this.ctx, connectorId);
    const socket = sockets[0];
    if (!socket) {
      return jsonResponse({ error: "Connector is not connected" }, 404);
    }

    try {
      const result = await this.waitForLocalThreadCreate(payload.request_id, () => {
        socket.send(
          JSON.stringify(
            createEnvelope("thread.create", { type: "worker", id: "workspace-do-global" }, payload, {
              target: { type: "connector", id: connectorId },
              workspace_id: payload.workspace_id
            })
          )
        );
      });
      if (!result.ok || !result.session) {
        return jsonResponse({ error: result.error ?? "Connector could not create the local thread" }, 502);
      }
      return jsonResponse({ session: result.session });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "Connector did not respond" }, 504);
    }
  }

  private async backfillHostSession(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => ({})) as Partial<HostSessionBackfillDispatch> & {
      connector_id?: unknown;
    };
    const connectorId = typeof payload.connector_id === "string" ? payload.connector_id : undefined;
    if (!connectorId) {
      return jsonResponse({ error: "Missing connector_id" }, 400);
    }
    if (!isHostSessionBackfillDispatch(payload)) {
      return jsonResponse({ error: "Invalid host session backfill payload" }, 400);
    }

    const sockets = agentSocketsForConnector(this.ctx, connectorId);
    const socket = sockets[0];
    if (!socket) {
      return jsonResponse({ error: "Connector is not connected" }, 404);
    }

    try {
      const result = await this.waitForHostSessionBackfill(payload.request_id, () => {
        socket.send(
          JSON.stringify(
            createEnvelope("host_session.backfill", { type: "worker", id: "workspace-do-global" }, payload, {
              target: { type: "connector", id: connectorId }
            })
          )
        );
      });
      if (!result.ok) {
        return jsonResponse({ error: result.error ?? "Connector could not backfill the host session" }, 502);
      }
      return jsonResponse({ events: result.events ?? [], truncated: result.truncated === true });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "Connector did not respond" }, 504);
    }
  }

  private async ensureHostSessionAppServer(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => ({})) as Partial<HostSessionAppServerEnsureDispatch> & {
      connector_id?: unknown;
    };
    const connectorId = typeof payload.connector_id === "string" ? payload.connector_id : undefined;
    if (!connectorId) {
      return jsonResponse({ error: "Missing connector_id" }, 400);
    }
    if (!isHostSessionAppServerEnsureDispatch(payload)) {
      return jsonResponse({ error: "Invalid host session app-server ensure payload" }, 400);
    }

    const sockets = agentSocketsForConnector(this.ctx, connectorId);
    const socket = sockets[0];
    if (!socket) {
      return jsonResponse({ error: "Connector is not connected" }, 404);
    }

    try {
      const result = await this.waitForHostSessionAppServerEnsure(payload.request_id, () => {
        socket.send(
          JSON.stringify(
            createEnvelope("host_session.app_server_ensure", { type: "worker", id: "workspace-do-global" }, payload, {
              target: { type: "connector", id: connectorId }
            })
          )
        );
      });
      if (!result.ok || !result.session) {
        return jsonResponse({ error: result.error ?? "Connector could not attach the host session through app-server" }, 502);
      }
      return jsonResponse({ session: result.session });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "Connector did not respond" }, 504);
    }
  }

  private async syncThreadArchive(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => ({})) as Partial<ThreadArchiveSyncDispatch> & {
      connector_id?: unknown;
    };
    const connectorId = typeof payload.connector_id === "string" ? payload.connector_id : undefined;
    if (!connectorId) {
      return jsonResponse({ error: "Missing connector_id" }, 400);
    }
    if (!isThreadArchiveSyncDispatch(payload)) {
      return jsonResponse({ error: "Invalid thread archive sync payload" }, 400);
    }

    const sockets = agentSocketsForConnector(this.ctx, connectorId);
    const socket = sockets[0];
    if (!socket) {
      return jsonResponse({ error: "Connector is not connected" }, 404);
    }

    try {
      const result = await this.waitForThreadArchiveSync(payload.request_id, () => {
        socket.send(
          JSON.stringify(
            createEnvelope("thread.archive_sync", { type: "worker", id: "workspace-do-global" }, payload, {
              target: { type: "connector", id: connectorId }
            })
          )
        );
      });
      if (!result.ok) {
        return jsonResponse({ error: result.error ?? "Connector could not sync the thread archive state" }, 502);
      }
      return jsonResponse({ ok: true, synced: result.synced !== false });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "Connector did not respond" }, 504);
    }
  }

  private async waitForLocalThreadCreate(
    requestId: string,
    send: () => void
  ): Promise<LocalThreadCreateResult> {
    return await new Promise<LocalThreadCreateResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingThreadCreates.delete(requestId);
        reject(new Error("Connector timed out while creating the local thread"));
      }, THREAD_CREATE_TIMEOUT_MS);
      this.pendingThreadCreates.set(requestId, { timer, resolve, reject });
      try {
        send();
      } catch (error) {
        clearTimeout(timer);
        this.pendingThreadCreates.delete(requestId);
        reject(error instanceof Error ? error : new Error("Connector send failed"));
      }
    });
  }

  private resolveLocalThreadCreate(result: LocalThreadCreateResult): void {
    const pending = this.pendingThreadCreates.get(result.request_id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingThreadCreates.delete(result.request_id);
    pending.resolve(result);
  }

  private async waitForHostSessionBackfill(
    requestId: string,
    send: () => void
  ): Promise<HostSessionBackfillResult> {
    return await new Promise<HostSessionBackfillResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHostSessionBackfills.delete(requestId);
        reject(new Error("Connector timed out while backfilling the host session"));
      }, HOST_SESSION_BACKFILL_TIMEOUT_MS);
      this.pendingHostSessionBackfills.set(requestId, { timer, resolve, reject });
      try {
        send();
      } catch (error) {
        clearTimeout(timer);
        this.pendingHostSessionBackfills.delete(requestId);
        reject(error instanceof Error ? error : new Error("Connector send failed"));
      }
    });
  }

  private resolveHostSessionBackfill(result: HostSessionBackfillResult): void {
    const pending = this.pendingHostSessionBackfills.get(result.request_id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingHostSessionBackfills.delete(result.request_id);
    pending.resolve(result);
  }

  private async waitForHostSessionAppServerEnsure(
    requestId: string,
    send: () => void
  ): Promise<HostSessionAppServerEnsureResult> {
    return await new Promise<HostSessionAppServerEnsureResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHostSessionAppServerEnsures.delete(requestId);
        reject(new Error("Connector timed out while attaching the host session through app-server"));
      }, HOST_SESSION_APP_SERVER_ENSURE_TIMEOUT_MS);
      this.pendingHostSessionAppServerEnsures.set(requestId, { timer, resolve, reject });
      try {
        send();
      } catch (error) {
        clearTimeout(timer);
        this.pendingHostSessionAppServerEnsures.delete(requestId);
        reject(error instanceof Error ? error : new Error("Connector send failed"));
      }
    });
  }

  private resolveHostSessionAppServerEnsure(result: HostSessionAppServerEnsureResult): void {
    const pending = this.pendingHostSessionAppServerEnsures.get(result.request_id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingHostSessionAppServerEnsures.delete(result.request_id);
    pending.resolve(result);
  }

  private async waitForThreadArchiveSync(
    requestId: string,
    send: () => void
  ): Promise<ThreadArchiveSyncResult> {
    return await new Promise<ThreadArchiveSyncResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingThreadArchiveSyncs.delete(requestId);
        reject(new Error("Connector timed out while syncing the thread archive state"));
      }, THREAD_ARCHIVE_SYNC_TIMEOUT_MS);
      this.pendingThreadArchiveSyncs.set(requestId, { timer, resolve, reject });
      try {
        send();
      } catch (error) {
        clearTimeout(timer);
        this.pendingThreadArchiveSyncs.delete(requestId);
        reject(error instanceof Error ? error : new Error("Connector send failed"));
      }
    });
  }

  private resolveThreadArchiveSync(result: ThreadArchiveSyncResult): void {
    const pending = this.pendingThreadArchiveSyncs.get(result.request_id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingThreadArchiveSyncs.delete(result.request_id);
    pending.resolve(result);
  }

  private async sendPendingCommands(
    ws: WebSocket,
    connectorId: string,
    options: { skipStaleExplicitCleanup?: boolean } = {}
  ): Promise<string[]> {
    if (
      !isReadyAgentSocket(ws, connectorId) ||
      this.hasPendingHostSessionsDispatchForConnector(connectorId)
    ) {
      return [];
    }
    let releasedConnectorIds: string[] = [];
    if (!options.skipStaleExplicitCleanup) {
      releasedConnectorIds = await this.cleanupStaleExplicitAppServerCommandTargets(connectorId);
    }
    const dispatches = await pendingCommandsForConnector(this.env, connectorId);
    for (const payload of dispatches) {
      const command = payload.command;
      this.recordSocketCommand(ws, connectorId, command.id);
      try {
        ws.send(
          JSON.stringify(
            createEnvelope("command.dispatch", { type: "worker", id: "workspace-do-global" }, payload, {
              workspace_id: command.workspace_id,
              thread_id: command.thread_id,
              command_id: command.id,
              target: { type: "connector", id: connectorId }
            })
          )
        );
      } catch {
        this.clearSocketCommand(ws, connectorId, command.id);
        const markedUnavailable = this.markSocketDispatchUnavailable(ws, connectorId);
        await releaseLeasedCommandsForConnector(this.env, connectorId, [command.id]);
        if (markedUnavailable && !hasReadyPeerAgentSocket(this.ctx, connectorId, ws)) {
          await markConnectorDegraded(this.env, connectorId);
          await this.broadcastConnectorUpdate(connectorId, { degraded: true });
        }
        if (markedUnavailable) {
          await this.sendPendingCommandsToAgents(connectorId);
        }
      }
    }
    return releasedConnectorIds;
  }

  private hasPendingHostSessionsDispatchForConnector(connectorId: string): boolean {
    if (typeof this.ctx.getWebSockets !== "function") {
      return false;
    }
    const taggedSockets = this.ctx.getWebSockets(`agent:${connectorId}`);
    const sockets = taggedSockets.length > 0
      ? taggedSockets
      : this.ctx.getWebSockets("agent").filter((socket) => isAgentSocketForConnector(socket, connectorId));
    return sockets.some((socket) => hasPendingHostSessionsDispatch(socket, connectorId));
  }

  private async sendPendingCommandsAndReleased(ws: WebSocket, connectorId: string): Promise<void> {
    const releasedConnectorIds = await this.sendPendingCommands(ws, connectorId);
    for (const releasedConnectorId of releasedConnectorIds) {
      if (releasedConnectorId !== connectorId) {
        await this.sendPendingCommandsToAgents(releasedConnectorId);
      }
    }
  }

  private async cleanupStaleExplicitAppServerCommandTargets(connectorId: string): Promise<string[]> {
    const result = await cleanupStaleExplicitAppServerCommandTargets(this.env, connectorId);
    for (const event of result.failed_events) {
      this.broadcastToBrowsers(threadEventMessage(event));
    }
    return result.released_connector_ids;
  }

  private async sendPendingCommandsToAgents(connectorId?: string): Promise<WebSocket[]> {
    if (connectorId) {
      const sockets = this.ctx.getWebSockets(`agent:${connectorId}`);
      if (sockets.some((socket) => hasPendingHostSessionsDispatch(socket, connectorId))) {
        return [];
      }
      const releasedConnectorIds = await this.cleanupStaleExplicitAppServerCommandTargets(connectorId);
      const targetConnectorIds = new Set([connectorId, ...releasedConnectorIds]);
      const readySockets = [...targetConnectorIds].flatMap((targetConnectorId) => {
        const targetSockets = this.ctx.getWebSockets(`agent:${targetConnectorId}`);
        return targetSockets.some((socket) => hasPendingHostSessionsDispatch(socket, targetConnectorId))
          ? []
          : agentSocketsForConnector({ getWebSockets: () => targetSockets }, targetConnectorId).slice(0, 1);
      });
      if (readySockets.length === 0) {
        return [];
      }
      await Promise.all(
        readySockets.map((socket) => {
          const attachment = socket.deserializeAttachment() as { connectorId?: string } | undefined;
          return attachment?.connectorId
            ? this.sendPendingCommands(socket, attachment.connectorId, { skipStaleExplicitCleanup: true })
            : undefined;
        })
      );
      return readySockets;
    }

    const sockets = this.ctx.getWebSockets("agent");
    const connectorIds = new Set<string>();
    const pendingRefreshConnectorIds = new Set<string>();
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment() as { connectorId?: string } | undefined;
      if (attachment?.connectorId) {
        connectorIds.add(attachment.connectorId);
        if (hasPendingHostSessionsDispatch(socket, attachment.connectorId)) {
          pendingRefreshConnectorIds.add(attachment.connectorId);
        }
      }
    }
    for (const cleanupConnectorId of connectorIds) {
      if (pendingRefreshConnectorIds.has(cleanupConnectorId)) {
        continue;
      }
      const releasedConnectorIds = await this.cleanupStaleExplicitAppServerCommandTargets(cleanupConnectorId);
      for (const releasedConnectorId of releasedConnectorIds) {
        connectorIds.add(releasedConnectorId);
      }
    }
    const readySockets = [...connectorIds].flatMap((connectorId) =>
      pendingRefreshConnectorIds.has(connectorId)
        ? []
        : sockets
          .filter((socket) => isDispatchReadyAgentSocket(socket, connectorId))
          .sort((left, right) => socketConnectedAt(right) - socketConnectedAt(left))
          .slice(0, 1)
    );
    await Promise.all(readySockets.map((socket) => {
      const attachment = socket.deserializeAttachment() as { connectorId?: string } | undefined;
      return attachment?.connectorId
        ? this.sendPendingCommands(socket, attachment.connectorId, { skipStaleExplicitCleanup: true })
        : undefined;
    }));
    return readySockets;
  }

  private markAgentReady(ws: WebSocket, connectorId: string, pendingHostSessionsDispatch = false): void {
    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    const existingDeadline = attachment?.pendingHostSessionsDispatchDeadline;
    const existingPending =
      attachment?.pendingHostSessionsDispatch === true &&
      typeof existingDeadline === "number" &&
      existingDeadline > Date.now();
    const nextPending = existingPending || pendingHostSessionsDispatch;
    const nextAttachment: SocketAttachment = {
      ...attachment,
      socketType: "agent",
      connectorId,
      agentReady: true,
      pendingHostSessionsDispatch: nextPending
    };
    if (pendingHostSessionsDispatch) {
      nextAttachment.pendingHostSessionsDispatchDeadline = Date.now() + HOST_SESSIONS_REFRESH_DISPATCH_WAIT_MS;
    } else if (existingPending) {
      nextAttachment.pendingHostSessionsDispatchDeadline = existingDeadline;
    } else {
      delete nextAttachment.pendingHostSessionsDispatchDeadline;
    }
    ws.serializeAttachment(nextAttachment);
  }

  private consumePendingHostSessionsDispatch(ws: WebSocket, connectorId: string): boolean {
    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (
      attachment?.socketType !== "agent" ||
      attachment.connectorId !== connectorId ||
      attachment.agentReady !== true ||
      attachment.pendingHostSessionsDispatch !== true
    ) {
      return false;
    }
    ws.serializeAttachment(withoutPendingHostSessionsDispatch(attachment));
    return true;
  }

  private markHostSessionsRefreshPending(ws: WebSocket, connectorId: string): void {
    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (
      attachment?.socketType !== "agent" ||
      attachment.connectorId !== connectorId ||
      attachment.agentReady !== true
    ) {
      return;
    }
    ws.serializeAttachment({
      ...attachment,
      pendingHostSessionsDispatch: true,
      pendingHostSessionsDispatchDeadline: Date.now() + HOST_SESSIONS_REFRESH_DISPATCH_WAIT_MS
    });
  }

  private recordSocketCommand(ws: WebSocket, connectorId: string, commandId: string): void {
    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (
      attachment?.socketType !== "agent"
      || attachment.connectorId !== connectorId
      || typeof ws.serializeAttachment !== "function"
    ) {
      return;
    }
    ws.serializeAttachment({
      ...attachment,
      activeCommandIds: [...new Set([...(attachment.activeCommandIds ?? []), commandId])]
    });
  }

  private clearSocketCommand(ws: WebSocket, connectorId: string, commandId: string): void {
    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (
      attachment?.socketType !== "agent"
      || attachment.connectorId !== connectorId
      || typeof ws.serializeAttachment !== "function"
    ) {
      return;
    }
    ws.serializeAttachment({
      ...attachment,
      activeCommandIds: (attachment.activeCommandIds ?? []).filter((item) => item !== commandId)
    });
  }

  private markSocketDispatchUnavailable(ws: WebSocket, connectorId: string): boolean {
    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (
      attachment?.socketType !== "agent"
      || attachment.connectorId !== connectorId
      || typeof ws.serializeAttachment !== "function"
    ) {
      return false;
    }
    ws.serializeAttachment({
      ...withoutPendingHostSessionsDispatch(attachment),
      agentReady: false
    });
    return true;
  }
}

export function hasPeerAgentSocket(
  ctx: Pick<DurableObjectState, "getWebSockets">,
  connectorId: string,
  socket: WebSocket
): boolean {
  return ctx.getWebSockets(`agent:${connectorId}`)
    .some((candidate) => candidate !== socket && isAgentSocketForConnector(candidate, connectorId));
}

export function hasReadyPeerAgentSocket(
  ctx: Pick<DurableObjectState, "getWebSockets">,
  connectorId: string,
  socket: WebSocket
): boolean {
  return ctx.getWebSockets(`agent:${connectorId}`)
    .some((candidate) => candidate !== socket && isReadyAgentSocket(candidate, connectorId));
}

export function agentSocketsForConnector(
  ctx: Pick<DurableObjectState, "getWebSockets">,
  connectorId: string
): WebSocket[] {
  return [...ctx.getWebSockets(`agent:${connectorId}`)]
    .filter((socket) => isReadyAgentSocket(socket, connectorId))
    .sort((left, right) => socketConnectedAt(right) - socketConnectedAt(left));
}

function socketConnectedAt(socket: WebSocket): number {
  const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
  return typeof attachment?.connectedAt === "number" ? attachment.connectedAt : 0;
}

function socketActiveCommandIds(socket: WebSocket, connectorId: string): string[] {
  const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
  if (attachment?.socketType !== "agent" || attachment.connectorId !== connectorId) {
    return [];
  }
  return Array.isArray(attachment.activeCommandIds) ? attachment.activeCommandIds.filter(Boolean) : [];
}

function isReadyAgentSocket(socket: WebSocket, connectorId: string): boolean {
  const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
  return (
    attachment?.socketType === "agent" &&
    attachment.connectorId === connectorId &&
    attachment.agentReady === true
  );
}

function isDispatchReadyAgentSocket(socket: WebSocket, connectorId: string): boolean {
  return isReadyAgentSocket(socket, connectorId) && !hasPendingHostSessionsDispatch(socket, connectorId);
}

function isAgentSocketForConnector(socket: WebSocket, connectorId: string): boolean {
  const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
  return attachment?.socketType === "agent" && attachment.connectorId === connectorId;
}

function hasPendingHostSessionsDispatch(socket: WebSocket, connectorId: string): boolean {
  const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
  const pending =
    attachment?.socketType === "agent" &&
    attachment.connectorId === connectorId &&
    isActivePendingHostSessionsDispatch(attachment);
  if (!pending && attachment?.pendingHostSessionsDispatch === true) {
    socket.serializeAttachment(withoutPendingHostSessionsDispatch(attachment));
  }
  return pending;
}

function withoutPendingHostSessionsDispatch(attachment: SocketAttachment | undefined): SocketAttachment {
  const next = {
    ...attachment,
    pendingHostSessionsDispatch: false
  };
  delete next.pendingHostSessionsDispatchDeadline;
  return next;
}

function isActivePendingHostSessionsDispatch(attachment: SocketAttachment | undefined): boolean {
  return (
    attachment?.pendingHostSessionsDispatch === true &&
    typeof attachment.pendingHostSessionsDispatchDeadline === "number" &&
    attachment.pendingHostSessionsDispatchDeadline > Date.now()
  );
}

export function threadEventMessage(event: ThreadEvent): string {
  return JSON.stringify(
    createEnvelope("thread.event", { type: "worker", id: "workspace-do-global" }, { event }, {
      thread_id: event.thread_id,
      command_id: event.command_id
    })
  );
}

export function hostSessionsMessage(payload: HostSessionsUpdatePayload): string {
  return JSON.stringify(
    createEnvelope("host_sessions.updated", { type: "worker", id: "workspace-do-global" }, payload)
  );
}

export function connectorsMessage(payload: ConnectorsUpdatePayload): string {
  return JSON.stringify(
    createEnvelope("connectors.updated", { type: "worker", id: "workspace-do-global" }, payload)
  );
}

export function appServerInstancesMessage(payload: AppServerInstancesUpdatePayload): string {
  return JSON.stringify(
    createEnvelope("app_server_instances.updated", { type: "worker", id: "workspace-do-global" }, payload)
  );
}

function parseMessage(text: string): { kind?: string; payload?: unknown } | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

function isAgentReadyPayload(value: unknown): value is { capabilities: string[] } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.capabilities) &&
    record.capabilities.every((capability) => typeof capability === "string")
  );
}

function isAgentAppServerInstancesReport(value: unknown): value is AgentAppServerInstancesReport {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.report_id !== undefined && !isBoundedString(record.report_id, 128)) return false;
  if (record.snapshot !== undefined && typeof record.snapshot !== "boolean") return false;
  if (!Array.isArray(record.instances) || record.instances.length > 16) return false;
  return record.instances.every(isAgentAppServerInstance);
}

function isAgentAppServerInstance(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const scope = record.scope;
  const hasValidBaseFields = (
    isBoundedString(record.instance_key, 128) &&
    (scope === "connector" || scope === "workspace" || scope === "thread") &&
    (record.workspace_id === undefined || isBoundedString(record.workspace_id, 128)) &&
    (record.thread_id === undefined || isBoundedString(record.thread_id, 128)) &&
    (record.endpoint_type === "managed" || record.endpoint_type === "external") &&
    (
      record.state === "healthy" ||
      record.state === "degraded" ||
      record.state === "draining" ||
      record.state === "restarting" ||
      record.state === "stopped"
    ) &&
    (record.active_turn_count === undefined || isNonNegativeInteger(record.active_turn_count, 1_000_000)) &&
    (record.generation === undefined || isNonNegativeInteger(record.generation, 1_000_000_000)) &&
    (record.status_summary === undefined || isBoundedString(record.status_summary, 512)) &&
    (record.last_error === undefined || isBoundedString(record.last_error, 512)) &&
    (
      record.reason === undefined ||
      record.reason === "edge" ||
      record.reason === "summary" ||
      record.reason === "shutdown"
    )
  );
  if (!hasValidBaseFields) return false;
  if (scope === "connector") {
    return record.workspace_id === undefined && record.thread_id === undefined;
  }
  if (scope === "workspace") {
    return record.workspace_id !== undefined && record.thread_id === undefined;
  }
  return record.thread_id !== undefined;
}

function cacheableAppServerReportFingerprint(report: AgentAppServerInstancesReport): string | undefined {
  if (report.snapshot === true || report.instances.length === 0) return undefined;
  if (report.instances.some((instance) => instance.state !== "healthy")) return undefined;
  return JSON.stringify(report.instances.map((instance) => ({
    instance_key: instance.instance_key,
    scope: instance.scope,
    workspace_id: instance.workspace_id ?? "",
    thread_id: instance.thread_id ?? "",
    endpoint_type: instance.endpoint_type,
    state: instance.state,
    active_turn_count: instance.active_turn_count ?? 0,
    generation: instance.generation ?? 0,
    status_summary: instance.status_summary ?? "",
    last_error: instance.last_error ?? ""
  })));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isNonNegativeInteger(value: unknown, maxValue: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maxValue;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function isAgentCommandEvent(value: unknown): value is AgentCommandEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.command_id === "string" &&
    (record.kind === "command.started" ||
      record.kind === "command.output" ||
      record.kind === "command.finished" ||
      record.kind === "command.failed") &&
    (record.priority === "P0" || record.priority === "P1" || record.priority === "P2" || record.priority === "P3") &&
    (record.target_host_session_id === undefined || typeof record.target_host_session_id === "string") &&
    typeof record.summary === "string"
  );
}

function isThreadEvent(value: unknown): value is ThreadEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.thread_id === "string" &&
    (record.command_id === undefined || typeof record.command_id === "string") &&
    typeof record.seq === "number" &&
    Number.isFinite(record.seq) &&
    isThreadEventKind(record.kind) &&
    (record.priority === "P0" || record.priority === "P1" || record.priority === "P2" || record.priority === "P3") &&
    typeof record.summary === "string" &&
    typeof record.created_at === "string"
  );
}

function isLocalThreadCreateDispatch(value: unknown): value is LocalThreadCreateDispatch {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.request_id === "string" &&
    record.request_id.length > 0 &&
    typeof record.workspace_id === "string" &&
    record.workspace_id.length > 0 &&
    (record.title === undefined || (typeof record.title === "string" && record.title.trim().length > 0))
  );
}

function isLocalThreadCreateResult(value: unknown): value is LocalThreadCreateResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.request_id === "string" &&
    typeof record.ok === "boolean" &&
    (record.error === undefined || typeof record.error === "string") &&
    (record.session === undefined || isAgentHostSession(record.session))
  );
}

function isHostSessionBackfillDispatch(value: unknown): value is HostSessionBackfillDispatch {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.request_id === "string" &&
    record.request_id.length > 0 &&
    typeof record.session_id === "string" &&
    record.session_id.length > 0 &&
    (record.limit === undefined || (typeof record.limit === "number" && Number.isFinite(record.limit)))
  );
}

function isHostSessionBackfillResult(value: unknown): value is HostSessionBackfillResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.request_id === "string" &&
    typeof record.ok === "boolean" &&
    (record.error === undefined || typeof record.error === "string") &&
    (record.truncated === undefined || typeof record.truncated === "boolean") &&
    (record.events === undefined || (Array.isArray(record.events) && record.events.every(isAgentBackfillEvent)))
  );
}

function isHostSessionAppServerEnsureDispatch(value: unknown): value is HostSessionAppServerEnsureDispatch {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.request_id === "string" &&
    record.request_id.length > 0 &&
    typeof record.session_id === "string" &&
    record.session_id.length > 0 &&
    (record.title === undefined || typeof record.title === "string") &&
    (record.cwd === undefined || typeof record.cwd === "string")
  );
}

function isHostSessionAppServerEnsureResult(value: unknown): value is HostSessionAppServerEnsureResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.request_id === "string" &&
    typeof record.ok === "boolean" &&
    (record.error === undefined || typeof record.error === "string") &&
    (record.session === undefined || isAgentHostSession(record.session))
  );
}

function isThreadArchiveSyncDispatch(value: unknown): value is ThreadArchiveSyncDispatch {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.request_id === "string" &&
    record.request_id.length > 0 &&
    typeof record.session_id === "string" &&
    record.session_id.length > 0 &&
    typeof record.archived === "boolean"
  );
}

function isThreadArchiveSyncResult(value: unknown): value is ThreadArchiveSyncResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.request_id === "string" &&
    typeof record.ok === "boolean" &&
    (record.synced === undefined || typeof record.synced === "boolean") &&
    (record.error === undefined || typeof record.error === "string")
  );
}

function isAgentBackfillEvent(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isThreadEventKind(record.kind) &&
    (record.priority === "P0" || record.priority === "P1" || record.priority === "P2" || record.priority === "P3") &&
    typeof record.summary === "string" &&
    record.summary.trim().length > 0 &&
    typeof record.idempotency_key === "string" &&
    record.idempotency_key.trim().length > 0 &&
    typeof record.created_at === "string" &&
    record.created_at.trim().length > 0
  );
}

function isThreadEventKind(value: unknown): boolean {
  return (
    value === "command.accepted" ||
    value === "command.started" ||
    value === "command.output" ||
    value === "command.finished" ||
    value === "command.failed" ||
    value === "approval.requested" ||
    value === "notice.throttled"
  );
}

function isAgentHostSessionsReport(value: unknown): value is AgentHostSessionsReport {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { sessions?: unknown; inventory_scope?: unknown; app_server_inventory_ok?: unknown };
  return (
    Array.isArray(record.sessions) &&
    record.sessions.every(isAgentHostSession) &&
    (record.inventory_scope === undefined ||
      record.inventory_scope === "full" ||
      record.inventory_scope === "incremental") &&
    (record.app_server_inventory_ok === undefined || typeof record.app_server_inventory_ok === "boolean")
  );
}

function isAgentHostSession(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.session_id === "string" &&
    typeof record.title === "string" &&
    (record.title_source === "metadata" ||
      record.title_source === "app_server" ||
      record.title_source === "history" ||
      record.title_source === "fallback") &&
    (record.app_server_present === undefined || typeof record.app_server_present === "boolean") &&
    (record.cwd === undefined || typeof record.cwd === "string") &&
    typeof record.updated_at === "string"
  );
}
