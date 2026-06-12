import {
  createEnvelope,
  type AgentCommandEvent,
  type AgentHostSessionsReport,
  type CommandDispatch,
  type HostSessionsUpdatePayload,
  type ThreadEvent
} from "@chaop/protocol";
import { pendingCommandsForConnector, recordAgentEvent, recordHostSessions } from "./db.js";
import type { Env } from "./types.js";

export class WorkspaceDO implements DurableObject {
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
    server.serializeAttachment({ socketType, connectorId });
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
    const attachment = ws.deserializeAttachment() as { socketType?: string; connectorId?: string } | undefined;
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

  async webSocketClose(): Promise<void> {}

  async webSocketError(): Promise<void> {}

  private async dispatchPending(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => ({})) as { connector_id?: string };
    if (payload.connector_id) {
      const sockets = this.ctx.getWebSockets(`agent:${payload.connector_id}`);
      await Promise.all(sockets.map((socket) => this.sendPendingCommands(socket, payload.connector_id!)));
      return new Response(JSON.stringify({ dispatched_to: sockets.length }), {
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    const sockets = this.ctx.getWebSockets("agent");
    await Promise.all(sockets.map((socket) => {
      const attachment = socket.deserializeAttachment() as { connectorId?: string } | undefined;
      return attachment?.connectorId ? this.sendPendingCommands(socket, attachment.connectorId) : undefined;
    }));
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
        synced_at: result.synced_at,
        snapshot: true
      }));
      return;
    }

    if (message.kind === "agent.event" && isAgentCommandEvent(message.payload)) {
      const event = await recordAgentEvent(this.env, connectorId, message.payload);
      ws.send(
        JSON.stringify(
          createEnvelope("server.ack", { type: "worker", id: "workspace-do-global" }, {
            command_id: message.payload.command_id,
            kind: message.payload.kind
          })
        )
      );
      if (event) {
        this.broadcastToBrowsers(threadEventMessage(event));
      }
      if (message.payload.kind === "command.finished" || message.payload.kind === "command.failed") {
        await this.sendPendingCommands(ws, connectorId);
      }
      return;
    }

    ws.send(JSON.stringify(createEnvelope("server.ack", { type: "worker", id: "workspace-do-global" }, { received: text.length })));
  }

  private broadcastToBrowsers(message: string): void {
    for (const socket of this.ctx.getWebSockets("browser")) {
      socket.send(message);
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

  private async sendPendingCommands(ws: WebSocket, connectorId: string): Promise<void> {
    const commands = await pendingCommandsForConnector(this.env, connectorId);
    for (const command of commands) {
      const payload: CommandDispatch = { command };
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
    typeof record.summary === "string"
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
    (record.cwd === undefined || typeof record.cwd === "string") &&
    typeof record.updated_at === "string"
  );
}
