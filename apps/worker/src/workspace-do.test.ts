import assert from "node:assert/strict";
import test from "node:test";
import {
  agentSocketsForConnector,
  appServerInstancesMessage,
  connectorsMessage,
  hasPeerAgentSocket,
  hasReadyPeerAgentSocket,
  hostSessionsMessage,
  threadEventMessage,
  WorkspaceDO
} from "./workspace-do.js";
import type { Env } from "./types.js";

test("threadEventMessage wraps agent events for browser realtime consumers", () => {
  const message = threadEventMessage({
    id: "event-1",
    thread_id: "thread-1",
    command_id: "command-1",
    seq: 7,
    kind: "command.output",
    priority: "P2",
    summary: "Codex: done",
    created_at: "2026-06-11T10:00:00.000Z"
  });
  const envelope = JSON.parse(message) as {
    kind: string;
    thread_id?: string;
    command_id?: string;
    payload?: { event?: { id?: string; seq?: number; summary?: string } };
  };

  assert.equal(envelope.kind, "thread.event");
  assert.equal(envelope.thread_id, "thread-1");
  assert.equal(envelope.command_id, "command-1");
  assert.equal(envelope.payload?.event?.id, "event-1");
  assert.equal(envelope.payload?.event?.seq, 7);
  assert.equal(envelope.payload?.event?.summary, "Codex: done");
});

test("hostSessionsMessage wraps connector inventory updates for browser consumers", () => {
  const message = hostSessionsMessage({
    connector_id: "connector-1",
    synced_at: "2026-06-11T10:00:05.000Z",
    snapshot: true,
    host_sessions: [
      {
        id: "host-session-1",
        connector_id: "connector-1",
        hostname: "mac-studio.local",
        workspace_id: "workspace-api",
        session_id: "session-1",
        title: "Metadata title",
        title_source: "metadata",
        cwd: "/Users/you/Program/project",
        updated_at: "2026-06-11T10:00:00.000Z"
      }
    ]
  });
  const envelope = JSON.parse(message) as {
    kind: string;
    payload?: {
      host_sessions?: Array<{ session_id?: string; title_source?: string }>;
      connector_id?: string;
      synced_at?: string;
      snapshot?: boolean;
    };
  };

  assert.equal(envelope.kind, "host_sessions.updated");
  assert.equal(envelope.payload?.connector_id, "connector-1");
  assert.equal(envelope.payload?.synced_at, "2026-06-11T10:00:05.000Z");
  assert.equal(envelope.payload?.snapshot, true);
  assert.equal(envelope.payload?.host_sessions?.[0]?.session_id, "session-1");
  assert.equal(envelope.payload?.host_sessions?.[0]?.title_source, "metadata");
});

test("connectorsMessage wraps connector capability updates for browser consumers", () => {
  const message = connectorsMessage({
    connectors: [
      {
        id: "connector-1",
        name: "mac-studio",
        hostname: "mac-studio.local",
        status: "online",
        capabilities: ["codex_app_server_exec"],
        logical_agent_count: 1,
        active_command_count: 0,
        realtime_mode: "realtime",
        budget_state: "normal"
      }
    ],
    synced_at: "2026-06-13T10:01:00.000Z"
  });
  const envelope = JSON.parse(message) as {
    kind: string;
    payload?: { connectors?: Array<{ id?: string; capabilities?: string[] }>; synced_at?: string };
  };

  assert.equal(envelope.kind, "connectors.updated");
  assert.equal(envelope.payload?.connectors?.[0]?.id, "connector-1");
  assert.deepEqual(envelope.payload?.connectors?.[0]?.capabilities, ["codex_app_server_exec"]);
  assert.equal(envelope.payload?.synced_at, "2026-06-13T10:01:00.000Z");
});

test("appServerInstancesMessage wraps app-server instance updates for browser consumers", () => {
  const message = appServerInstancesMessage({
    connector_id: "connector-1",
    synced_at: "2026-06-14T10:00:00.000Z",
    app_server_instances: [
      {
        id: "app-server-1",
        connector_id: "connector-1",
        instance_key: "default",
        scope: "connector",
        endpoint_type: "managed",
        state: "healthy",
        active_turn_count: 1,
        generation: 1,
        last_seen_at: "2026-06-14T10:00:00.000Z",
        state_changed_at: "2026-06-14T10:00:00.000Z",
        updated_at: "2026-06-14T10:00:00.000Z"
      }
    ]
  });
  const envelope = JSON.parse(message) as {
    kind?: string;
    payload?: { app_server_instances?: Array<{ state?: string }>; connector_id?: string };
  };

  assert.equal(envelope.kind, "app_server_instances.updated");
  assert.equal(envelope.payload?.connector_id, "connector-1");
  assert.equal(envelope.payload?.app_server_instances?.[0]?.state, "healthy");
});

test("agent app-server instance report is acked and broadcast", async () => {
  const agentSent: string[] = [];
  const browserSent: string[] = [];
  const agentSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    agentReady: true
  }, agentSent);
  const browserSocket = mutableSocketWithAttachment({ socketType: "browser" }, browserSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "browser") return [browserSocket];
      return [];
    }
  } as unknown as DurableObjectState;
  const db = appServerInstanceDoDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.app_server_instances",
    payload: {
      report_id: "report-1",
      instances: [appServerInstancePayload("healthy")]
    }
  }));

  assert.equal(db.writes, 1);
  assert.equal(agentSent.length, 1);
  const ack = JSON.parse(agentSent[0] ?? "{}") as {
    payload?: { kind?: string; count?: number; deduped?: boolean; report_id?: string };
  };
  assert.equal(ack.payload?.kind, "agent.app_server_instances");
  assert.equal(ack.payload?.count, 1);
  assert.equal(ack.payload?.deduped, false);
  assert.equal(ack.payload?.report_id, "report-1");
  assert.equal(browserSent.length, 1);
  const update = JSON.parse(browserSent[0] ?? "{}") as { kind?: string; payload?: { app_server_instances?: Array<{ state?: string }> } };
  assert.equal(update.kind, "app_server_instances.updated");
  assert.equal(update.payload?.app_server_instances?.[0]?.state, "healthy");
});

test("agent app-server instance report accepts workspace and thread placement targets", async () => {
  const agentSent: string[] = [];
  const browserSent: string[] = [];
  const agentSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    agentReady: true
  }, agentSent);
  const browserSocket = mutableSocketWithAttachment({ socketType: "browser" }, browserSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "browser") return [browserSocket];
      return [];
    }
  } as unknown as DurableObjectState;
  const db = appServerInstanceDoDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.app_server_instances",
    payload: {
      report_id: "report-placements",
      instances: [
        appServerInstancePayload("healthy", {
          instance_key: "default",
          scope: "workspace",
          workspace_id: "workspace-api"
        }),
        appServerInstancePayload("healthy", {
          instance_key: "default",
          scope: "thread",
          workspace_id: "workspace-api",
          thread_id: "thread-123"
        })
      ]
    }
  }));

  assert.equal(db.writes, 2);
  const ack = JSON.parse(agentSent[0] ?? "{}") as { payload?: { count?: number } };
  assert.equal(ack.payload?.count, 2);
  const update = JSON.parse(browserSent[0] ?? "{}") as {
    payload?: {
      app_server_instances?: Array<{
        instance_key?: string;
        workspace_id?: string;
        thread_id?: string;
      }>;
    };
  };
  assert.deepEqual(
    update.payload?.app_server_instances?.map((instance) => [
      instance.instance_key,
      instance.workspace_id,
      instance.thread_id
    ]),
    [
      ["default", "workspace-api", undefined],
      ["default", "workspace-api", "thread-123"]
    ]
  );
});

test("empty app-server instance snapshot is acked and broadcast", async () => {
  const agentSent: string[] = [];
  const browserSent: string[] = [];
  const agentSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    agentReady: true
  }, agentSent);
  const browserSocket = mutableSocketWithAttachment({ socketType: "browser" }, browserSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "browser") return [browserSocket];
      return [];
    }
  } as unknown as DurableObjectState;
  const db = appServerInstanceDoDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.app_server_instances",
    payload: {
      snapshot: true,
      instances: []
    }
  }));

  assert.equal(db.writes, 0);
  assert.equal(agentSent.length, 1);
  const ack = JSON.parse(agentSent[0] ?? "{}") as { payload?: { count?: number; deduped?: boolean } };
  assert.equal(ack.payload?.count, 0);
  assert.equal(ack.payload?.deduped, false);
  assert.equal(browserSent.length, 1);
  const update = JSON.parse(browserSent[0] ?? "{}") as {
    kind?: string;
    payload?: { app_server_instances?: unknown[]; connector_id?: string; snapshot?: boolean };
  };
  assert.equal(update.kind, "app_server_instances.updated");
  assert.equal(update.payload?.connector_id, "connector-online");
  assert.equal(update.payload?.snapshot, true);
  assert.deepEqual(update.payload?.app_server_instances, []);
});

test("duplicate healthy app-server report is acked without D1 write", async () => {
  const agentSent: string[] = [];
  const browserSent: string[] = [];
  const agentSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    agentReady: true
  }, agentSent);
  const browserSocket = mutableSocketWithAttachment({ socketType: "browser" }, browserSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "browser") return [browserSocket];
      return [];
    }
  } as unknown as DurableObjectState;
  const db = appServerInstanceDoDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);
  const message = JSON.stringify({
    kind: "agent.app_server_instances",
    payload: {
      instances: [appServerInstancePayload("healthy")]
    }
  });

  await workspace.webSocketMessage(agentSocket, message);
  await workspace.webSocketMessage(agentSocket, message);

  assert.equal(db.writes, 1);
  assert.equal(browserSent.length, 1);
  const secondAck = JSON.parse(agentSent[1] ?? "{}") as { payload?: { count?: number; deduped?: boolean } };
  assert.equal(secondAck.payload?.count, 0);
  assert.equal(secondAck.payload?.deduped, true);
});

test("duplicate app-server report cache does not slide on skipped reports", async () => {
  const originalDateNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const agentSent: string[] = [];
    const agentSocket = mutableSocketWithAttachment({
      socketType: "agent",
      connectorId: "connector-online",
      agentReady: true
    }, agentSent);
    const ctx = {
      getWebSockets() {
        return [];
      }
    } as unknown as DurableObjectState;
    const db = appServerInstanceDoDb();
    const workspace = new WorkspaceDO(ctx, { DB: db } as Env);
    const message = JSON.stringify({
      kind: "agent.app_server_instances",
      payload: {
        instances: [appServerInstancePayload("healthy")]
      }
    });

    await workspace.webSocketMessage(agentSocket, message);
    now += 30_000;
    await workspace.webSocketMessage(agentSocket, message);
    now += 31_000;
    await workspace.webSocketMessage(agentSocket, message);

    const secondAck = JSON.parse(agentSent[1] ?? "{}") as { payload?: { deduped?: boolean } };
    const thirdAck = JSON.parse(agentSent[2] ?? "{}") as { payload?: { deduped?: boolean } };
    assert.equal(secondAck.payload?.deduped, true);
    assert.equal(thirdAck.payload?.deduped, false);
  } finally {
    Date.now = originalDateNow;
  }
});

