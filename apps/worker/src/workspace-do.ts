import {
  createEnvelope,
  type AgentCommandEvent,
  type HostSessionBackfillDispatch,
  type HostSessionBackfillResult,
  type AgentHostSessionsReport,
  type HostSessionsUpdatePayload,
  type LocalThreadCreateDispatch,
  type LocalThreadCreateResult,
  type ThreadArchiveSyncDispatch,
  type ThreadArchiveSyncResult,
  type ThreadEvent
} from "@chaop/protocol";
import {
  markConnectorDisconnected,
  pendingCommandsForConnector,
  recordAgentEvent,
  recordHostSessions
} from "./db.js";
import type { Env } from "./types.js";

const THREAD_CREATE_TIMEOUT_MS = 15_000;
const HOST_SESSION_BACKFILL_TIMEOUT_MS = 15_000;
const THREAD_ARCHIVE_SYNC_TIMEOUT_MS = 20_000;

type SocketAttachment = {
  socketType?: string;
  connectorId?: string;
  connectedAt?: number;
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
  private readonly pendingThreadArchiveSyncs = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      resolve: (result: ThreadArchiveSyncResult) => void;
      reject: (error: Error) => void;
    }
  >();

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

    if (url.pathname === "/internal/sync-thread-archive") {
      return this.syncThreadArchive(request);
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
    if (socketType === "agent" && connectorId) {
      await this.sendPendingCommands(server, connectorId);
    }

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
      await this.sendPendingCommands(ws, connectorId);
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
        synced_at: result.synced_at
      }));
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
      if (result.accepted && finalCommandEvent) {
        await this.sendPendingCommands(ws, connectorId);
      } else if (!result.accepted && result.dispatch_pending) {
        await this.sendPendingCommandsToAgents();
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

  private async handleSocketGone(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as { socketType?: string; connectorId?: string } | undefined;
    if (attachment?.socketType !== "agent" || !attachment.connectorId) {
      return;
    }
    if (hasPeerAgentSocket(this.ctx, attachment.connectorId, ws)) {
      return;
    }

    const events = await markConnectorDisconnected(this.env, attachment.connectorId);
    for (const event of events) {
      this.broadcastToBrowsers(threadEventMessage(event));
    }
  }

  private refreshHostSessions(): Response {
    const sockets = this.ctx.getWebSockets("agent");
    for (const socket of sockets) {
      socket.send(
        JSON.stringify(
          createEnvelope("host_sessions.refresh", { type: "worker", id: "workspace-do-global" }, {})
        )
      );
    }
    return new Response(JSON.stringify({ dispatched_to: sockets.length }), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
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

  private async sendPendingCommands(ws: WebSocket, connectorId: string): Promise<void> {
    const dispatches = await pendingCommandsForConnector(this.env, connectorId);
    for (const payload of dispatches) {
      const command = payload.command;
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
    }
  }

  private async sendPendingCommandsToAgents(connectorId?: string): Promise<WebSocket[]> {
    if (connectorId) {
      const sockets = this.ctx.getWebSockets(`agent:${connectorId}`);
      await Promise.all(sockets.map((socket) => this.sendPendingCommands(socket, connectorId)));
      return sockets;
    }

    const sockets = this.ctx.getWebSockets("agent");
    await Promise.all(sockets.map((socket) => {
      const attachment = socket.deserializeAttachment() as { connectorId?: string } | undefined;
      return attachment?.connectorId ? this.sendPendingCommands(socket, attachment.connectorId) : undefined;
    }));
    return sockets;
  }
}

export function hasPeerAgentSocket(
  ctx: Pick<DurableObjectState, "getWebSockets">,
  connectorId: string,
  socket: WebSocket
): boolean {
  return ctx.getWebSockets(`agent:${connectorId}`).some((candidate) => candidate !== socket);
}

export function agentSocketsForConnector(
  ctx: Pick<DurableObjectState, "getWebSockets">,
  connectorId: string
): WebSocket[] {
  return [...ctx.getWebSockets(`agent:${connectorId}`)].sort(
    (left, right) => socketConnectedAt(right) - socketConnectedAt(left)
  );
}

function socketConnectedAt(socket: WebSocket): number {
  const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
  return typeof attachment?.connectedAt === "number" ? attachment.connectedAt : 0;
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

function parseMessage(text: string): { kind?: string; payload?: unknown } | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
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
  const sessions = (value as { sessions?: unknown }).sessions;
  return Array.isArray(sessions) && sessions.every(isAgentHostSession);
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
