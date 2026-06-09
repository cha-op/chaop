import { createEnvelope } from "@chaop/protocol";
import type { Env } from "./types.js";

export class WorkspaceDO implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const socketPair = new WebSocketPair();
    const client = socketPair[0];
    const server = socketPair[1];
    const socketType = request.headers.get("x-chaop-socket-type") === "agent" ? "agent" : "browser";

    this.ctx.acceptWebSocket(server, [socketType]);
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
    ws.send(
      JSON.stringify(
        createEnvelope("server.ack", { type: "worker", id: "workspace-do-global" }, { received: text.length })
      )
    );
  }

  async webSocketClose(): Promise<void> {}

  async webSocketError(): Promise<void> {}
}