test("app-server edge report bypasses duplicate healthy cache", async () => {
  const agentSent: string[] = [];
  const browserSent: string[] = [];
  const agentSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    agentReady: true
  }, agentSent);
  const browserSocket = mutableSocketWithAttachment({ socketType: "browser" }, browserSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "browser") return [browserSocket];
      return [];
    }
  } as unknown as DurableObjectState;
  const db = appServerInstanceDoDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.app_server_instances",
    payload: { instances: [appServerInstancePayload("healthy")] }
  }));
  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.app_server_instances",
    payload: { instances: [appServerInstancePayload("healthy")] }
  }));
  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.app_server_instances",
    payload: { instances: [appServerInstancePayload("degraded", { last_error: "Health failed" })] }
  }));
  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.app_server_instances",
    payload: { instances: [appServerInstancePayload("healthy")] }
  }));

  assert.equal(db.writes, 3);
  assert.equal(browserSent.length, 3);
  const edgeUpdate = JSON.parse(browserSent[1] ?? "{}") as { payload?: { app_server_instances?: Array<{ state?: string }> } };
  assert.equal(edgeUpdate.payload?.app_server_instances?.[0]?.state, "degraded");
  const recoveryUpdate = JSON.parse(browserSent[2] ?? "{}") as { payload?: { app_server_instances?: Array<{ state?: string }> } };
  assert.equal(recoveryUpdate.payload?.app_server_instances?.[0]?.state, "healthy");
});

test("internal broadcast thread events forwards valid events to browser sockets", async () => {
  const sent: string[] = [];
  const browserSocket = {
    send(message: string) {
      sent.push(message);
    }
  } as unknown as WebSocket;
  const workspace = new WorkspaceDO({
    getWebSockets(tag?: string) {
      assert.equal(tag, "browser");
      return [browserSocket];
    }
  } as unknown as DurableObjectState, {} as Env);

  const response = await workspace.fetch(new Request("https://workspace-do/internal/broadcast-thread-events", {
    method: "POST",
    body: JSON.stringify({
      events: [
        {
          id: "event-1",
          thread_id: "thread-1",
          command_id: "command-1",
          seq: 7,
          kind: "command.failed",
          priority: "P1",
          summary: "Host session detached.",
          created_at: "2026-06-13T10:00:00.000Z"
        },
        { id: "bad-event" }
      ]
    })
  }));
  const body = await response.json() as { broadcasted?: number };

  assert.equal(response.status, 200);
  assert.equal(body.broadcasted, 1);
  assert.equal(sent.length, 1);
  const envelope = JSON.parse(sent[0] ?? "{}") as {
    kind?: string;
    payload?: { event?: { id?: string; summary?: string } };
  };
  assert.equal(envelope.kind, "thread.event");
  assert.equal(envelope.payload?.event?.id, "event-1");
  assert.equal(envelope.payload?.event?.summary, "Host session detached.");
});

test("hasPeerAgentSocket ignores the socket that is closing", () => {
  const closingSocket = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-1",
    agentReady: true
  });
  const peerSocket = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-1",
    agentReady: true
  });
  const ctx = {
    getWebSockets(tag?: string) {
      assert.equal(tag, "agent:connector-1");
      return [closingSocket, peerSocket];
    }
  };

  assert.equal(hasPeerAgentSocket(ctx, "connector-1", closingSocket), true);
  assert.equal(hasPeerAgentSocket(ctx, "connector-1", peerSocket), true);
});

test("hasPeerAgentSocket counts authenticated peers while they are handshaking", () => {
  const closingSocket = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-1",
    agentReady: true
  });
  const notReadyPeer = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-1"
  });
  const ctx = {
    getWebSockets(tag?: string) {
      assert.equal(tag, "agent:connector-1");
      return [closingSocket, notReadyPeer];
    }
  };

  assert.equal(hasPeerAgentSocket(ctx, "connector-1", closingSocket), true);
  assert.equal(hasReadyPeerAgentSocket(ctx, "connector-1", closingSocket), false);
});

test("hasPeerAgentSocket returns false when the closing socket is the only agent socket", () => {
  const closingSocket = {} as WebSocket;
  const ctx = {
    getWebSockets(tag?: string) {
      assert.equal(tag, "agent:connector-1");
      return [closingSocket];
    }
  };

  assert.equal(hasPeerAgentSocket(ctx, "connector-1", closingSocket), false);
  assert.equal(hasReadyPeerAgentSocket(ctx, "connector-1", closingSocket), false);
});

test("hasReadyPeerAgentSocket counts only ready peers", () => {
  const closingSocket = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-1",
    agentReady: true
  });
  const readyPeer = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-1",
    agentReady: true
  });
  const handshakingPeer = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-1"
  });
  const ctx = {
    getWebSockets(tag?: string) {
      assert.equal(tag, "agent:connector-1");
      return [closingSocket, handshakingPeer, readyPeer];
    }
  };

  assert.equal(hasReadyPeerAgentSocket(ctx, "connector-1", closingSocket), true);
});

test("closing ready socket with handshaking peer fails active commands without marking offline", async () => {
  const agentSent: string[] = [];
  const browserSent: string[] = [];
  const closingSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    agentReady: true
  }, agentSent);
  const handshakingPeer = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online"
  });
  const browserSocket = mutableSocketWithAttachment({
    socketType: "browser"
  }, browserSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent:connector-online") return [closingSocket, handshakingPeer];
      if (tag === "browser") return [browserSocket];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = socketGoneDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  await workspace.webSocketMessage(closingSocket, JSON.stringify({
    kind: "agent.app_server_instances",
    payload: {
      instances: [appServerInstancePayload("healthy")]
    }
  }));
  assert.equal(db.appServerInstanceWrites, 1);
  agentSent.length = 0;
  browserSent.length = 0;

  await workspace.webSocketClose(closingSocket);

  assert.equal(db.commandFailures, 1);
  assert.equal(db.taskUpdates, 1);
  assert.equal(db.eventInserts, 1);
  assert.equal(db.activityUpdates, 1);
  assert.equal(db.connectorDegradedUpdates, 1);
  assert.equal(db.connectorOfflineUpdates, 0);
  assert.equal(db.appServerInstanceWrites, 2);
  assert.equal(browserSent.length, 3);
  const envelope = JSON.parse(browserSent[0] ?? "{}") as {
    kind?: string;
    payload?: { event?: { kind?: string; summary?: string } };
  };
  assert.equal(envelope.kind, "thread.event");
  assert.equal(envelope.payload?.event?.kind, "command.failed");
  assert.equal(envelope.payload?.event?.summary, "Connector disconnected before the command completed.");
  const appServerUpdate = JSON.parse(browserSent[1] ?? "{}") as {
    kind?: string;
    payload?: { app_server_instances?: Array<{ state?: string; active_turn_count?: number }> };
  };
  assert.equal(appServerUpdate.kind, "app_server_instances.updated");
  assert.equal(appServerUpdate.payload?.app_server_instances?.[0]?.state, "stopped");
  assert.equal(appServerUpdate.payload?.app_server_instances?.[0]?.active_turn_count, 0);
  const connectorUpdate = JSON.parse(browserSent[2] ?? "{}") as {
    kind?: string;
    payload?: { connectors?: Array<{ id?: string; status?: string; capabilities?: string[]; updated_at?: string }> };
  };
  assert.equal(connectorUpdate.kind, "connectors.updated");
  assert.equal(connectorUpdate.payload?.connectors?.[0]?.id, "connector-online");
  assert.equal(connectorUpdate.payload?.connectors?.[0]?.status, "degraded");
  assert.deepEqual(connectorUpdate.payload?.connectors?.[0]?.capabilities, []);
  assert.match(connectorUpdate.payload?.connectors?.[0]?.updated_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("closing idle ready socket with ready peer does not fail active connector commands", async () => {
  const browserSent: string[] = [];
  const closingSocket = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    agentReady: true
  });
  const readyPeer = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    agentReady: true
  });
  const browserSocket = mutableSocketWithAttachment({
    socketType: "browser"
  }, browserSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent:connector-online") return [closingSocket, readyPeer];
      if (tag === "browser") return [browserSocket];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = socketGoneDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  await workspace.webSocketClose(closingSocket);

  assert.equal(db.commandFailures, 0);
  assert.equal(db.connectorDegradedUpdates, 0);
  assert.equal(db.connectorOfflineUpdates, 0);
  assert.equal(browserSent.length, 0);
});

test("closing ready socket with ready peer fails only commands dispatched to that socket", async () => {
  const browserSent: string[] = [];
  const closingSocket = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    agentReady: true,
    activeCommandIds: ["command-1"]
  });
  const readyPeer = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    agentReady: true
  });
  const browserSocket = mutableSocketWithAttachment({
    socketType: "browser"
  }, browserSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent:connector-online") return [closingSocket, readyPeer];
      if (tag === "browser") return [browserSocket];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = socketGoneDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  await workspace.webSocketClose(closingSocket);

  assert.equal(db.commandFailures, 1);
  assert.equal(db.connectorDegradedUpdates, 0);
  assert.equal(db.connectorOfflineUpdates, 0);
  assert.equal(browserSent.length, 1);
  const envelope = JSON.parse(browserSent[0] ?? "{}") as { kind?: string };
  assert.equal(envelope.kind, "thread.event");
});

test("closing the last authenticated socket broadcasts the offline connector state", async () => {
  const browserSent: string[] = [];
  const closingSocket = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    agentReady: true
  });
  const browserSocket = mutableSocketWithAttachment({
    socketType: "browser"
  }, browserSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent:connector-online") return [closingSocket];
      if (tag === "browser") return [browserSocket];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = socketGoneDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  await workspace.webSocketClose(closingSocket);

  assert.equal(db.commandFailures, 1);
  assert.equal(db.connectorDegradedUpdates, 0);
  assert.equal(db.connectorOfflineUpdates, 1);
  assert.equal(browserSent.length, 2);
  const connectorUpdate = JSON.parse(browserSent[1] ?? "{}") as {
    kind?: string;
    payload?: { connectors?: Array<{ id?: string; status?: string }> };
  };
  assert.equal(connectorUpdate.kind, "connectors.updated");
  assert.equal(connectorUpdate.payload?.connectors?.[0]?.id, "connector-online");
  assert.equal(connectorUpdate.payload?.connectors?.[0]?.status, "offline");
});

test("closing the last authenticated socket clears app-server duplicate cache", async () => {
  const browserSent: string[] = [];
  const agentSent: string[] = [];
  const firstAgentSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    agentReady: true
  }, agentSent);
  const reconnectedAgentSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    agentReady: true
  }, agentSent);
  const browserSocket = mutableSocketWithAttachment({
    socketType: "browser"
  }, browserSent);
  let agentSockets = [firstAgentSocket];
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent:connector-online") return agentSockets;
      if (tag === "browser") return [browserSocket];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = socketGoneDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);
  const message = JSON.stringify({
    kind: "agent.app_server_instances",
    payload: {
      instances: [appServerInstancePayload("healthy")]
    }
  });

  await workspace.webSocketMessage(firstAgentSocket, message);
  assert.equal(db.appServerInstanceWrites, 1);
  await workspace.webSocketClose(firstAgentSocket);
  assert.equal(db.appServerInstanceWrites, 2);
  agentSockets = [reconnectedAgentSocket];
  await workspace.webSocketMessage(reconnectedAgentSocket, message);

  assert.equal(db.appServerInstanceWrites, 3);
  const reconnectAck = JSON.parse(agentSent[1] ?? "{}") as { payload?: { deduped?: boolean } };
  assert.equal(reconnectAck.payload?.deduped, false);
});

test("agentSocketsForConnector prefers the newest ready agent socket", () => {
  const oldSocket = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-1",
    connectedAt: 100,
    agentReady: true
  });
  const freshSocket = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-1",
    connectedAt: 300,
    agentReady: true
  });
  const notReadySocket = socketWithAttachment({
    socketType: "agent",
    connectorId: "connector-1",
    connectedAt: 400
  });
  const ctx = {
    getWebSockets(tag?: string) {
      assert.equal(tag, "agent:connector-1");
      return [oldSocket, notReadySocket, freshSocket];
    }
  };

  assert.deepEqual(agentSocketsForConnector(ctx, "connector-1"), [freshSocket, oldSocket]);
});

test("agent sockets wait for ready capabilities before pending command dispatch", async () => {
  const sent: string[] = [];
  const browserSent: string[] = [];
  const agentSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 300
  }, sent);
  const browserSocket = mutableSocketWithAttachment({
    socketType: "browser"
  }, browserSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent:connector-online") return [agentSocket];
      if (tag === "browser") return [browserSocket];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = readyGatedDispatchDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  const beforeReady = await workspace.fetch(new Request("https://workspace-do/internal/dispatch-pending", {
    method: "POST",
    body: JSON.stringify({ connector_id: "connector-online" })
  }));
  assert.equal((await beforeReady.json() as { dispatched_to?: number }).dispatched_to, 0);
  assert.equal(db.pendingDispatchQueries, 0);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.ready",
    payload: { capabilities: ["placeholder_commands"] }
  }));

  assert.equal(db.capabilityUpdates, 1);
  assert.equal(db.pendingDispatchQueries, 0);
  assert.equal(sent.length, 1);
  assert.equal(browserSent.length, 1);
  const ack = JSON.parse(sent[0] ?? "{}") as {
    kind?: string;
    payload?: { kind?: string; capabilities?: string[] };
  };
  assert.equal(ack.kind, "server.ack");
  assert.equal(ack.payload?.kind, "agent.ready");
  assert.deepEqual(ack.payload?.capabilities, ["placeholder_commands"]);
  const connectorUpdate = JSON.parse(browserSent[0] ?? "{}") as {
    kind?: string;
    payload?: { connectors?: Array<{ id?: string; capabilities?: string[] }> };
  };
  assert.equal(connectorUpdate.kind, "connectors.updated");
  assert.equal(connectorUpdate.payload?.connectors?.[0]?.id, "connector-online");
  assert.deepEqual(connectorUpdate.payload?.connectors?.[0]?.capabilities, ["placeholder_commands"]);

  const afterReady = await workspace.fetch(new Request("https://workspace-do/internal/dispatch-pending", {
    method: "POST",
    body: JSON.stringify({ connector_id: "connector-online" })
  }));
  assert.equal((await afterReady.json() as { dispatched_to?: number }).dispatched_to, 0);
  assert.equal(db.pendingDispatchQueries, 0);
  assert.equal(sent.length, 1);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.ready",
    payload: { capabilities: ["placeholder_commands"] }
  }));

  assert.equal(db.capabilityUpdates, 1);
  assert.equal(db.pendingDispatchQueries, 0);
  assert.equal(sent.length, 2);
  assert.equal(browserSent.length, 1);
  const duplicateAck = JSON.parse(sent[1] ?? "{}") as {
    kind?: string;
    payload?: { kind?: string; capabilities?: string[] };
  };
  assert.equal(duplicateAck.kind, "server.ack");
  assert.equal(duplicateAck.payload?.kind, "agent.ready");
  assert.deepEqual(duplicateAck.payload?.capabilities, ["placeholder_commands"]);

  const replacementSent: string[] = [];
  const replacementSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 400
  }, replacementSent);
  await workspace.webSocketMessage(replacementSocket, JSON.stringify({
    kind: "agent.ready",
    payload: { capabilities: ["placeholder_commands"] }
  }));

  assert.equal(db.capabilityUpdates, 1);
  assert.equal(replacementSent.length, 1);
  assert.equal(browserSent.length, 2);
  const replacementUpdate = JSON.parse(browserSent[1] ?? "{}") as {
    kind?: string;
    payload?: { connectors?: Array<{ id?: string; status?: string; capabilities?: string[] }> };
  };
  assert.equal(replacementUpdate.kind, "connectors.updated");
  assert.equal(replacementUpdate.payload?.connectors?.[0]?.id, "connector-online");
  assert.equal(replacementUpdate.payload?.connectors?.[0]?.status, "online");
  assert.deepEqual(replacementUpdate.payload?.connectors?.[0]?.capabilities, ["placeholder_commands"]);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.host_sessions",
    payload: {
      sessions: [
        {
          session_id: "session-1",
          title: "Thread One",
          title_source: "metadata",
          app_server_present: true,
          cwd: "/workspace/project",
          updated_at: "2026-06-13T10:00:00.000Z"
        }
      ],
      inventory_scope: "incremental",
      app_server_inventory_ok: true
    }
  }));

  assert.equal(db.pendingDispatchQueries, 1);
  assert.equal(sent.length, 3);
  const hostSessionsAck = JSON.parse(sent[2] ?? "{}") as {
    kind?: string;
    payload?: { kind?: string; count?: number };
  };
  assert.equal(hostSessionsAck.kind, "server.ack");
  assert.equal(hostSessionsAck.payload?.kind, "agent.host_sessions");
  assert.equal(hostSessionsAck.payload?.count, 1);

  const afterHostSessions = await workspace.fetch(new Request("https://workspace-do/internal/dispatch-pending", {
    method: "POST",
    body: JSON.stringify({ connector_id: "connector-online" })
  }));
  assert.equal((await afterHostSessions.json() as { dispatched_to?: number }).dispatched_to, 1);
  assert.equal(db.pendingDispatchQueries, 2);
  assert.equal(sent.length, 3);
});

test("agent.ready restores degraded connector state before broadcasting recovery", async () => {
  const sent: string[] = [];
  const browserSent: string[] = [];
  const agentSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 500
  }, sent);
  const browserSocket = mutableSocketWithAttachment({
    socketType: "browser"
  }, browserSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent:connector-online") return [agentSocket];
      if (tag === "browser") return [browserSocket];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = readyGatedDispatchDb({
    initialCapabilities: ["placeholder_commands"],
    initialStatus: "degraded",
    initialUpdatedAt: "2026-06-13T10:00:00.000Z"
  });
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.ready",
    payload: { capabilities: ["placeholder_commands"] }
  }));

  assert.equal(db.capabilityUpdates, 1);
  assert.equal(browserSent.length, 1);
  const connectorUpdate = JSON.parse(browserSent[0] ?? "{}") as {
    kind?: string;
    payload?: { connectors?: Array<{ id?: string; status?: string; updated_at?: string }> };
  };
  assert.equal(connectorUpdate.kind, "connectors.updated");
  assert.equal(connectorUpdate.payload?.connectors?.[0]?.id, "connector-online");
  assert.equal(connectorUpdate.payload?.connectors?.[0]?.status, "online");
  assert.notEqual(connectorUpdate.payload?.connectors?.[0]?.updated_at, "2026-06-13T10:00:00.000Z");
});

test("dispatch-pending cleans stale app-server targets before ready sockets", async () => {
  const sent: string[] = [];
  const agentSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 300
  }, sent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent:connector-online") return [agentSocket];
      if (tag === "browser") return [];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = readyGatedDispatchDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  const response = await workspace.fetch(new Request("https://workspace-do/internal/dispatch-pending", {
    method: "POST",
    body: JSON.stringify({ connector_id: "connector-online" })
  }));

  assert.equal((await response.json() as { dispatched_to?: number }).dispatched_to, 0);
  assert.equal(db.staleExplicitCleanupQueries, 1);
  assert.equal(db.pendingDispatchQueries, 0);
  assert.equal(sent.length, 0);
});

test("dispatch-pending releases and retries when socket send fails", async () => {
  const throwingSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 400,
    agentReady: true
  }, []);
  throwingSocket.send = () => {
    throw new Error("socket send failed");
  };
  const peerSent: string[] = [];
  const readyPeer = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 300,
    agentReady: true
  }, peerSent);
  const browserSent: string[] = [];
  const browserSocket = mutableSocketWithAttachment({
    socketType: "browser"
  }, browserSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent:connector-online") return [throwingSocket, readyPeer];
      if (tag === "browser") return [browserSocket];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = readyGatedDispatchDb({
    initialCapabilities: ["placeholder_commands"],
    pendingCommand: true
  });
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  const response = await workspace.fetch(new Request("https://workspace-do/internal/dispatch-pending", {
    method: "POST",
    body: JSON.stringify({ connector_id: "connector-online" })
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(throwingSocket.deserializeAttachment(), {
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 400,
    agentReady: false,
    pendingHostSessionsDispatch: false,
    activeCommandIds: []
  });
  assert.deepEqual(
    (readyPeer.deserializeAttachment() as { activeCommandIds?: string[] }).activeCommandIds,
    ["command-1"]
  );
  assert.equal(peerSent.length, 1);
  const dispatch = JSON.parse(peerSent[0] ?? "{}") as { kind?: string };
  assert.equal(dispatch.kind, "command.dispatch");
  assert.equal(db.commandFailures, 0);
  assert.equal(db.commandReleases, 1);
  assert.equal(db.commandLeases, 2);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
  assert.equal(db.activityUpdates, 3);
  assert.equal(browserSent.length, 0);
});

test("dispatch-pending defers stale cleanup while host-session refresh is pending", async () => {
  const sent: string[] = [];
  const agentSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 300,
    agentReady: true,
    pendingHostSessionsDispatch: true
  }, sent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent:connector-online") return [agentSocket];
      if (tag === "browser") return [];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = readyGatedDispatchDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  const response = await workspace.fetch(new Request("https://workspace-do/internal/dispatch-pending", {
    method: "POST",
    body: JSON.stringify({ connector_id: "connector-online" })
  }));

  assert.equal((await response.json() as { dispatched_to?: number }).dispatched_to, 0);
  assert.equal(db.staleExplicitCleanupQueries, 0);
  assert.equal(db.pendingDispatchQueries, 0);
  assert.equal(sent.length, 0);
});

test("dispatch-pending dispatches released attached commands to replacement connectors", async () => {
  const staleSent: string[] = [];
  const replacementSent: string[] = [];
  const staleSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 300
  }, staleSent);
  const replacementSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-replacement",
    connectedAt: 400,
    agentReady: true
  }, replacementSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent:connector-online") return [staleSocket];
      if (tag === "agent:connector-replacement") return [replacementSocket];
      if (tag === "browser") return [];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = staleReleaseDispatchDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  const response = await workspace.fetch(new Request("https://workspace-do/internal/dispatch-pending", {
    method: "POST",
    body: JSON.stringify({ connector_id: "connector-online" })
  }));

  assert.equal((await response.json() as { dispatched_to?: number }).dispatched_to, 1);
  assert.equal(db.staleExplicitCleanupQueries, 1);
  assert.equal(db.commandReleases, 1);
  assert.equal(db.pendingDispatchQueries, 1);
  assert.equal(db.commandLeases, 1);
  assert.equal(staleSent.length, 0);
  assert.equal(replacementSent.length, 1);
  const dispatched = JSON.parse(replacementSent[0] ?? "{}") as {
    kind?: string;
    payload?: { command?: { id?: string }; target_host_session?: { session_id?: string } };
  };
  assert.equal(dispatched.kind, "command.dispatch");
  assert.equal(dispatched.payload?.command?.id, "command-1");
  assert.equal(dispatched.payload?.target_host_session?.session_id, "session-new");
});

test("global dispatch-pending cleans stale app-server targets before ready sockets", async () => {
  const sent: string[] = [];
  const firstSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 300
  }, sent);
  const secondSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 350
  }, sent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent") return [firstSocket, secondSocket];
      if (tag === "browser") return [];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = readyGatedDispatchDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  const response = await workspace.fetch(new Request("https://workspace-do/internal/dispatch-pending", {
    method: "POST",
    body: JSON.stringify({})
  }));

  assert.equal((await response.json() as { dispatched_to?: number }).dispatched_to, 0);
  assert.equal(db.staleExplicitCleanupQueries, 1);
  assert.equal(db.pendingDispatchQueries, 0);
  assert.equal(sent.length, 0);
});

test("global dispatch-pending defers connector while host-session refresh is pending", async () => {
  const sent: string[] = [];
  const readySocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 300,
    agentReady: true
  }, sent);
  const refreshingSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 350,
    agentReady: true,
    pendingHostSessionsDispatch: true
  }, sent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent") return [readySocket, refreshingSocket];
      if (tag === "browser") return [];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = readyGatedDispatchDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  const response = await workspace.fetch(new Request("https://workspace-do/internal/dispatch-pending", {
    method: "POST",
    body: JSON.stringify({})
  }));

  assert.equal((await response.json() as { dispatched_to?: number }).dispatched_to, 0);
  assert.equal(db.staleExplicitCleanupQueries, 0);
  assert.equal(db.pendingDispatchQueries, 0);
  assert.equal(sent.length, 0);
});

test("legacy agent.ready without capabilities remains dispatch-ready", async () => {
  const sent: string[] = [];
  const browserSent: string[] = [];
  const agentSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-online",
    connectedAt: 300
  }, sent);
  const browserSocket = mutableSocketWithAttachment({
    socketType: "browser"
  }, browserSent);
  const ctx = {
    getWebSockets(tag?: string) {
      if (tag === "agent:connector-online") return [agentSocket];
      if (tag === "browser") return [browserSocket];
      assert.fail(`unexpected websocket tag: ${tag}`);
    }
  } as unknown as DurableObjectState;
  const db = readyGatedDispatchDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({ kind: "agent.ready" }));

  assert.equal(db.capabilityUpdates, 0);
  assert.equal(db.connectorOnlineUpdates, 1);
  assert.equal(db.pendingDispatchQueries, 1);
  assert.equal(sent.length, 1);
  assert.equal(browserSent.length, 1);
  const ack = JSON.parse(sent[0] ?? "{}") as {
    kind?: string;
    payload?: { kind?: string; capabilities?: string[] };
  };
  assert.equal(ack.kind, "server.ack");
  assert.equal(ack.payload?.kind, "agent.ready");
  assert.deepEqual(ack.payload?.capabilities, []);
  const connectorUpdate = JSON.parse(browserSent[0] ?? "{}") as {
    kind?: string;
    payload?: { connectors?: Array<{ id?: string; status?: string }> };
  };
  assert.equal(connectorUpdate.kind, "connectors.updated");
  assert.equal(connectorUpdate.payload?.connectors?.[0]?.id, "connector-online");
  assert.equal(connectorUpdate.payload?.connectors?.[0]?.status, "online");

  const afterReady = await workspace.fetch(new Request("https://workspace-do/internal/dispatch-pending", {
    method: "POST",
    body: JSON.stringify({ connector_id: "connector-online" })
  }));
  assert.equal((await afterReady.json() as { dispatched_to?: number }).dispatched_to, 1);
  assert.equal(db.connectorOnlineUpdates, 1);
  assert.equal(db.pendingDispatchQueries, 2);
});

test("sync thread archive dispatches to the selected agent socket and resolves the result", async () => {
  const sent: string[] = [];
  const agentSocket = {
    send(message: string) {
      sent.push(message);
    },
    deserializeAttachment() {
      return { socketType: "agent", connectorId: "connector-online", connectedAt: 300, agentReady: true };
    }
  } as unknown as WebSocket;
  const ctx = {
    getWebSockets(tag?: string) {
      assert.equal(tag, "agent:connector-online");
      return [agentSocket];
    }
  } as unknown as DurableObjectState;
  const workspace = new WorkspaceDO(ctx, {} as Env);

  const responsePromise = workspace.fetch(new Request("https://workspace-do/internal/sync-thread-archive", {
    method: "POST",
    body: JSON.stringify({
      connector_id: "connector-online",
      request_id: "archive-1",
      session_id: "session-1",
      archived: true
    })
  }));

  await waitFor(() => sent.length === 1);
  assert.equal(sent.length, 1);
  const dispatch = JSON.parse(sent[0] ?? "{}") as {
    kind?: string;
    payload?: { request_id?: string; session_id?: string; archived?: boolean };
    target?: { type?: string; id?: string };
  };
  assert.equal(dispatch.kind, "thread.archive_sync");
  assert.equal(dispatch.payload?.request_id, "archive-1");
  assert.equal(dispatch.payload?.session_id, "session-1");
  assert.equal(dispatch.payload?.archived, true);
  assert.deepEqual(dispatch.target, { type: "connector", id: "connector-online" });

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "thread.archive_sync_result",
    payload: { request_id: "archive-1", ok: true, synced: true }
  }));

  const response = await responsePromise;
  const body = await response.json() as { ok?: boolean; synced?: boolean };
  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true, synced: true });

  assert.equal(sent.length, 2);
  const ack = JSON.parse(sent[1] ?? "{}") as {
    kind?: string;
    payload?: { kind?: string; request_id?: string };
  };
  assert.equal(ack.kind, "server.ack");
  assert.deepEqual(ack.payload, { kind: "thread.archive_sync_result", request_id: "archive-1" });
});

test("agent event ack rejects stale command events", async () => {
  const sent: string[] = [];
  const agentSocket = {
    send(message: string) {
      sent.push(message);
    },
    deserializeAttachment() {
      return { socketType: "agent", connectorId: "connector-online", connectedAt: 300, agentReady: true };
    }
  } as unknown as WebSocket;
  const workspace = new WorkspaceDO({} as DurableObjectState, { DB: staleCommandEventDb() } as Env);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.event",
    payload: {
      command_id: "command-1",
      kind: "command.started",
      priority: "P1",
      summary: "Starting"
    }
  }));

  assert.equal(sent.length, 1);
  const ack = JSON.parse(sent[0] ?? "{}") as {
    kind?: string;
    payload?: { command_id?: string; kind?: string; accepted?: boolean };
  };
  assert.equal(ack.kind, "server.ack");
  assert.deepEqual(ack.payload, {
    command_id: "command-1",
    kind: "command.started",
    accepted: false
  });
});

test("rejected stale final command events still poll pending work for the connector", async () => {
  const sent: string[] = [];
  const agentSocket = {
    send(message: string) {
      sent.push(message);
    },
    deserializeAttachment() {
      return { socketType: "agent", connectorId: "connector-online", connectedAt: 300, agentReady: true };
    }
  } as unknown as WebSocket;
  const db = staleFinalCommandEventDb();
  const workspace = new WorkspaceDO({} as DurableObjectState, { DB: db } as Env);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.event",
    payload: {
      command_id: "command-1",
      kind: "command.failed",
      priority: "P1",
      summary: "Finished after stale lease"
    }
  }));

  assert.equal(sent.length, 1);
  const ack = JSON.parse(sent[0] ?? "{}") as {
    kind?: string;
    payload?: { command_id?: string; kind?: string; accepted?: boolean };
  };
  assert.equal(ack.kind, "server.ack");
  assert.deepEqual(ack.payload, {
    command_id: "command-1",
    kind: "command.failed",
    accepted: false
  });
  assert.equal(db.pendingDispatchQueries, 1);
});

test("rejected starts with generated final events still poll pending work for the connector", async () => {
  const sent: string[] = [];
  const agentSocket = {
    send(message: string) {
      sent.push(message);
    },
    deserializeAttachment() {
      return { socketType: "agent", connectorId: "connector-online", connectedAt: 300, agentReady: true };
    }
  } as unknown as WebSocket;
  const db = rejectedStartedEventWithFailedResultDb();
  const workspace = new WorkspaceDO({
    getWebSockets(tag?: string) {
      assert.equal(tag, "browser");
      return [];
    }
  } as unknown as DurableObjectState, { DB: db } as Env);

  await workspace.webSocketMessage(agentSocket, JSON.stringify({
    kind: "agent.event",
    payload: {
      command_id: "command-1",
      kind: "command.started",
      priority: "P1",
      summary: "Starting stale explicit target"
    }
  }));

  assert.equal(sent.length, 1);
  const ack = JSON.parse(sent[0] ?? "{}") as {
    kind?: string;
    payload?: { command_id?: string; kind?: string; accepted?: boolean };
  };
  assert.equal(ack.kind, "server.ack");
  assert.deepEqual(ack.payload, {
    command_id: "command-1",
    kind: "command.started",
    accepted: false
  });
  assert.equal(db.explicitFailures, 1);
  assert.equal(db.pendingDispatchQueries, 1);
});

test("rejected targeted app-server starts trigger pending dispatch to available agents", async () => {
  const staleSent: string[] = [];
  const replacementSent: string[] = [];
  const staleSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-stale",
    connectedAt: 100,
    agentReady: true,
    activeCommandIds: ["command-1"]
  }, staleSent);
  const replacementSocket = mutableSocketWithAttachment({
    socketType: "agent",
    connectorId: "connector-replacement",
    connectedAt: 200,
    agentReady: true
  }, replacementSent);
  const ctx = {
    getWebSockets(tag?: string) {
      assert.equal(tag, "agent");
      return [staleSocket, replacementSocket];
    }
  } as unknown as DurableObjectState;
  const db = rejectedTargetedStartDispatchDb();
  const workspace = new WorkspaceDO(ctx, { DB: db } as Env);

  await workspace.webSocketMessage(staleSocket, JSON.stringify({
    kind: "agent.event",
    payload: {
      command_id: "command-1",
      target_host_session_id: "session-old",
      kind: "command.started",
      priority: "P1",
      summary: "Starting stale target"
    }
  }));

  assert.equal(staleSent.length, 1);
  const ack = JSON.parse(staleSent[0] ?? "{}") as {
    kind?: string;
    payload?: { command_id?: string; kind?: string; accepted?: boolean };
  };
  assert.equal(ack.kind, "server.ack");
  assert.deepEqual(ack.payload, {
    command_id: "command-1",
    kind: "command.started",
    accepted: false
  });
  assert.equal(replacementSent.length, 1);
  const dispatch = JSON.parse(replacementSent[0] ?? "{}") as {
    kind?: string;
    payload?: { command?: { id?: string }; target_host_session?: { session_id?: string } };
    target?: { type?: string; id?: string };
  };
  assert.equal(dispatch.kind, "command.dispatch");
  assert.equal(dispatch.payload?.command?.id, "command-1");
  assert.equal(dispatch.payload?.target_host_session?.session_id, "session-new");
  assert.deepEqual(dispatch.target, { type: "connector", id: "connector-replacement" });
  assert.deepEqual(
    (staleSocket.deserializeAttachment() as { activeCommandIds?: string[] }).activeCommandIds,
    []
  );
  assert.deepEqual(
    (replacementSocket.deserializeAttachment() as { activeCommandIds?: string[] }).activeCommandIds,
    ["command-1"]
  );
  assert.equal(db.leaseReleases, 1);
  assert.equal(db.commandLeases, 1);
});

function staleCommandEventDb(): D1Database {
  return {
    prepare(sql: string) {
      if (/SELECT id, workspace_id, thread_id, task_id, type, target_connector_id, target_connector_id_source,\s+lease_owner_connector_id, state/.test(sql)) {
        return {
          bind(commandId: string) {
            assert.equal(commandId, "command-1");
            return {
              async first() {
                return {
                  id: "command-1",
                  workspace_id: "workspace-api",
                  thread_id: "thread-1",
                  task_id: "task-1",
                  type: "codex",
                  target_connector_id: "connector-online",
                  target_connector_id_source: "auto",
                  lease_owner_connector_id: null,
                  state: "failed"
                };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    }
  } as D1Database;
}

function staleFinalCommandEventDb(): D1Database & { readonly pendingDispatchQueries: number } {
  const counters = { pendingDispatchQueries: 0 };
  return {
    prepare(sql: string) {
      if (/SELECT id, workspace_id, thread_id, task_id, type, target_connector_id, target_connector_id_source,\s+lease_owner_connector_id, state/.test(sql)) {
        return {
          bind(commandId: string) {
            assert.equal(commandId, "command-1");
            return {
              async first() {
                return {
                  id: "command-1",
                  workspace_id: "workspace-api",
                  thread_id: "thread-1",
                  task_id: "task-1",
                  type: "codex",
                  target_connector_id: null,
                  target_connector_id_source: "auto",
                  lease_owner_connector_id: "connector-online",
                  state: "failed",
                  lease_target_host_session_id: null
                };
              }
            };
          }
        };
      }

      if (/FROM commands cmd/.test(sql) && /cmd\.lease_target_host_session_id IS NOT NULL/.test(sql)) {
        return {
          bind(
            targetConnectorId: string,
            scopeConnectorId: string,
            leaseOwnerConnectorId: string,
            now: string,
            currentTargetConnectorId: string
          ) {
            assert.equal(targetConnectorId, "connector-online");
            assert.equal(scopeConnectorId, "connector-online");
            assert.equal(leaseOwnerConnectorId, "connector-online");
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(currentTargetConnectorId, "connector-online");
            return {
              async all() {
                return { results: [] };
              }
            };
          }
        };
      }

      if (/FROM commands cmd/.test(sql) && /LEFT JOIN host_sessions hs/.test(sql)) {
        return {
          bind(
            now: string,
            targetConnectorId: string,
            autoAttachmentConnectorId: string,
            hostSessionConnectorId: string,
            executableConnectorId: string
          ) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(targetConnectorId, "connector-online");
            assert.equal(autoAttachmentConnectorId, "connector-online");
            assert.equal(hostSessionConnectorId, "connector-online");
            assert.equal(executableConnectorId, "connector-online");
            return {
              async all() {
                counters.pendingDispatchQueries += 1;
                return { results: [] };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get pendingDispatchQueries() {
      return counters.pendingDispatchQueries;
    }
  } as D1Database & { readonly pendingDispatchQueries: number };
}

function rejectedStartedEventWithFailedResultDb(): D1Database & {
  readonly explicitFailures: number;
  readonly pendingDispatchQueries: number;
} {
  const counters = {
    explicitFailures: 0,
    pendingDispatchQueries: 0
  };
  return {
    prepare(sql: string) {
      if (/SELECT id, workspace_id, thread_id, task_id, type, target_connector_id, target_connector_id_source,\s+lease_owner_connector_id, state/.test(sql)) {
        return {
          bind(commandId: string) {
            assert.equal(commandId, "command-1");
            return {
              async first() {
                return {
                  id: "command-1",
                  workspace_id: "workspace-api",
                  thread_id: "thread-1",
                  task_id: "task-1",
                  type: "codex",
                  target_connector_id: "connector-online",
                  target_connector_id_source: "explicit",
                  lease_owner_connector_id: "connector-online",
                  state: "leased",
                  lease_target_host_session_id: "session-old"
                };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /SET state = 'pending'/.test(sql)) {
        return {
          bind() {
            return {
              async run() {
                return { meta: { changes: 0 } };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /SET state = 'failed'/.test(sql)) {
        return {
          bind(now: string, commandId: string, connectorId: string, sessionId: string) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(connectorId, "connector-online");
            assert.equal(sessionId, "session-old");
            return {
              async run() {
                counters.explicitFailures += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/UPDATE tasks/.test(sql)) {
        return {
          bind(now: string, taskId: string) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(taskId, "task-1");
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE threads/.test(sql) && /RETURNING last_seq/.test(sql)) {
        return {
          bind(now: string, threadId: string) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(threadId, "thread-1");
            return {
              async first() {
                return { last_seq: 8 };
              }
            };
          }
        };
      }

      if (/INSERT INTO events/.test(sql)) {
        return {
          bind() {
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      if (/INSERT INTO usage_windows/.test(sql)) {
        return usageWindowUpsertFake();
      }

      if (/SELECT COUNT\(\*\) AS active_count/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return { active_count: 0 };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql)) {
        return {
          bind(activeCount: number, now: string, connectorId: string) {
            assert.equal(activeCount, 0);
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      if (/FROM commands cmd/.test(sql) && /cmd\.lease_target_host_session_id IS NOT NULL/.test(sql)) {
        return {
          bind(
            targetConnectorId: string,
            scopeConnectorId: string,
            leaseOwnerConnectorId: string,
            now: string,
            currentTargetConnectorId: string
          ) {
            assert.equal(targetConnectorId, "connector-online");
            assert.equal(scopeConnectorId, "connector-online");
            assert.equal(leaseOwnerConnectorId, "connector-online");
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(currentTargetConnectorId, "connector-online");
            return {
              async all() {
                return { results: [] };
              }
            };
          }
        };
      }

      if (/FROM commands cmd/.test(sql) && /LEFT JOIN host_sessions hs/.test(sql)) {
        return {
          bind(
            now: string,
            targetConnectorId: string,
            autoAttachmentConnectorId: string,
            hostSessionConnectorId: string,
            executableConnectorId: string
          ) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(targetConnectorId, "connector-online");
            assert.equal(autoAttachmentConnectorId, "connector-online");
            assert.equal(hostSessionConnectorId, "connector-online");
            assert.equal(executableConnectorId, "connector-online");
            return {
              async all() {
                counters.pendingDispatchQueries += 1;
                return { results: [] };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get explicitFailures() {
      return counters.explicitFailures;
    },
    get pendingDispatchQueries() {
      return counters.pendingDispatchQueries;
    }
  } as D1Database & { readonly explicitFailures: number; readonly pendingDispatchQueries: number };
}

function rejectedTargetedStartDispatchDb(): D1Database & {
  readonly leaseReleases: number;
  readonly commandLeases: number;
} {
  const counters = {
    leaseReleases: 0,
    commandLeases: 0
  };
  return {
    prepare(sql: string) {
      if (/SELECT id, workspace_id, thread_id, task_id, type, target_connector_id, target_connector_id_source,\s+lease_owner_connector_id, state/.test(sql)) {
        return {
          bind(commandId: string) {
            assert.equal(commandId, "command-1");
            return {
              async first() {
                return {
                  id: "command-1",
                  workspace_id: "workspace-api",
                  thread_id: "thread-1",
                  task_id: "task-1",
                  type: "codex",
                  target_connector_id: null,
                  target_connector_id_source: "attached",
                  lease_owner_connector_id: "connector-stale",
                  state: "leased",
                  lease_target_host_session_id: "session-old"
                };
              }
            };
          }
        };
      }

      if (
        /UPDATE commands/.test(sql) &&
        /EXISTS \(\s+SELECT 1\s+FROM host_sessions hs/.test(sql) &&
        !/SET state = 'leased'/.test(sql) &&
        !/SET state = 'pending'/.test(sql)
      ) {
        return {
          bind() {
            return {
              async run() {
                return { meta: { changes: 0 } };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /SET state = 'pending'/.test(sql)) {
        assert.match(sql, /target_connector_id = CASE WHEN \? THEN NULL ELSE target_connector_id END/);
        assert.match(sql, /target_connector_id_source = CASE WHEN \? THEN 'auto' ELSE target_connector_id_source END/);
        assert.match(sql, /lease_target_host_session_id = \?/);
        assert.match(sql, /EXISTS \(\s+SELECT 1\s+FROM host_sessions hs/);
        assert.match(sql, /hs\.session_id <> \?/);
        assert.match(sql, /\? OR commands\.target_connector_id IS NULL OR hs\.connector_id = commands\.target_connector_id/);
        return {
          bind(
            clearTargetConnectorId: number,
            clearTargetConnectorIdSource: number,
            updatedAt: string,
            commandId: string,
            connectorId: string,
            targetHostSessionId: string,
            replacementExcludedConnectorId: string,
            replacementExcludedSessionId: string,
            replacementCanIgnoreOldTarget: number
          ) {
            assert.equal(clearTargetConnectorId, 1);
            assert.equal(clearTargetConnectorIdSource, 1);
            assert.equal(replacementCanIgnoreOldTarget, 1);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(connectorId, "connector-stale");
            assert.equal(targetHostSessionId, "session-old");
            assert.equal(replacementExcludedConnectorId, "connector-stale");
            assert.equal(replacementExcludedSessionId, "session-old");
            return {
              async run() {
                counters.leaseReleases += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/FROM commands cmd/.test(sql) && /cmd\.lease_target_host_session_id IS NOT NULL/.test(sql)) {
        return {
          bind(
            targetConnectorId: string,
            scopeConnectorId: string,
            leaseOwnerConnectorId: string,
            now: string,
            currentTargetConnectorId: string
          ) {
            assert.equal(scopeConnectorId, targetConnectorId);
            assert.equal(targetConnectorId, leaseOwnerConnectorId);
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(currentTargetConnectorId, targetConnectorId);
            return {
              async all() {
                return { results: [] };
              }
            };
          }
        };
      }

      if (/FROM commands cmd/.test(sql) && /LEFT JOIN host_sessions hs/.test(sql)) {
        return {
          bind(
            now: string,
            targetConnectorId: string,
            autoAttachmentConnectorId: string,
            hostSessionConnectorId: string,
            executableConnectorId: string
          ) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(targetConnectorId, autoAttachmentConnectorId);
            assert.equal(autoAttachmentConnectorId, hostSessionConnectorId);
            assert.equal(hostSessionConnectorId, executableConnectorId);
            return {
              async all() {
                if (targetConnectorId !== "connector-replacement") {
                  return { results: [] };
                }
                return {
                  results: [
                    {
                      id: "command-1",
                      workspace_id: "workspace-api",
                      thread_id: "thread-1",
                      task_id: "task-1",
                      type: "codex",
                      prompt: "Continue on the replacement session",
                      state: "pending",
                      target_connector_id: null,
                      target_connector_id_source: "auto",
                      created_at: "2026-06-13T10:00:00.000Z",
                      updated_at: "2026-06-13T10:00:00.000Z",
                      target_host_session_row_id: "host-session-new",
                      target_host_session_id: "session-new",
                      target_host_session_app_server_present: 1,
                      target_host_session_cwd: "/workspace/project"
                    }
                  ]
                };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /SET state = 'leased'/.test(sql)) {
        return {
          bind(
            targetHostSessionIdForTarget: string | null,
            targetHostSessionIsAppServerForTarget: number,
            retargetConnectorId: string,
            targetHostSessionIdForSource: string | null,
            targetHostSessionIsAppServerForSource: number,
            connectorId: string,
            leaseUntil: string,
            leaseTargetHostSessionId: string,
            updatedAt: string,
            commandId: string,
            now: string,
            selectedHostSessionIdForNullGuard: string | null,
            selectedHostSessionIdForPresentGuard: string | null,
            selectedHostSessionIdForMatchGuard: string | null,
            targetHostSessionIdForStoredLeaseGuard: string | null,
            targetConnectorId: string,
            targetHostSessionIdForAutoTargetGuard: string | null,
            autoTargetConnectorId: string,
            targetHostSessionIdForCapabilityGuard: string | null,
            capabilityConnectorId: string,
            capabilityHostSessionConnectorId: string
          ) {
            assert.equal(targetHostSessionIdForTarget, "session-new");
            assert.equal(targetHostSessionIsAppServerForTarget, 1);
            assert.equal(retargetConnectorId, "connector-replacement");
            assert.equal(targetHostSessionIdForSource, "session-new");
            assert.equal(targetHostSessionIsAppServerForSource, 1);
            assert.equal(connectorId, "connector-replacement");
            assert.match(leaseUntil, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(leaseTargetHostSessionId, "session-new");
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(selectedHostSessionIdForNullGuard, "host-session-new");
            assert.equal(selectedHostSessionIdForPresentGuard, "host-session-new");
            assert.equal(selectedHostSessionIdForMatchGuard, "host-session-new");
            assert.equal(targetHostSessionIdForStoredLeaseGuard, "host-session-new");
            assert.equal(targetConnectorId, "connector-replacement");
            assert.equal(targetHostSessionIdForAutoTargetGuard, "host-session-new");
            assert.equal(autoTargetConnectorId, "connector-replacement");
            assert.equal(targetHostSessionIdForCapabilityGuard, "host-session-new");
            assert.equal(capabilityConnectorId, "connector-replacement");
            assert.equal(capabilityHostSessionConnectorId, "connector-replacement");
            return {
              async run() {
                counters.commandLeases += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/SELECT COUNT\(\*\) AS active_count/.test(sql)) {
        return {
          bind(connectorId: string) {
            return {
              async first() {
                return { active_count: connectorId === "connector-replacement" ? 1 : 0 };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /active_command_count/.test(sql)) {
        return {
          bind(activeCount: number, updatedAt: string, connectorId: string) {
            assert.equal(activeCount, connectorId === "connector-replacement" ? 1 : 0);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get leaseReleases() {
      return counters.leaseReleases;
    },
    get commandLeases() {
      return counters.commandLeases;
    }
  } as D1Database & typeof counters;
}

function socketWithAttachment(attachment: unknown): WebSocket {
  let currentAttachment = attachment;
  return {
    deserializeAttachment() {
      return currentAttachment;
    },
    serializeAttachment(nextAttachment: unknown) {
      currentAttachment = nextAttachment;
    }
  } as unknown as WebSocket;
}

function socketGoneDb(): D1Database & {
  readonly commandFailures: number;
  readonly taskUpdates: number;
  readonly eventInserts: number;
  readonly activityUpdates: number;
  readonly connectorDegradedUpdates: number;
  readonly connectorOfflineUpdates: number;
  readonly appServerInstanceWrites: number;
} {
  const appServerRows = new Map<string, AppServerInstanceDoRow>();
  const counters = {
    commandFailures: 0,
    taskUpdates: 0,
    eventInserts: 0,
    activityUpdates: 0,
    connectorDegradedUpdates: 0,
    connectorOfflineUpdates: 0,
    appServerInstanceWrites: 0
  };
  return {
    prepare(sql: string) {
      if (/SELECT id\s+FROM connectors/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return { id: connectorId };
              }
            };
          }
        };
      }

      if (
        /SELECT id, connector_id, instance_key/.test(sql) &&
        /WHERE connector_id = \? AND instance_key = \?/.test(sql) &&
        /placement_key = \?/.test(sql)
      ) {
        return {
          bind(connectorId: string, instanceKey: string, placementKey: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return appServerRows.get(`${connectorId}:${instanceKey}:${placementKey}`) ?? null;
              }
            };
          }
        };
      }

      if (/INSERT INTO app_server_instances/.test(sql)) {
        return {
          bind(
            id: string,
            connectorId: string,
            instanceKey: string,
            scope: AppServerInstanceDoRow["scope"],
            workspaceId: string | null,
            threadId: string | null,
            placementKey: string,
            endpointType: AppServerInstanceDoRow["endpoint_type"],
            state: AppServerInstanceDoRow["state"],
            activeTurnCount: number,
            generation: number,
            statusSummary: string | null,
            lastError: string | null,
            reportFingerprint: string,
            lastSeenAt: string,
            stateChangedAt: string,
            summaryChangedAt: string,
            createdAt: string,
            updatedAt: string
          ) {
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.appServerInstanceWrites += 1;
                appServerRows.set(`${connectorId}:${instanceKey}:${placementKey}`, {
                  id,
                  connector_id: connectorId,
                  instance_key: instanceKey,
                  scope,
                  workspace_id: workspaceId,
                  thread_id: threadId,
                  placement_key: placementKey,
                  endpoint_type: endpointType,
                  state,
                  active_turn_count: activeTurnCount,
                  generation,
                  status_summary: statusSummary,
                  last_error: lastError,
                  report_fingerprint: reportFingerprint,
                  last_seen_at: lastSeenAt,
                  state_changed_at: stateChangedAt,
                  summary_changed_at: summaryChangedAt,
                  created_at: appServerRows.get(`${connectorId}:${instanceKey}:${placementKey}`)?.created_at ?? createdAt,
                  updated_at: updatedAt
                });
                return { success: true, meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/SELECT COUNT\(\*\) AS active_count/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return { active_count: 0 };
              }
            };
          }
        };
      }

      if (
        /FROM commands/.test(sql)
        && /WHERE id = \? AND lease_owner_connector_id = \?/.test(sql)
        && /state IN \('leased', 'running'\)/.test(sql)
      ) {
        return {
          bind(commandId: string, connectorId: string) {
            assert.equal(commandId, "command-1");
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return {
                  id: "command-1",
                  workspace_id: "workspace-api",
                  thread_id: "thread-1",
                  task_id: "task-1",
                  type: "codex",
                  prompt: "continue",
                  state: "running",
                  target_connector_id: "connector-online",
                  created_at: "2026-06-12T10:00:00.000Z",
                  updated_at: "2026-06-12T10:00:01.000Z"
                };
              }
            };
          }
        };
      }

      if (/FROM commands/.test(sql) && /lease_owner_connector_id = \?/.test(sql) && /state IN \('leased', 'running'\)/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async all() {
                return {
                  results: [
                    {
                      id: "command-1",
                      workspace_id: "workspace-api",
                      thread_id: "thread-1",
                      task_id: "task-1",
                      type: "codex",
                      prompt: "continue",
                      state: "running",
                      target_connector_id: "connector-online",
                      created_at: "2026-06-12T10:00:00.000Z",
                      updated_at: "2026-06-12T10:00:01.000Z"
                    }
                  ]
                };
              }
            };
          }
        };
      }

      if (/FROM app_server_instances/.test(sql) && /state <> 'stopped'/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async all() {
                return {
                  results: [...appServerRows.values()].filter(
                    (row) => row.connector_id === connectorId && row.state !== "stopped"
                  )
                };
              }
            };
          }
        };
      }

      if (/UPDATE app_server_instances/.test(sql) && /SET state = 'stopped'/.test(sql)) {
        return {
          bind(
            statusSummary: string,
            reportFingerprint: string,
            lastSeenAt: string,
            stateChangedAt: string,
            summaryChangedAt: string,
            updatedAt: string,
            id: string
          ) {
            return {
              async run() {
                const row = [...appServerRows.values()].find((candidate) => candidate.id === id);
                assert.ok(row);
                counters.appServerInstanceWrites += 1;
                appServerRows.set(`${row.connector_id}:${row.instance_key}:${row.placement_key}`, {
                  ...row,
                  state: "stopped",
                  active_turn_count: 0,
                  status_summary: statusSummary,
                  last_error: null,
                  report_fingerprint: reportFingerprint,
                  last_seen_at: lastSeenAt,
                  state_changed_at: stateChangedAt,
                  summary_changed_at: summaryChangedAt,
                  updated_at: updatedAt
                });
                return { success: true, meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /state = 'failed'/.test(sql)) {
        return {
          bind(updatedAt: string, commandId: string, connectorId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.commandFailures += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/UPDATE tasks/.test(sql)) {
        return {
          bind(updatedAt: string, taskId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(taskId, "task-1");
            return {
              async run() {
                counters.taskUpdates += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE threads/.test(sql) && /RETURNING last_seq/.test(sql)) {
        return {
          bind(updatedAt: string, threadId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(threadId, "thread-1");
            return {
              async first() {
                return { last_seq: 8 };
              }
            };
          }
        };
      }

      if (/INSERT INTO events/.test(sql)) {
        return {
          bind(
            eventId: string,
            workspaceId: string,
            threadId: string,
            commandId: string,
            seq: number,
            kind: string,
            priority: string,
            summary: string
          ) {
            assert.match(eventId, /^event-/);
            assert.equal(workspaceId, "workspace-api");
            assert.equal(threadId, "thread-1");
            assert.equal(commandId, "command-1");
            assert.equal(seq, 8);
            assert.equal(kind, "command.failed");
            assert.equal(priority, "P1");
            assert.equal(summary, "Connector disconnected before the command completed.");
            return {
              async run() {
                counters.eventInserts += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/INSERT INTO usage_windows/.test(sql)) {
        return usageWindowUpsertFake();
      }

      if (/UPDATE connectors/.test(sql) && /status = 'offline'/.test(sql)) {
        return {
          bind(updatedAt: string, connectorId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.connectorOfflineUpdates += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /status = 'degraded'/.test(sql)) {
        return {
          bind(updatedAt: string, connectorId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.connectorDegradedUpdates += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /active_command_count/.test(sql)) {
        return {
          bind(activeCount: number, updatedAt: string, connectorId: string) {
            assert.equal(activeCount, 0);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.activityUpdates += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/SELECT id, name, hostname, status, realtime_mode, budget_state/.test(sql) && /FROM connectors/.test(sql)) {
        return {
          bind(connectorId: string, includeOffline: number) {
            assert.equal(connectorId, "connector-online");
            assert.ok(includeOffline === 0 || includeOffline === 1);
            return {
              async first() {
                return {
                  id: "connector-online",
                  name: "mac-studio",
                  hostname: "mac-studio.local",
                  status: includeOffline === 1
                    ? "offline"
                    : counters.connectorDegradedUpdates > 0
                      ? "degraded"
                      : "online",
                  capabilities_json: "[\"codex_app_server_exec\"]",
                  logical_agent_count: 1,
                  active_command_count: 0,
                  realtime_mode: "realtime",
                  budget_state: "normal",
                  last_seen_at: "2026-06-13T10:00:00.000Z",
                  updated_at: "2026-06-13T10:00:00.000Z"
                };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get commandFailures() {
      return counters.commandFailures;
    },
    get taskUpdates() {
      return counters.taskUpdates;
    },
    get eventInserts() {
      return counters.eventInserts;
    },
    get activityUpdates() {
      return counters.activityUpdates;
    },
    get connectorDegradedUpdates() {
      return counters.connectorDegradedUpdates;
    },
    get connectorOfflineUpdates() {
      return counters.connectorOfflineUpdates;
    },
    get appServerInstanceWrites() {
      return counters.appServerInstanceWrites;
    }
  } as D1Database & typeof counters;
}

function mutableSocketWithAttachment(initialAttachment: unknown, sent: string[]): WebSocket {
  let attachment = initialAttachment;
  return {
    send(message: string) {
      sent.push(message);
    },
    deserializeAttachment() {
      return attachment;
    },
    serializeAttachment(nextAttachment: unknown) {
      attachment = nextAttachment;
    }
  } as unknown as WebSocket;
}

function appServerInstancePayload(
  state: "healthy" | "degraded" | "draining" | "restarting" | "stopped",
  overrides: {
    instance_key?: string;
    scope?: "connector" | "workspace" | "thread";
    workspace_id?: string;
    thread_id?: string;
    last_error?: string;
  } = {}
) {
  return {
    instance_key: overrides.instance_key ?? "default",
    scope: overrides.scope ?? "connector",
    workspace_id: overrides.workspace_id,
    thread_id: overrides.thread_id,
    endpoint_type: "managed",
    state,
    active_turn_count: 0,
    generation: 1,
    status_summary: "Managed app-server report.",
    last_error: overrides.last_error
  };
}

type AppServerInstanceDoRow = {
  id: string;
  connector_id: string;
  instance_key: string;
  scope: "connector" | "workspace" | "thread";
  workspace_id: string | null;
  thread_id: string | null;
  placement_key: string;
  endpoint_type: "managed" | "external";
  state: "healthy" | "degraded" | "draining" | "restarting" | "stopped";
  active_turn_count: number;
  generation: number;
  status_summary: string | null;
  last_error: string | null;
  report_fingerprint: string;
  last_seen_at: string;
  state_changed_at: string;
  summary_changed_at: string;
  created_at: string;
  updated_at: string;
};

function appServerInstanceDoDb(): D1Database & { readonly writes: number } {
  const rows = new Map<string, AppServerInstanceDoRow>();
  const counters = { writes: 0 };
  return {
    prepare(sql: string) {
      if (/SELECT id\s+FROM connectors/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return { id: connectorId };
              }
            };
          }
        };
      }

      if (
        /SELECT id, connector_id, instance_key/.test(sql) &&
        /WHERE connector_id = \? AND instance_key = \?/.test(sql) &&
        /placement_key = \?/.test(sql)
      ) {
        return {
          bind(connectorId: string, instanceKey: string, placementKey: string) {
            return {
              async first() {
                return rows.get(`${connectorId}:${instanceKey}:${placementKey}`) ?? null;
              }
            };
          }
        };
      }

      if (/INSERT INTO app_server_instances/.test(sql)) {
        return {
          bind(
            id: string,
            connectorId: string,
            instanceKey: string,
            scope: AppServerInstanceDoRow["scope"],
            workspaceId: string | null,
            threadId: string | null,
            placementKey: string,
            endpointType: AppServerInstanceDoRow["endpoint_type"],
            state: AppServerInstanceDoRow["state"],
            activeTurnCount: number,
            generation: number,
            statusSummary: string | null,
            lastError: string | null,
            reportFingerprint: string,
            lastSeenAt: string,
            stateChangedAt: string,
            summaryChangedAt: string,
            createdAt: string,
            updatedAt: string
          ) {
            return {
              async run() {
                counters.writes += 1;
                rows.set(`${connectorId}:${instanceKey}:${placementKey}`, {
                  id,
                  connector_id: connectorId,
                  instance_key: instanceKey,
                  scope,
                  workspace_id: workspaceId,
                  thread_id: threadId,
                  placement_key: placementKey,
                  endpoint_type: endpointType,
                  state,
                  active_turn_count: activeTurnCount,
                  generation,
                  status_summary: statusSummary,
                  last_error: lastError,
                  report_fingerprint: reportFingerprint,
                  last_seen_at: lastSeenAt,
                  state_changed_at: stateChangedAt,
                  summary_changed_at: summaryChangedAt,
                  created_at: createdAt,
                  updated_at: updatedAt
                });
                return { success: true, meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/FROM app_server_instances/.test(sql) && /state <> 'stopped'/.test(sql)) {
        return {
          bind(connectorId: string) {
            return {
              async all() {
                return {
                  results: [...rows.values()].filter(
                    (row) => row.connector_id === connectorId && row.state !== "stopped"
                  )
                };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in app-server DO fake: ${sql}`);
    },
    get writes() {
      return counters.writes;
    }
  } as unknown as D1Database & { readonly writes: number };
}

function staleReleaseDispatchDb(): D1Database & {
  readonly staleExplicitCleanupQueries: number;
  readonly commandReleases: number;
  readonly pendingDispatchQueries: number;
  readonly commandLeases: number;
} {
  const counters = {
    staleExplicitCleanupQueries: 0,
    commandReleases: 0,
    pendingDispatchQueries: 0,
    commandLeases: 0
  };
  return {
    prepare(sql: string) {
      if (/FROM commands cmd/.test(sql) && /cmd\.lease_target_host_session_id IS NOT NULL/.test(sql)) {
        return {
          bind(
            targetConnectorId: string,
            scopeConnectorId: string,
            leaseOwnerConnectorId: string,
            now: string,
            currentTargetConnectorId: string
          ) {
            assert.equal(targetConnectorId, "connector-online");
            assert.equal(scopeConnectorId, "connector-online");
            assert.equal(leaseOwnerConnectorId, "connector-online");
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(currentTargetConnectorId, "connector-online");
            return {
              async all() {
                counters.staleExplicitCleanupQueries += 1;
                return {
                  results: [
                    {
                      id: "command-1",
                      workspace_id: "workspace-api",
                      thread_id: "thread-1",
                      task_id: "task-1",
                      type: "codex",
                      prompt: "Continue on the replacement session",
                      state: "pending",
                      target_connector_id: "connector-online",
                      target_connector_id_source: "attached",
                      lease_owner_connector_id: null,
                      lease_target_host_session_id: "session-old",
                      created_at: "2026-06-13T10:00:00.000Z",
                      updated_at: "2026-06-13T10:00:00.000Z"
                    }
                  ]
                };
              }
            };
          }
        };
      }

      if (
        /UPDATE commands/.test(sql) &&
        /SET state = 'pending'/.test(sql) &&
        /target_connector_id_source IN \('attached', 'auto'\)/.test(sql)
      ) {
        return {
          bind(
            updatedAt: string,
            commandId: string,
            targetConnectorId: string,
            leaseTargetHostSessionId: string,
            leaseOwnerConnectorId: string,
            now: string,
            staleConnectorId: string,
            staleHostSessionId: string
          ) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(targetConnectorId, "connector-online");
            assert.equal(leaseTargetHostSessionId, "session-old");
            assert.equal(leaseOwnerConnectorId, "connector-online");
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(staleConnectorId, "connector-online");
            assert.equal(staleHostSessionId, "session-old");
            return {
              async run() {
                counters.commandReleases += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/SELECT DISTINCT c\.id AS connector_id/.test(sql)) {
        return {
          bind(workspaceId: string) {
            assert.equal(workspaceId, "workspace-api");
            return {
              async all() {
                return { results: [{ connector_id: "connector-replacement" }] };
              }
            };
          }
        };
      }

      if (/FROM commands cmd/.test(sql) && /LEFT JOIN host_sessions hs/.test(sql)) {
        return {
          bind(
            now: string,
            targetConnectorId: string,
            autoAttachmentConnectorId: string,
            hostSessionConnectorId: string,
            executableConnectorId: string
          ) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(targetConnectorId, "connector-replacement");
            assert.equal(autoAttachmentConnectorId, "connector-replacement");
            assert.equal(hostSessionConnectorId, "connector-replacement");
            assert.equal(executableConnectorId, "connector-replacement");
            return {
              async all() {
                counters.pendingDispatchQueries += 1;
                return {
                  results: [
                    {
                      id: "command-1",
                      workspace_id: "workspace-api",
                      thread_id: "thread-1",
                      task_id: "task-1",
                      type: "codex",
                      prompt: "Continue on the replacement session",
                      state: "pending",
                      target_connector_id: null,
                      target_connector_id_source: "auto",
                      created_at: "2026-06-13T10:00:00.000Z",
                      updated_at: "2026-06-13T10:00:00.000Z",
                      target_host_session_row_id: "host-session-new",
                      target_host_session_id: "session-new",
                      target_host_session_app_server_present: 1,
                      target_host_session_cwd: "/workspace/project"
                    }
                  ]
                };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /SET state = 'leased'/.test(sql)) {
        return {
          bind(
            targetHostSessionIdForTarget: string | null,
            targetHostSessionIsAppServerForTarget: number,
            retargetConnectorId: string,
            targetHostSessionIdForSource: string | null,
            targetHostSessionIsAppServerForSource: number,
            connectorId: string
          ) {
            assert.equal(targetHostSessionIdForTarget, "session-new");
            assert.equal(targetHostSessionIsAppServerForTarget, 1);
            assert.equal(retargetConnectorId, "connector-replacement");
            assert.equal(targetHostSessionIdForSource, "session-new");
            assert.equal(targetHostSessionIsAppServerForSource, 1);
            assert.equal(connectorId, "connector-replacement");
            return {
              async run() {
                counters.commandLeases += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/SELECT COUNT\(\*\) AS active_count/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-replacement");
            return {
              async first() {
                return { active_count: 1 };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /active_command_count/.test(sql)) {
        return {
          bind(activeCount: number, updatedAt: string, connectorId: string) {
            assert.equal(activeCount, 1);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-replacement");
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get staleExplicitCleanupQueries() {
      return counters.staleExplicitCleanupQueries;
    },
    get commandReleases() {
      return counters.commandReleases;
    },
    get pendingDispatchQueries() {
      return counters.pendingDispatchQueries;
    },
    get commandLeases() {
      return counters.commandLeases;
    }
  } as D1Database & typeof counters;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function readyGatedDispatchDb(options: {
  initialCapabilities?: string[];
  initialStatus?: "online" | "offline" | "degraded";
  initialUpdatedAt?: string;
  pendingCommand?: boolean;
} = {}): D1Database & {
  readonly capabilityUpdates: number;
  readonly connectorOnlineUpdates: number;
  readonly pendingDispatchQueries: number;
  readonly staleExplicitCleanupQueries: number;
  readonly commandLeases: number;
  readonly commandReleases: number;
  readonly commandFailures: number;
  readonly taskUpdates: number;
  readonly eventInserts: number;
  readonly activityUpdates: number;
} {
  const counters = {
    capabilityUpdates: 0,
    connectorOnlineUpdates: 0,
    pendingDispatchQueries: 0,
    staleExplicitCleanupQueries: 0,
    commandLeases: 0,
    commandReleases: 0,
    commandFailures: 0,
    taskUpdates: 0,
    eventInserts: 0,
    activityUpdates: 0,
    commandState: options.pendingCommand ? "pending" as "pending" | "leased" : undefined,
    capabilitiesJson: options.initialCapabilities ? JSON.stringify(options.initialCapabilities) : undefined as string | undefined,
    connectorStatus: options.initialStatus ?? "online",
    connectorUpdatedAt: options.initialUpdatedAt ?? "2026-06-13T10:00:00.000Z",
    connectorLastSeenAt: options.initialUpdatedAt ?? "2026-06-13T10:00:00.000Z",
    hostSession: undefined as undefined | {
      id: string;
      connector_id: string;
      hostname: string;
      workspace_id: string;
      session_id: string;
      title: string;
      title_source: string;
      app_server_present: number;
      cwd: string | null;
      updated_at: string;
      attached_task_id: string | null;
      attached_thread_id: string | null;
    }
  };
  return {
    prepare(sql: string) {
      if (/UPDATE connectors/.test(sql) && /capabilities_json = \?/.test(sql)) {
        return {
          bind(
            capabilitiesJson: string,
            lastSeenAt: string,
            updatedAt: string,
            connectorId: string,
            compareCapabilitiesJson: string
          ) {
            assert.deepEqual(JSON.parse(capabilitiesJson), ["placeholder_commands"]);
            assert.equal(compareCapabilitiesJson, capabilitiesJson);
            assert.match(lastSeenAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                if (counters.capabilitiesJson === capabilitiesJson && counters.connectorStatus === "online") {
                  return { success: true, meta: { changes: 0 } };
                }
                counters.capabilitiesJson = capabilitiesJson;
                counters.connectorStatus = "online";
                counters.connectorLastSeenAt = lastSeenAt;
                counters.connectorUpdatedAt = updatedAt;
                counters.capabilityUpdates += 1;
                return { success: true, meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/SELECT id, name, hostname, status, realtime_mode, budget_state/.test(sql) && /FROM connectors/.test(sql)) {
        return {
          bind(connectorId: string, includeOffline: number) {
            assert.equal(connectorId, "connector-online");
            assert.equal(includeOffline, 0);
            return {
              async first() {
                return {
                  id: "connector-online",
                  name: "mac-studio",
                  hostname: "mac-studio.local",
                  status: counters.connectorStatus,
                  capabilities_json: counters.capabilitiesJson ?? "[]",
                  logical_agent_count: 1,
                  active_command_count: 0,
                  realtime_mode: "realtime",
                  budget_state: "normal",
                  last_seen_at: counters.connectorLastSeenAt,
                  updated_at: counters.connectorUpdatedAt
                };
              }
            };
          }
        };
      }

      if (/SELECT hostname\s+FROM connectors/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return { hostname: "mac-studio.local" };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /status = 'online'/.test(sql) && !/capabilities_json = \?/.test(sql)) {
        return {
          bind(lastSeenAt: string, updatedAt: string, connectorId: string) {
            assert.match(lastSeenAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.connectorStatus = "online";
                counters.connectorLastSeenAt = lastSeenAt;
                counters.connectorUpdatedAt = updatedAt;
                counters.connectorOnlineUpdates += 1;
                return { success: true, meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/SELECT workspace_id\s+FROM workspace_connectors/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return { workspace_id: "workspace-api" };
              }
            };
          }
        };
      }

      if (/SELECT hs\.id, hs\.connector_id/.test(sql) && /WHERE hs\.session_id = \? AND hs\.connector_id = \?/.test(sql)) {
        return {
          bind(sessionId: string, connectorId: string) {
            assert.equal(sessionId, "session-1");
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return counters.hostSession;
              }
            };
          }
        };
      }

      if (/INSERT INTO host_sessions/.test(sql)) {
        return {
          bind(
            id: string,
            connectorId: string,
            hostname: string,
            workspaceId: string,
            sessionId: string,
            title: string,
            titleSource: string,
            appServerPresent: number,
            cwd: string | null,
            _syncedAt: string,
            updatedAt: string
          ) {
            assert.equal(connectorId, "connector-online");
            assert.equal(hostname, "mac-studio.local");
            assert.equal(workspaceId, "workspace-api");
            assert.equal(sessionId, "session-1");
            counters.hostSession = {
              id,
              connector_id: connectorId,
              hostname,
              workspace_id: workspaceId,
              session_id: sessionId,
              title,
              title_source: titleSource,
              app_server_present: appServerPresent,
              cwd,
              updated_at: updatedAt,
              attached_task_id: null,
              attached_thread_id: null
            };
            return {
              async run() {
                return { success: true, meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/INSERT INTO host_session_syncs/.test(sql)) {
        return {
          bind(connectorId: string, syncedAt: string, reportedSessionCount: number, storedSessionCount: number) {
            assert.equal(connectorId, "connector-online");
            assert.match(syncedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(reportedSessionCount, 1);
            assert.equal(storedSessionCount, 1);
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /last_seen_at = \?/.test(sql)) {
        return {
          bind(lastSeenAt: string, updatedAt: string, connectorId: string) {
            assert.match(lastSeenAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(updatedAt, lastSeenAt);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.connectorOnlineUpdates += 1;
                return { success: true, meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/FROM commands cmd/.test(sql) && /cmd\.lease_target_host_session_id IS NOT NULL/.test(sql)) {
        return {
          bind(
            targetConnectorId: string,
            scopeConnectorId: string,
            leaseOwnerConnectorId: string,
            now: string,
            currentTargetConnectorId: string
          ) {
            assert.equal(targetConnectorId, "connector-online");
            assert.equal(scopeConnectorId, "connector-online");
            assert.equal(leaseOwnerConnectorId, "connector-online");
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(currentTargetConnectorId, "connector-online");
            return {
              async all() {
                counters.staleExplicitCleanupQueries += 1;
                return { results: [] };
              }
            };
          }
        };
      }

      if (/FROM commands cmd/.test(sql) && /LEFT JOIN host_sessions hs/.test(sql)) {
        return {
          bind(
            now: string,
            targetConnectorId: string,
            autoAttachmentConnectorId: string,
            hostSessionConnectorId: string,
            executableConnectorId: string
          ) {
            assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(targetConnectorId, "connector-online");
            assert.equal(autoAttachmentConnectorId, "connector-online");
            assert.equal(hostSessionConnectorId, "connector-online");
            assert.equal(executableConnectorId, "connector-online");
            return {
              async all() {
                counters.pendingDispatchQueries += 1;
                return {
                  results: options.pendingCommand
                    && counters.commandState === "pending"
                    ? [
                      {
                        id: "command-1",
                        workspace_id: "workspace-api",
                        thread_id: "thread-1",
                        task_id: "task-1",
                        type: "codex",
                        prompt: "continue",
                        state: "pending",
                        target_connector_id: "connector-online",
                        target_connector_id_source: "manual",
                        execution_mode: "codex_cli_fallback",
                        created_at: "2026-06-12T10:00:00.000Z",
                        updated_at: "2026-06-12T10:00:01.000Z",
                        target_host_session_row_id: null,
                        target_host_session_id: null,
                        target_host_session_app_server_present: null,
                        target_host_session_cwd: null
                      }
                    ]
                    : []
                };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /SET state = 'leased'/.test(sql)) {
        return {
          bind(...args: unknown[]) {
            assert.equal(args[0], null);
            assert.equal(args[1], 0);
            assert.equal(args[2], "connector-online");
            assert.equal(args[3], null);
            assert.equal(args[4], 0);
            assert.equal(args[5], "connector-online");
            assert.match(String(args[6]), /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(args[7], null);
            assert.match(String(args[8]), /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(args[9], "command-1");
            assert.match(String(args[10]), /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(args[15], "connector-online");
            assert.equal(args[17], "connector-online");
            assert.equal(args[19], "connector-online");
            assert.equal(args[20], "connector-online");
            return {
              async run() {
                if (counters.commandState !== "pending") {
                  return { meta: { changes: 0 } };
                }
                counters.commandState = "leased";
                counters.commandLeases += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (
        /UPDATE commands/.test(sql)
        && /SET state = 'pending'/.test(sql)
        && /lease_owner_connector_id = NULL/.test(sql)
        && /state = 'leased'/.test(sql)
      ) {
        return {
          bind(updatedAt: string, commandId: string, connectorId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                if (counters.commandState !== "leased") {
                  return { meta: { changes: 0 } };
                }
                counters.commandState = "pending";
                counters.commandReleases += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/SELECT COUNT\(\*\) AS active_count/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return { active_count: counters.commandState === "leased" ? 1 : 0 };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /active_command_count/.test(sql)) {
        return {
          bind(activeCount: number, updatedAt: string, connectorId: string) {
            assert.equal(activeCount, counters.commandState === "leased" ? 1 : 0);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.activityUpdates += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (
        /FROM commands/.test(sql)
        && /WHERE id = \? AND lease_owner_connector_id = \?/.test(sql)
        && /state IN \('leased', 'running'\)/.test(sql)
      ) {
        return {
          bind(commandId: string, connectorId: string) {
            assert.equal(commandId, "command-1");
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return {
                  id: "command-1",
                  workspace_id: "workspace-api",
                  thread_id: "thread-1",
                  task_id: "task-1",
                  type: "codex",
                  prompt: "continue",
                  state: "leased",
                  target_connector_id: "connector-online",
                  created_at: "2026-06-12T10:00:00.000Z",
                  updated_at: "2026-06-12T10:00:01.000Z"
                };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /state = 'failed'/.test(sql)) {
        return {
          bind(updatedAt: string, commandId: string, connectorId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.commandFailures += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/UPDATE tasks/.test(sql)) {
        return {
          bind(updatedAt: string, taskId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(taskId, "task-1");
            return {
              async run() {
                counters.taskUpdates += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE threads/.test(sql) && /RETURNING last_seq/.test(sql)) {
        return {
          bind(updatedAt: string, threadId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(threadId, "thread-1");
            return {
              async first() {
                return { last_seq: 8 };
              }
            };
          }
        };
      }

      if (/INSERT INTO events/.test(sql)) {
        return {
          bind(
            eventId: string,
            workspaceId: string,
            threadId: string,
            commandId: string,
            seq: number,
            kind: string,
            priority: string,
            summary: string
          ) {
            assert.match(eventId, /^event-/);
            assert.equal(workspaceId, "workspace-api");
            assert.equal(threadId, "thread-1");
            assert.equal(commandId, "command-1");
            assert.equal(seq, 8);
            assert.equal(kind, "command.failed");
            assert.equal(priority, "P1");
            assert.equal(summary, "Connector disconnected before the command completed.");
            return {
              async run() {
                counters.eventInserts += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/INSERT INTO usage_windows/.test(sql)) {
        return usageWindowUpsertFake();
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get capabilityUpdates() {
      return counters.capabilityUpdates;
    },
    get connectorOnlineUpdates() {
      return counters.connectorOnlineUpdates;
    },
    get pendingDispatchQueries() {
      return counters.pendingDispatchQueries;
    },
    get staleExplicitCleanupQueries() {
      return counters.staleExplicitCleanupQueries;
    },
    get commandLeases() {
      return counters.commandLeases;
    },
    get commandReleases() {
      return counters.commandReleases;
    },
    get commandFailures() {
      return counters.commandFailures;
    },
    get taskUpdates() {
      return counters.taskUpdates;
    },
    get eventInserts() {
      return counters.eventInserts;
    },
    get activityUpdates() {
      return counters.activityUpdates;
    }
  } as D1Database & typeof counters;
}

function usageWindowUpsertFake() {
  return {
    bind() {
      return {
        async run() {
          return { success: true };
        }
      };
    }
  };
}
