import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "./routes.js";
import type { Env } from "./types.js";

const devEnv: Env = {
  CHAOP_DEV_ALLOW_INSECURE: "true",
  CHAOP_API_DOMAIN: "api.example.com",
  CHAOP_GUI_DOMAIN: "app.example.com",
  AGENT_BOOTSTRAP_SECRET: "test-bootstrap"
};

test("health route returns service metadata", async () => {
  const response = await handleRequest(new Request("https://api.example.com/api/health"), devEnv);
  const body = (await response.json()) as { ok: boolean; service: string };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "chaop-api");
});

test("browser bootstrap requires Access outside dev mode", async () => {
  const response = await handleRequest(new Request("https://api.example.com/api/bootstrap"), {});
  const body = (await response.json()) as { error: string };

  assert.equal(response.status, 401);
  assert.match(body.error, /covered by the Browser Access application/);
});

test("browser API responses allow the configured GUI origin", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/health", {
      headers: {
        origin: "https://app.example.com"
      }
    }),
    devEnv
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.com");
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
});

test("browser API responses reject unconfigured origins", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/health", {
      headers: {
        origin: "https://unknown.example.com"
      }
    }),
    devEnv
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("state-changing browser API requests reject unconfigured origins", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      headers: {
        origin: "https://unknown.example.com"
      },
      body: JSON.stringify({
        workspace_id: "workspace-api",
        prompt: "Summarise current errors"
      })
    }),
    devEnv
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Disallowed browser origin" });
});

test("state-changing browser API reports missing Access coverage", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/host-sessions/session-1/attach", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      },
      body: JSON.stringify({
        connector_id: "connector-mac-studio"
      })
    }),
    {
      CHAOP_API_DOMAIN: "api.example.com",
      CHAOP_GUI_DOMAIN: "app.example.com"
    }
  );
  const body = (await response.json()) as { error: string };

  assert.equal(response.status, 401);
  assert.match(body.error, /covered by the Browser Access application/);
});

test("host session refresh dispatches to the workspace durable object", async () => {
  let internalPath = "";
  const response = await handleRequest(
    new Request("https://api.example.com/api/host-sessions/refresh", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      }
    }),
    {
      ...devEnv,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async (input: RequestInfo | URL) => {
            internalPath = new URL(String(input)).pathname;
            return new Response(JSON.stringify({ dispatched_to: 2 }), {
              headers: { "content-type": "application/json; charset=utf-8" }
            });
          }
        }) as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as { requested: boolean; dispatched_to: number };

  assert.equal(response.status, 202);
  assert.equal(body.requested, true);
  assert.equal(body.dispatched_to, 2);
  assert.equal(internalPath, "/internal/refresh-host-sessions");
});

test("local thread creation rejects invalid payloads before DB work", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/local-threads", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      },
      body: JSON.stringify({
        workspace_id: ""
      })
    }),
    {
      ...devEnv,
      DB: {
        prepare() {
          throw new Error("DB should not be read for invalid payloads");
        }
      } as unknown as D1Database,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async () => {
            throw new Error("DO should not be called for invalid payloads");
          }
        }) as unknown as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid local thread payload" });
});

test("local thread creation requires D1 before connector dispatch", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/local-threads", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      },
      body: JSON.stringify({
        workspace_id: "workspace-api",
        title: "Investigate retry loop"
      })
    }),
    devEnv
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "DB binding is required" });
});

test("local thread creation dispatches to an app-server capable connector and attaches the result", async () => {
  let internalPath = "";
  let dispatchBody: Record<string, unknown> | undefined;
  const db = localThreadCreateDb();
  const response = await handleRequest(
    new Request("https://api.example.com/api/local-threads", {
      method: "POST",
      headers: {
        origin: "https://app.example.com",
        "x-chaop-dev-user": "operator@example.com"
      },
      body: JSON.stringify({
        workspace_id: "workspace-api",
        title: "Investigate retry loop",
        cwd: "/tmp/browser-supplied-cwd"
      })
    }),
    {
      ...devEnv,
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            internalPath = new URL(String(input)).pathname;
            dispatchBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            return new Response(
              JSON.stringify({
                session: {
                  session_id: "session-created-1",
                  title: "Investigate retry loop",
                  title_source: "app_server",
                  app_server_present: true,
                  cwd: "/workspace/codex",
                  updated_at: "2026-06-12T11:24:03.000Z"
                }
              }),
              { headers: { "content-type": "application/json; charset=utf-8" } }
            );
          }
        }) as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as {
    host_session: { session_id: string; attached_task_id?: string; attached_thread_id?: string };
    task: { id: string; thread_id: string };
    thread: { id: string; title: string };
  };

  assert.equal(response.status, 201);
  assert.equal(internalPath, "/internal/create-local-thread");
  assert.equal(dispatchBody?.connector_id, "connector-online");
  assert.equal(dispatchBody?.workspace_id, "workspace-api");
  assert.equal(dispatchBody?.title, "Investigate retry loop");
  assert.equal(typeof dispatchBody?.request_id, "string");
  assert.equal(Object.hasOwn(dispatchBody ?? {}, "cwd"), false);
  assert.equal(body.host_session.session_id, "session-created-1");
  assert.equal(body.host_session.attached_task_id, body.task.id);
  assert.equal(body.host_session.attached_thread_id, body.thread.id);
  assert.equal(body.task.thread_id, body.thread.id);
  assert.equal(body.thread.title, "Investigate retry loop");
  assert.equal(db.userWrites, 1);
  assert.equal(db.syncWrites, 1);
});

test("task archive syncs attached app-server host session after updating D1", async () => {
  let internalPath = "";
  let dispatchBody: Record<string, unknown> | undefined;
  const db = taskArchiveSyncDb({ titleSource: "metadata", appServerPresent: true });
  const response = await handleRequest(
    new Request("https://api.example.com/api/tasks/task-host-1/archive", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      }
    }),
    {
      ...devEnv,
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            internalPath = new URL(String(input)).pathname;
            dispatchBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            return new Response(JSON.stringify({ ok: true }), {
              headers: { "content-type": "application/json; charset=utf-8" }
            });
          }
        }) as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as {
    task: { id: string; archived_at?: string };
    archive_sync?: { attempted: boolean; connector_id?: string; session_id?: string; archived: boolean };
  };

  assert.equal(response.status, 200);
  assert.equal(internalPath, "/internal/sync-thread-archive");
  assert.equal(dispatchBody?.connector_id, "connector-online");
  assert.equal(dispatchBody?.session_id, "thread-1");
  assert.equal(dispatchBody?.archived, true);
  assert.equal(typeof dispatchBody?.request_id, "string");
  assert.equal(body.task.id, "task-host-1");
  assert.match(body.task.archived_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(body.archive_sync, {
    attempted: true,
    connector_id: "connector-online",
    session_id: "thread-1",
    archived: true
  });
  assert.equal(db.taskArchiveWrites, 1);
  assert.equal(db.threadArchiveWrites, 1);
});

test("task unarchive syncs attached app-server host session after updating D1", async () => {
  let internalPath = "";
  let dispatchBody: Record<string, unknown> | undefined;
  const db = taskArchiveSyncDb({ initialArchivedAt: "2026-06-12T10:30:00.000Z" });
  const response = await handleRequest(
    new Request("https://api.example.com/api/tasks/task-host-1/unarchive", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      }
    }),
    {
      ...devEnv,
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            internalPath = new URL(String(input)).pathname;
            dispatchBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            return new Response(JSON.stringify({ ok: true }), {
              headers: { "content-type": "application/json; charset=utf-8" }
            });
          }
        }) as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as {
    task: { id: string; archived_at?: string };
    archive_sync?: { attempted: boolean; connector_id?: string; session_id?: string; archived: boolean };
  };

  assert.equal(response.status, 200);
  assert.equal(internalPath, "/internal/sync-thread-archive");
  assert.equal(dispatchBody?.connector_id, "connector-online");
  assert.equal(dispatchBody?.session_id, "thread-1");
  assert.equal(dispatchBody?.archived, false);
  assert.equal(typeof dispatchBody?.request_id, "string");
  assert.equal(body.task.id, "task-host-1");
  assert.equal(body.task.archived_at, undefined);
  assert.deepEqual(body.archive_sync, {
    attempted: true,
    connector_id: "connector-online",
    session_id: "thread-1",
    archived: false
  });
  assert.equal(db.taskArchiveWrites, 1);
  assert.equal(db.threadArchiveWrites, 1);
});

test("task archive reports D1-only fallback when app-server thread is not resolved", async () => {
  const db = taskArchiveSyncDb();
  const response = await handleRequest(
    new Request("https://api.example.com/api/tasks/task-host-1/archive", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      }
    }),
    {
      ...devEnv,
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async () => {
            return new Response(JSON.stringify({ ok: true, synced: false }), {
              headers: { "content-type": "application/json; charset=utf-8" }
            });
          }
        }) as unknown as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as {
    task: { id: string; archived_at?: string };
    archive_sync?: { attempted: boolean; connector_id?: string; session_id?: string; archived: boolean; error?: string };
  };

  assert.equal(response.status, 200);
  assert.equal(body.task.id, "task-host-1");
  assert.deepEqual(body.archive_sync, {
    attempted: false,
    connector_id: "connector-online",
    session_id: "thread-1",
    archived: true,
    error: "No matching app-server thread was found"
  });
  assert.equal(db.taskArchiveWrites, 1);
  assert.equal(db.threadArchiveWrites, 1);
});

test("task archive records sync warning when app-server archive sync fails", async () => {
  const db = taskArchiveSyncDb();
  const response = await handleRequest(
    new Request("https://api.example.com/api/tasks/task-host-1/archive", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      }
    }),
    {
      ...devEnv,
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async () => {
            return new Response(JSON.stringify({ error: "Connector is not connected" }), {
              status: 404,
              headers: { "content-type": "application/json; charset=utf-8" }
            });
          }
        }) as unknown as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as {
    task: { id: string; archived_at?: string };
    archive_sync?: { attempted: boolean; connector_id?: string; session_id?: string; archived: boolean; error?: string };
  };

  assert.equal(response.status, 200);
  assert.equal(body.task.id, "task-host-1");
  assert.match(body.task.archived_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(body.archive_sync, {
    attempted: true,
    connector_id: "connector-online",
    session_id: "thread-1",
    archived: true,
    error: "Connector is not connected"
  });
  assert.equal(db.taskArchiveWrites, 1);
  assert.equal(db.threadArchiveWrites, 1);
});

test("task archive falls back to D1 when connector cannot sync app-server archive", async () => {
  const db = taskArchiveSyncDb({ supportsArchive: false });
  const response = await handleRequest(
    new Request("https://api.example.com/api/tasks/task-host-1/archive", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      }
    }),
    {
      ...devEnv,
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async () => {
            throw new Error("archive sync should not dispatch");
          }
        }) as unknown as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );

  const body = (await response.json()) as {
    task: { id: string; archived_at?: string };
    archive_sync?: { attempted: boolean; connector_id?: string; session_id?: string; archived: boolean; error?: string };
  };

  assert.equal(response.status, 200);
  assert.equal(body.task.id, "task-host-1");
  assert.deepEqual(body.archive_sync, {
    attempted: false,
    connector_id: "connector-online",
    session_id: "thread-1",
    archived: true,
    error: "Connector does not support app-server archive sync"
  });
  assert.equal(db.taskArchiveWrites, 1);
  assert.equal(db.threadArchiveWrites, 1);
});

test("task archive does not dispatch archive sync for legacy app-server thread capability", async () => {
  const db = taskArchiveSyncDb({ supportsArchive: false, supportsAppServerThreads: true });
  const response = await handleRequest(
    new Request("https://api.example.com/api/tasks/task-host-1/archive", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      }
    }),
    {
      ...devEnv,
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async () => {
            throw new Error("archive sync should not dispatch");
          }
        }) as unknown as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );

  const body = (await response.json()) as {
    task: { id: string; archived_at?: string };
    archive_sync?: { attempted: boolean; connector_id?: string; session_id?: string; archived: boolean };
  };

  assert.equal(response.status, 200);
  assert.equal(body.task.id, "task-host-1");
  assert.deepEqual(body.archive_sync, {
    attempted: false,
    connector_id: "connector-online",
    session_id: "thread-1",
    archived: true,
    error: "Connector does not support app-server archive sync"
  });
  assert.equal(db.taskArchiveWrites, 1);
  assert.equal(db.threadArchiveWrites, 1);
});

test("task archive warns when attached connector is offline", async () => {
  const db = taskArchiveSyncDb({ connectorStatus: "offline" });
  const response = await handleRequest(
    new Request("https://api.example.com/api/tasks/task-host-1/archive", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      }
    }),
    {
      ...devEnv,
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async () => {
            throw new Error("archive sync should not dispatch");
          }
        }) as unknown as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );

  const body = (await response.json()) as {
    task: { id: string; archived_at?: string };
    archive_sync?: { attempted: boolean; connector_id?: string; session_id?: string; archived: boolean; error?: string };
  };

  assert.equal(response.status, 200);
  assert.equal(body.task.id, "task-host-1");
  assert.deepEqual(body.archive_sync, {
    attempted: false,
    connector_id: "connector-online",
    session_id: "thread-1",
    archived: true,
    error: "Connector is offline"
  });
  assert.equal(db.taskArchiveWrites, 1);
  assert.equal(db.threadArchiveWrites, 1);
});

test("task archive stays D1-only for non-app-server host sessions", async () => {
  const db = taskArchiveSyncDb({ appServerPresent: false, titleSource: "history" });
  const response = await handleRequest(
    new Request("https://api.example.com/api/tasks/task-host-1/archive", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      }
    }),
    {
      ...devEnv,
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async () => {
            throw new Error("archive sync should not dispatch");
          }
        }) as unknown as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );

  const body = (await response.json()) as {
    task: { id: string; archived_at?: string };
    archive_sync?: unknown;
  };

  assert.equal(response.status, 200);
  assert.equal(body.task.id, "task-host-1");
  assert.match(body.task.archived_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(body.archive_sync, undefined);
  assert.equal(db.taskArchiveWrites, 1);
  assert.equal(db.threadArchiveWrites, 1);
});

test("host session attach imports bounded history backfill events", async () => {
  let internalPath = "";
  let dispatchBody: Record<string, unknown> | undefined;
  const db = hostSessionAttachBackfillDb();
  const response = await handleRequest(
    new Request("https://api.example.com/api/host-sessions/session-1/attach", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      },
      body: JSON.stringify({
        connector_id: "connector-online"
      })
    }),
    {
      ...devEnv,
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            internalPath = new URL(String(input)).pathname;
            dispatchBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            return new Response(
              JSON.stringify({
                events: Array.from({ length: 31 }, (_, index) => ({
                    kind: "command.output",
                    priority: "P3",
                    summary: `2026-06-12 10:${String(index).padStart(2, "0")} - User: Event ${index}`,
                    idempotency_key: `rollout:session-1:${index}`,
                    created_at: `2026-06-12T10:${String(index).padStart(2, "0")}:00.000Z`
                })),
                truncated: false
              }),
              { headers: { "content-type": "application/json; charset=utf-8" } }
            );
          }
        }) as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as {
    events?: Array<{ summary: string }>;
    backfill?: { attempted: boolean; imported_event_count: number; truncated?: boolean };
    host_session: { attached_thread_id?: string };
    thread: { last_seq: number };
  };

  assert.equal(response.status, 201);
  assert.equal(internalPath, "/internal/backfill-host-session");
  assert.equal(dispatchBody?.connector_id, "connector-online");
  assert.equal(dispatchBody?.session_id, "session-1");
  assert.equal(dispatchBody?.limit, 30);
  assert.equal(body.host_session.attached_thread_id, "thread-host-session-1-connector-online");
  assert.equal(body.thread.last_seq, 30);
  assert.equal(body.events?.length, 30);
  assert.equal(body.events?.[0]?.summary, "2026-06-12 10:01 - User: Event 1");
  assert.deepEqual(body.backfill, {
    attempted: true,
    imported_event_count: 30,
    truncated: true
  });
  assert.equal(db.eventInserts, 30);
});

test("host session attach skips backfill when connector lacks capability", async () => {
  const db = hostSessionAttachBackfillDb({ supportsBackfill: false });
  const response = await handleRequest(
    new Request("https://api.example.com/api/host-sessions/session-1/attach", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      },
      body: JSON.stringify({
        connector_id: "connector-online"
      })
    }),
    {
      ...devEnv,
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async () => {
            throw new Error("DO should not receive backfill requests without connector capability");
          }
        }) as unknown as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as {
    events?: unknown[];
    backfill?: unknown;
    host_session: { attached_thread_id?: string };
  };

  assert.equal(response.status, 201);
  assert.equal(body.host_session.attached_thread_id, "thread-host-session-1-connector-online");
  assert.equal(body.events, undefined);
  assert.equal(body.backfill, undefined);
  assert.equal(db.eventInserts, 0);
});

test("host session attach skips backfill when the session is already attached", async () => {
  const db = hostSessionAttachBackfillDb({ alreadyAttached: true });
  const response = await handleRequest(
    new Request("https://api.example.com/api/host-sessions/session-1/attach", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      },
      body: JSON.stringify({
        connector_id: "connector-online"
      })
    }),
    {
      ...devEnv,
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async () => {
            throw new Error("DO should not receive backfill requests for existing attachments");
          }
        }) as unknown as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as {
    events?: unknown[];
    backfill?: unknown;
    host_session: { attached_thread_id?: string };
  };

  assert.equal(response.status, 201);
  assert.equal(body.host_session.attached_thread_id, "thread-host-session-1-connector-online");
  assert.equal(body.events, undefined);
  assert.equal(body.backfill, undefined);
  assert.equal(db.eventInserts, 0);
});

test("host session detach clears the attached task and thread when D1 is bound", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/host-sessions/session-1/detach", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      },
      body: JSON.stringify({
        connector_id: "connector-online"
      })
    }),
    {
      ...devEnv,
      DB: hostSessionDetachDb()
    }
  );
  const body = (await response.json()) as {
    host_session: {
      session_id: string;
      attached_task_id?: string;
      attached_thread_id?: string;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.host_session.session_id, "session-1");
  assert.equal(body.host_session.attached_task_id, undefined);
  assert.equal(body.host_session.attached_thread_id, undefined);
});

test("CORS preflight returns configured browser headers", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "POST"
      }
    }),
    devEnv
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.com");
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
});

test("CORS preflight rejects unconfigured origins", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "OPTIONS",
      headers: {
        origin: "https://unknown.example.com",
        "access-control-request-method": "POST"
      }
    }),
    devEnv
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Disallowed browser origin" });
});

test("browser bootstrap rejects unverified Access JWT when config is missing", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/bootstrap", {
      headers: {
        "cf-access-jwt-assertion": "not-a-real-jwt"
      }
    }),
    {}
  );

  assert.equal(response.status, 403);
});

test("browser bootstrap returns focused v1 data in dev mode", async () => {
  const response = await handleRequest(new Request("https://api.example.com/api/bootstrap"), devEnv);
  const body = (await response.json()) as { connectors: unknown[]; tasks: unknown[]; task_categories: unknown[] };

  assert.equal(response.status, 200);
  assert.equal(body.connectors.length > 0, true);
  assert.equal(body.tasks.length, 6);
  assert.equal(body.task_categories.length, 5);
});

test("browser bootstrap does not write the user row when D1 is bound", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/bootstrap"),
    {
      ...devEnv,
      DB: readOnlyBootstrapDb()
    }
  );
  const body = (await response.json()) as { connectors: unknown[]; tasks: unknown[]; task_categories: unknown[] };

  assert.equal(response.status, 200);
  assert.equal(body.connectors.length, 0);
  assert.equal(body.tasks.length, 0);
  assert.equal(body.task_categories.length, 5);
});

test("agent bootstrap rejects invalid secret", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/connector/bootstrap", { method: "POST", body: "{}" }),
    devEnv
  );

  assert.equal(response.status, 401);
});

test("agent bootstrap rejects malformed JSON", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/connector/bootstrap", {
      method: "POST",
      headers: { "x-chaop-bootstrap-secret": "test-bootstrap" },
      body: "{"
    }),
    devEnv
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid JSON request body" });
});

test("agent bootstrap rejects missing connector fields", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/connector/bootstrap", {
      method: "POST",
      headers: { "x-chaop-bootstrap-secret": "test-bootstrap" },
      body: JSON.stringify({})
    }),
    devEnv
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid connector bootstrap payload" });
});

test("agent bootstrap returns connector token", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/connector/bootstrap", {
      method: "POST",
      headers: { "x-chaop-bootstrap-secret": "test-bootstrap" },
      body: JSON.stringify({
        connector_name: "mac-studio",
        hostname: "mac-studio.local",
        workspace_root: "/workspace",
        capabilities: ["placeholder"]
      })
    }),
    devEnv
  );
  const body = (await response.json()) as { connector_id: string; token: string; control_url: string };

  assert.equal(response.status, 201);
  assert.equal(body.connector_id, "connector-mac-studio-mac-studio-local");
  assert.equal(body.token.startsWith("chaop_agent_"), true);
  assert.equal(body.control_url, "wss://api.example.com/ws/agent");
});

test("agent bootstrap does not expose the old /api/agent/bootstrap path", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/agent/bootstrap", {
      method: "POST",
      headers: { "x-chaop-bootstrap-secret": "test-bootstrap" },
      body: JSON.stringify({
        connector_name: "mac-studio",
        hostname: "mac-studio.local",
        workspace_root: "/workspace",
        capabilities: ["placeholder"]
      })
    }),
    devEnv
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});

test("agent bootstrap returns local websocket URL in insecure local dev", async () => {
  const response = await handleRequest(
    new Request("http://127.0.0.1:8787/connector/bootstrap", {
      method: "POST",
      headers: { "x-chaop-bootstrap-secret": "test-bootstrap" },
      body: JSON.stringify({
        connector_name: "mac-studio",
        hostname: "mac-studio.local",
        workspace_root: "/workspace",
        capabilities: ["placeholder"]
      })
    }),
    devEnv
  );
  const body = (await response.json()) as { control_url: string };

  assert.equal(response.status, 201);
  assert.equal(body.control_url, "ws://127.0.0.1:8787/ws/agent");
});

test("agent bootstrap returns stable connector ids for repeated names", async () => {
  const body = JSON.stringify({
    connector_name: "mac-studio",
    hostname: "mac-studio.local",
    workspace_root: "/workspace",
    capabilities: ["placeholder"]
  });
  const first = await handleRequest(
    new Request("https://api.example.com/connector/bootstrap", {
      method: "POST",
      headers: { "x-chaop-bootstrap-secret": "test-bootstrap" },
      body
    }),
    devEnv
  );
  const second = await handleRequest(
    new Request("https://api.example.com/connector/bootstrap", {
      method: "POST",
      headers: { "x-chaop-bootstrap-secret": "test-bootstrap" },
      body
    }),
    devEnv
  );

  assert.equal(
    ((await first.json()) as { connector_id: string }).connector_id,
    ((await second.json()) as { connector_id: string }).connector_id
  );
});

test("agent websocket accepts bootstrap-issued connector token before Durable Object routing", async () => {
  const bootstrapResponse = await handleRequest(
    new Request("https://api.example.com/connector/bootstrap", {
      method: "POST",
      headers: { "x-chaop-bootstrap-secret": "test-bootstrap" },
      body: JSON.stringify({
        connector_name: "mac-studio",
        hostname: "mac-studio.local",
        workspace_root: "/workspace",
        capabilities: ["placeholder"]
      })
    }),
    devEnv
  );
  const bootstrapBody = (await bootstrapResponse.json()) as { token: string };

  const response = await handleRequest(
    new Request("https://api.example.com/ws/agent", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${bootstrapBody.token}`
      }
    }),
    devEnv
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Workspace Durable Object binding is unavailable" });
});

test("agent websocket reports unavailable token store outside dev mode", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/ws/agent", {
      headers: {
        upgrade: "websocket",
        authorization: "Bearer chaop_agent_prod-shaped"
      }
    }),
    { AGENT_BOOTSTRAP_SECRET: "test-bootstrap" }
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Connector token store is unavailable" });
});

test("agent websocket rejects unsigned token-shaped values", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/ws/agent", {
      headers: {
        upgrade: "websocket",
        authorization: "Bearer chaop_agent_not-signed"
      }
    }),
    devEnv
  );

  assert.equal(response.status, 401);
});

test("agent websocket rejects malformed signed-looking token values", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/ws/agent", {
      headers: {
        upgrade: "websocket",
        authorization: "Bearer chaop_agent_%%%.sig"
      }
    }),
    devEnv
  );

  assert.equal(response.status, 401);
});

test("browser websocket rejects unconfigured origins before routing", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/ws/browser", {
      headers: {
        upgrade: "websocket",
        origin: "https://unknown.example.com"
      }
    }),
    devEnv
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Disallowed browser origin" });
});

test("command creation returns accepted placeholder command", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      headers: {
        "content-type": "text/plain; charset=utf-8"
      },
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        prompt: "Summarise current errors"
      })
    }),
    devEnv
  );
  const body = (await response.json()) as { accepted: boolean; command: { type: string; state: string } };

  assert.equal(response.status, 202);
  assert.equal(body.accepted, true);
  assert.equal(body.command.type, "placeholder");
  assert.equal(body.command.state, "pending");
});

test("command creation preserves requested codex command type", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      headers: {
        "content-type": "text/plain; charset=utf-8"
      },
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        type: "codex",
        prompt: "Say exactly: chaop-smoke"
      })
    }),
    devEnv
  );
  const body = (await response.json()) as { command: { type: string; state: string } };

  assert.equal(response.status, 202);
  assert.equal(body.command.type, "codex");
  assert.equal(body.command.state, "pending");
});

test("command creation rejects unknown command type", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        type: "shell",
        prompt: "Summarise current errors"
      })
    }),
    devEnv
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid command payload" });
});

test("command creation accepts executable target connectors when D1 is bound", async () => {
  const envWithExecutableConnector: Env = {
    ...devEnv,
    DB: commandTargetDb({ id: "connector-online" })
  };
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        prompt: "Summarise current errors",
        target_connector_id: "connector-online"
      })
    }),
    envWithExecutableConnector
  );
  const body = (await response.json()) as { command: { target_connector_id?: string } };

  assert.equal(response.status, 202);
  assert.equal(body.command.target_connector_id, "connector-online");
});

test("command creation preserves codex type for capable target connectors when D1 is bound", async () => {
  const envWithExecutableConnector: Env = {
    ...devEnv,
    DB: commandTargetDb({ id: "connector-online" })
  };
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        type: "codex",
        prompt: "Say exactly: chaop-smoke",
        target_connector_id: "connector-online"
      })
    }),
    envWithExecutableConnector
  );
  const body = (await response.json()) as { command: { target_connector_id?: string; type: string } };

  assert.equal(response.status, 202);
  assert.equal(body.command.type, "codex");
  assert.equal(body.command.target_connector_id, "connector-online");
});

test("command creation targets the connector that owns an attached host session", async () => {
  const envWithAttachedSession: Env = {
    ...devEnv,
    DB: commandTargetDb(
      { id: "connector-online" },
      { attachedThreadConnectorId: "connector-attached", attachedThreadAppServerPresent: true }
    )
  };
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        type: "codex",
        prompt: "Continue the attached session"
      })
    }),
    envWithAttachedSession
  );
  const body = (await response.json()) as { command: { target_connector_id?: string; type: string } };

  assert.equal(response.status, 202);
  assert.equal(body.command.type, "codex");
  assert.equal(body.command.target_connector_id, "connector-attached");
});

test("command creation accepts attached app-server commands without codex_exec capability", async () => {
  const envWithAttachedSession: Env = {
    ...devEnv,
    DB: commandTargetDb(
      { id: "connector-online" },
      {
        attachedThreadConnectorId: "connector-attached",
        attachedThreadAppServerPresent: true,
        supportsCodex: false,
        supportsAppServerExec: true
      }
    )
  };
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        type: "codex",
        prompt: "Continue the attached app-server session"
      })
    }),
    envWithAttachedSession
  );
  const body = (await response.json()) as { command: { target_connector_id?: string; type: string } };

  assert.equal(response.status, 202);
  assert.equal(body.command.type, "codex");
  assert.equal(body.command.target_connector_id, "connector-attached");
});

test("command creation rejects explicit targets that do not own an attached host session", async () => {
  const envWithAttachedSession: Env = {
    ...devEnv,
    DB: commandTargetDb(
      { id: "connector-online" },
      { attachedThreadConnectorId: "connector-attached" }
    )
  };
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        prompt: "Summarise current errors",
        target_connector_id: "connector-online"
      })
    }),
    envWithAttachedSession
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "Target connector does not own the attached host session"
  });
});

test("command creation rejects attached app-server commands when the owner lacks app-server execution", async () => {
  const envWithAttachedSession: Env = {
    ...devEnv,
    DB: commandTargetDb(
      { id: "connector-online" },
      {
        attachedThreadConnectorId: "connector-attached",
        attachedThreadAppServerPresent: true,
        supportsAppServerExec: false
      }
    )
  };
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        type: "codex",
        prompt: "Continue the attached app-server session"
      })
    }),
    envWithAttachedSession
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Target connector not available" });
});

test("command creation rejects codex target connectors without codex_exec capability", async () => {
  const envWithPlaceholderConnector: Env = {
    ...devEnv,
    DB: commandTargetDb({ id: "connector-online" }, { supportsCodex: false })
  };
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        type: "codex",
        prompt: "Say exactly: chaop-smoke",
        target_connector_id: "connector-online"
      })
    }),
    envWithPlaceholderConnector
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Target connector not available" });
});

test("command creation rejects unavailable target connectors when D1 is bound", async () => {
  const envWithMissingConnector: Env = {
    ...devEnv,
    DB: commandTargetDb(null)
  };
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        prompt: "Summarise current errors",
        target_connector_id: "connector-missing"
      })
    }),
    envWithMissingConnector
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Target connector not available" });
});

test("command creation rejects threads outside the requested workspace", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        prompt: "Summarise current errors",
        target_connector_id: "connector-online"
      })
    }),
    {
      ...devEnv,
      DB: commandTargetDb({ id: "connector-online" }, { threadWorkspaceId: "workspace-docs" })
    }
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Command thread not available" });
});

test("command creation rejects tasks outside the selected thread", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        task_id: "task-other-thread",
        prompt: "Summarise current errors",
        target_connector_id: "connector-online"
      })
    }),
    {
      ...devEnv,
      DB: commandTargetDb({ id: "connector-online" }, { taskThreadId: "thread-other" })
    }
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Command task does not belong to the selected thread" });
});

test("command creation rejects missing prompt", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api"
      })
    }),
    devEnv
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid command payload" });
});

test("command creation rejects empty optional ids", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "",
        task_id: "",
        target_connector_id: "",
        prompt: "Summarise current errors"
      })
    }),
    devEnv
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid command payload" });
});

function readOnlyBootstrapDb(): D1Database {
  return {
    prepare(sql: string) {
      assert.doesNotMatch(sql, /INSERT INTO users/);
      if (/FROM host_sessions hs/.test(sql)) {
        assert.match(sql, /INNER JOIN connectors c ON c\.id = hs\.connector_id/);
        assert.match(sql, /c\.status <> 'offline'/);
        assert.match(sql, /hs\.attached_task_id IS NOT NULL OR hs\.attached_thread_id IS NOT NULL/);
      }
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: [] };
        }
      };
    }
  } as unknown as D1Database;
}

function commandTargetDb(
  row: { id: string } | null,
  options: {
    supportsCodex?: boolean;
    threadWorkspaceId?: string;
    taskWorkspaceId?: string;
    taskThreadId?: string;
    attachedTaskConnectorId?: string;
    attachedThreadConnectorId?: string;
    attachedTaskAppServerPresent?: boolean;
    attachedThreadAppServerPresent?: boolean;
    supportsAppServerExec?: boolean;
  } = {}
): D1Database {
  const supportsCodex = options.supportsCodex ?? true;
  const supportsAppServerExec = options.supportsAppServerExec ?? true;
  const threadWorkspaceId = options.threadWorkspaceId ?? "workspace-api";
  const taskWorkspaceId = options.taskWorkspaceId ?? "workspace-api";
  const taskThreadId = options.taskThreadId ?? "thread-orders-500";
  const attachedTaskConnectorId = options.attachedTaskConnectorId;
  const attachedThreadConnectorId = options.attachedThreadConnectorId;
  const attachedTaskAppServerPresent = options.attachedTaskAppServerPresent ?? false;
  const attachedThreadAppServerPresent = options.attachedThreadAppServerPresent ?? false;
  return {
    prepare(sql: string) {
      if (/INSERT INTO users/.test(sql)) {
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

      if (/SELECT id FROM workspaces/.test(sql)) {
        return {
          bind(workspaceId: string) {
            assert.equal(workspaceId, "workspace-api");
            return {
              async first() {
                return { id: workspaceId };
              }
            };
          }
        };
      }

      if (/SELECT id, workspace_id FROM threads/.test(sql)) {
        return {
          bind(threadId: string) {
            return {
              async first() {
                return { id: threadId, workspace_id: threadWorkspaceId };
              }
            };
          }
        };
      }

      if (/SELECT id, workspace_id, thread_id FROM tasks/.test(sql)) {
        return {
          bind(taskId: string) {
            return {
              async first() {
                return {
                  id: taskId,
                  workspace_id: taskWorkspaceId,
                  thread_id: taskThreadId
                };
              }
            };
          }
        };
      }

      if (/SELECT hs\.connector_id/.test(sql) && /hs\.attached_task_id = \?/.test(sql)) {
        return {
          bind(workspaceId: string, taskId: string) {
            assert.equal(workspaceId, "workspace-api");
            assert.equal(taskId.startsWith("task-"), true);
            return {
              async first() {
                return attachedTaskConnectorId
                  ? {
                    connector_id: attachedTaskConnectorId,
                    app_server_present: attachedTaskAppServerPresent ? 1 : 0
                  }
                  : null;
              }
            };
          }
        };
      }

      if (/SELECT hs\.connector_id/.test(sql) && /hs\.attached_thread_id = \?/.test(sql)) {
        return {
          bind(workspaceId: string, threadId: string) {
            assert.equal(workspaceId, "workspace-api");
            assert.equal(threadId, "thread-orders-500");
            return {
              async first() {
                return attachedThreadConnectorId
                  ? {
                    connector_id: attachedThreadConnectorId,
                    app_server_present: attachedThreadAppServerPresent ? 1 : 0
                  }
                  : null;
              }
            };
          }
        };
      }

      if (/SELECT c\.id/.test(sql) && /WHERE c\.id = \?/.test(sql)) {
        assert.match(sql, /workspace_connectors/);
        assert.match(sql, /wc\.workspace_id = \?/);
        assert.match(sql, /wc\.can_execute = 1/);
        assert.match(sql, /c\.status <> 'offline'/);
        assert.match(sql, /capabilities_json LIKE/);
        return {
          bind(
            connectorId: string,
            workspaceId: string,
            commandType: string,
            requireAppServerExecForAppServer?: number,
            requireAppServerExecForCodexExec?: number
          ) {
            assert.equal(connectorId.startsWith("connector-"), true);
            assert.equal(workspaceId, "workspace-api");
            assert.equal(commandType === "placeholder" || commandType === "codex", true);
            assert.equal(
              requireAppServerExecForAppServer === undefined
              || requireAppServerExecForAppServer === 0
              || requireAppServerExecForAppServer === 1,
              true
            );
            assert.equal(
              requireAppServerExecForCodexExec === undefined
              || requireAppServerExecForCodexExec === 0
              || requireAppServerExecForCodexExec === 1,
              true
            );
            assert.equal(requireAppServerExecForAppServer, requireAppServerExecForCodexExec);
            return {
              async first() {
                if (commandType === "codex" && requireAppServerExecForAppServer === 1) {
                  return row && supportsAppServerExec ? { id: connectorId } : null;
                }
                if (commandType === "codex" && !supportsCodex) {
                  return null;
                }
                return row ? { id: connectorId } : null;
              }
            };
          }
        };
      }

      if (/SELECT last_seq/.test(sql)) {
        throw new Error("appendEvent must allocate event sequence with UPDATE ... RETURNING");
      }

      if (/UPDATE threads/.test(sql) && /RETURNING last_seq/.test(sql)) {
        return {
          bind(updatedAt: string, threadId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(threadId, "thread-orders-500");
            return {
              async first() {
                return { last_seq: 1 };
              }
            };
          }
        };
      }

      if (/INSERT INTO commands/.test(sql) || /INSERT INTO events/.test(sql)) {
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

      if (/UPDATE tasks/.test(sql) && /WHERE id = \? AND workspace_id = \? AND thread_id = \?/.test(sql)) {
        return {
          bind(connectorId: string, updatedAt: string, taskId: string, workspaceId: string, threadId: string) {
            assert.equal(connectorId, "connector-online");
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(taskId.startsWith("task-"), true);
            assert.equal(workspaceId, "workspace-api");
            assert.equal(threadId, "thread-orders-500");
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      if (/SELECT COUNT\(\*\) AS active_count/.test(sql) || /UPDATE connectors/.test(sql)) {
        return {
          bind() {
            return {
              async first() {
                return { active_count: 0 };
              },
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    }
  } as unknown as D1Database;
}

function localThreadCreateDb(): D1Database & { readonly userWrites: number; readonly syncWrites: number } {
  const sessions = new Map<string, Record<string, unknown>>();
  let threadRow: Record<string, unknown> | undefined;
  let taskRow: Record<string, unknown> | undefined;
  const counters = {
    userWrites: 0,
    syncWrites: 0
  };

  const db = {
    prepare(sql: string) {
      if (/INSERT INTO users/.test(sql)) {
        return {
          bind(userId: string, email: string, name: string) {
            assert.equal(userId, "user-operator-example-com");
            assert.equal(email, "operator@example.com");
            assert.equal(name, "operator");
            return {
              async run() {
                counters.userWrites += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/SELECT id FROM workspaces/.test(sql)) {
        return {
          bind(workspaceId: string) {
            assert.equal(workspaceId, "workspace-api");
            return {
              async first() {
                return { id: workspaceId };
              }
            };
          }
        };
      }

      if (/SELECT c\.id/.test(sql) && /app_server_threads/.test(sql)) {
        assert.match(sql, /workspace_connectors/);
        assert.match(sql, /wc\.can_execute = 1/);
        assert.match(sql, /c\.status <> 'offline'/);
        assert.match(sql, /capabilities_json LIKE/);
        return {
          bind(workspaceId: string) {
            assert.equal(workspaceId, "workspace-api");
            return {
              async first() {
                return { id: "connector-online" };
              }
            };
          }
        };
      }

      if (/SELECT hostname/.test(sql) && /FROM connectors/.test(sql)) {
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

      if (/SELECT workspace_id/.test(sql) && /FROM workspace_connectors/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return { workspace_id: "workspace-other" };
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
            discoveredAt: string,
            updatedAt: string
          ) {
            assert.equal(id, "host-session-session-created-1-connector-online");
            assert.equal(connectorId, "connector-online");
            assert.equal(hostname, "mac-studio.local");
            assert.equal(workspaceId, "workspace-api");
            assert.equal(sessionId, "session-created-1");
            assert.equal(title, "Investigate retry loop");
            assert.equal(titleSource, "app_server");
            assert.equal(appServerPresent, 1);
            assert.equal(cwd, "/workspace/codex");
            assert.match(discoveredAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(updatedAt, "2026-06-12T11:24:03.000Z");
            return {
              async run() {
                sessions.set(sessionId, {
                  id,
                  connector_id: connectorId,
                  hostname,
                  workspace_id: workspaceId,
                  session_id: sessionId,
                  title,
                  title_source: titleSource,
                  app_server_present: appServerPresent,
                  cwd,
                  attached_task_id: null,
                  attached_thread_id: null,
                  updated_at: updatedAt
                });
                return { success: true };
              }
            };
          }
        };
      }

      if (/SELECT hs\.id, hs\.connector_id/.test(sql) && /FROM host_sessions hs/.test(sql)) {
        assert.match(sql, /INNER JOIN connectors c ON c\.id = hs\.connector_id/);
        assert.match(sql, /c\.status <> 'offline'/);
        return {
          bind(sessionId: string, connectorId: string) {
            assert.equal(sessionId, "session-created-1");
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return sessions.get(sessionId);
              }
            };
          }
        };
      }

      if (/INSERT INTO host_session_syncs/.test(sql)) {
        return {
          bind(connectorId: string, syncedAt: string, reported: number, stored: number) {
            assert.equal(connectorId, "connector-online");
            assert.match(syncedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(reported, 1);
            assert.equal(stored, 1);
            return {
              async run() {
                counters.syncWrites += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /last_seen_at/.test(sql)) {
        return {
          bind(lastSeenAt: string, updatedAt: string, connectorId: string) {
            assert.match(lastSeenAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      if (/capabilities_json/.test(sql) && /FROM connectors/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return { capabilities_json: JSON.stringify(["host_session_backfill_v2"]) };
              }
            };
          }
        };
      }

      if (/INSERT INTO threads/.test(sql)) {
        return {
          bind(threadId: string, workspaceId: string, title: string, createdAt: string, updatedAt: string) {
            assert.equal(threadId, "thread-host-session-created-1-connector-online");
            assert.equal(workspaceId, "workspace-api");
            assert.equal(title, "Investigate retry loop");
            assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            return {
              async run() {
                threadRow = {
                  id: threadId,
                  workspace_id: workspaceId,
                  title,
                  state: "idle",
                  realtime_mode: "realtime",
                  last_seq: 0,
                  updated_at: updatedAt
                };
                return { success: true };
              }
            };
          }
        };
      }

      if (/INSERT INTO tasks/.test(sql)) {
        return {
          bind(
            taskId: string,
            workspaceId: string,
            threadId: string,
            title: string,
            connectorId: string,
            createdAt: string,
            updatedAt: string
          ) {
            assert.equal(taskId, "task-host-session-created-1-connector-online");
            assert.equal(workspaceId, "workspace-api");
            assert.equal(threadId, "thread-host-session-created-1-connector-online");
            assert.equal(title, "Investigate retry loop");
            assert.equal(connectorId, "connector-online");
            assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            return {
              async run() {
                taskRow = {
                  id: taskId,
                  workspace_id: workspaceId,
                  thread_id: threadId,
                  title,
                  category_id: "maintenance",
                  state: "idle",
                  connector_id: connectorId,
                  assigned_agent: "chaop-agent",
                  realtime_mode: "realtime",
                  budget_state: "normal",
                  archived_at: null,
                  updated_at: updatedAt
                };
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE host_sessions/.test(sql) && /attached_task_id = \?/.test(sql)) {
        return {
          bind(taskId: string, threadId: string, updatedAt: string, hostSessionId: string) {
            assert.equal(taskId, "task-host-session-created-1-connector-online");
            assert.equal(threadId, "thread-host-session-created-1-connector-online");
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(hostSessionId, "host-session-session-created-1-connector-online");
            return {
              async run() {
                const session = sessions.get("session-created-1");
                if (session) {
                  session.attached_task_id = taskId;
                  session.attached_thread_id = threadId;
                  session.updated_at = updatedAt;
                }
                return { success: true };
              }
            };
          }
        };
      }

      if (/SELECT id, workspace_id, thread_id, title, category_id/.test(sql) && /FROM tasks/.test(sql)) {
        return {
          bind(taskId: string) {
            assert.equal(taskId, "task-host-session-created-1-connector-online");
            return {
              async first() {
                return taskRow;
              }
            };
          }
        };
      }

      if (/SELECT id, workspace_id, title, state, last_seq/.test(sql) && /FROM threads/.test(sql)) {
        return {
          bind(threadId: string) {
            assert.equal(threadId, "thread-host-session-created-1-connector-online");
            return {
              async first() {
                return threadRow;
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get userWrites() {
      return counters.userWrites;
    },
    get syncWrites() {
      return counters.syncWrites;
    }
  };

  return db as D1Database & { readonly userWrites: number; readonly syncWrites: number };
}

function taskArchiveSyncDb(
  options: {
    connectorStatus?: string | undefined;
    initialArchivedAt?: string | null | undefined;
    supportsArchive?: boolean | undefined;
    supportsAppServerThreads?: boolean | undefined;
    titleSource?: string | undefined;
    appServerPresent?: boolean | undefined;
  } = {}
): D1Database & { readonly taskArchiveWrites: number; readonly threadArchiveWrites: number } {
  const connectorStatus = options.connectorStatus ?? "online";
  const supportsArchive = options.supportsArchive ?? true;
  const supportsAppServerThreads = options.supportsAppServerThreads ?? false;
  const titleSource = options.titleSource ?? "app_server";
  const appServerPresent = options.appServerPresent ?? true;
  const taskRow: {
    id: string;
    workspace_id: string;
    thread_id: string;
    title: string;
    category_id: string;
    state: string;
    connector_id: string;
    assigned_agent: string;
    realtime_mode: string;
    budget_state: string;
    archived_at: string | null;
    updated_at: string;
  } = {
    id: "task-host-1",
    workspace_id: "workspace-api",
    thread_id: "thread-host-1",
    title: "Existing session",
    category_id: "maintenance",
    state: "idle",
    connector_id: "connector-online",
    assigned_agent: "chaop-agent",
    realtime_mode: "realtime",
    budget_state: "normal",
    archived_at: options.initialArchivedAt ?? null,
    updated_at: "2026-06-12T10:00:00.000Z"
  };
  const hostSession = {
    id: "host-session-1",
    connector_id: "connector-online",
    hostname: "mac-studio.local",
    workspace_id: "workspace-api",
    session_id: "thread-1",
    title: "Existing session",
    title_source: titleSource,
    app_server_present: appServerPresent ? 1 : 0,
    cwd: "/workspace/project",
    updated_at: "2026-06-12T10:00:00.000Z",
    attached_task_id: "task-host-1",
    attached_thread_id: "thread-host-1"
  };
  const counters = {
    taskArchiveWrites: 0,
    threadArchiveWrites: 0
  };

  const db = {
    prepare(sql: string) {
      if (/FROM host_sessions hs/.test(sql) && /hs\.attached_task_id = \?/.test(sql)) {
        return {
          bind(taskId: string) {
            assert.equal(taskId, "task-host-1");
            return {
              async first() {
                return hostSession;
              }
            };
          }
        };
      }

      if (/capabilities_json/.test(sql) && /FROM connectors/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                const capabilities = [];
                if (supportsArchive) capabilities.push("app_server_archive");
                if (supportsAppServerThreads) capabilities.push("app_server_threads");
                return {
                  status: connectorStatus,
                  capabilities_json: JSON.stringify(capabilities)
                };
              }
            };
          }
        };
      }

      if (/SELECT id, workspace_id, thread_id, title, category_id/.test(sql) && /FROM tasks/.test(sql)) {
        return {
          bind(taskId: string) {
            assert.equal(taskId, "task-host-1");
            return {
              async first() {
                return taskRow;
              }
            };
          }
        };
      }

      if (/UPDATE tasks/.test(sql) && /SET archived_at = \?/.test(sql)) {
        return {
          bind(archivedAt: string, updatedAt: string, taskId: string) {
            assert.match(archivedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(updatedAt, archivedAt);
            assert.equal(taskId, "task-host-1");
            return {
              async run() {
                counters.taskArchiveWrites += 1;
                taskRow.archived_at = archivedAt;
                taskRow.updated_at = updatedAt;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE tasks/.test(sql) && /SET archived_at = NULL/.test(sql)) {
        return {
          bind(updatedAt: string, taskId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(taskId, "task-host-1");
            return {
              async run() {
                counters.taskArchiveWrites += 1;
                taskRow.archived_at = null;
                taskRow.updated_at = updatedAt;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE threads/.test(sql) && /SET state = 'archived'/.test(sql)) {
        return {
          bind(updatedAt: string, threadId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(threadId, "thread-host-1");
            return {
              async run() {
                counters.threadArchiveWrites += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE threads/.test(sql) && /SET state = \?/.test(sql)) {
        return {
          bind(state: string, updatedAt: string, threadId: string) {
            assert.equal(state, "idle");
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(threadId, "thread-host-1");
            return {
              async run() {
                counters.threadArchiveWrites += 1;
                return { success: true };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get taskArchiveWrites() {
      return counters.taskArchiveWrites;
    },
    get threadArchiveWrites() {
      return counters.threadArchiveWrites;
    }
  };

  return db as D1Database & { readonly taskArchiveWrites: number; readonly threadArchiveWrites: number };
}

function hostSessionAttachBackfillDb(
  options: { supportsBackfill?: boolean | undefined; alreadyAttached?: boolean | undefined } = {}
): D1Database & { readonly eventInserts: number } {
  const supportsBackfill = options.supportsBackfill ?? true;
  const threadId = "thread-host-session-1-connector-online";
  const taskId = "task-host-session-1-connector-online";
  const session = {
    id: "host-session-1",
    connector_id: "connector-online",
    hostname: "mac-studio.local",
    workspace_id: "workspace-api",
    session_id: "session-1",
    title: "Existing session",
    title_source: "metadata",
    cwd: "/workspace/project",
    attached_task_id: options.alreadyAttached ? taskId : null as string | null,
    attached_thread_id: options.alreadyAttached ? threadId : null as string | null,
    updated_at: "2026-06-12T10:00:00.000Z"
  };
  let threadRow: Record<string, unknown> | undefined = options.alreadyAttached
    ? {
      id: threadId,
      workspace_id: "workspace-api",
      title: "Existing session",
      state: "idle",
      realtime_mode: "realtime",
      last_seq: 3,
      updated_at: "2026-06-12T10:00:00.000Z"
    }
    : undefined;
  let taskRow: Record<string, unknown> | undefined = options.alreadyAttached
    ? {
      id: taskId,
      workspace_id: "workspace-api",
      thread_id: threadId,
      title: "Existing session",
      category_id: "maintenance",
      state: "idle",
      connector_id: "connector-online",
      assigned_agent: "chaop-agent",
      realtime_mode: "realtime",
      budget_state: "normal",
      archived_at: null,
      updated_at: "2026-06-12T10:00:00.000Z"
    }
    : undefined;
  let eventInsertCount = 0;
  let sequenceUpdates = 0;
  const insertedEvents = new Set<string>();

  const db = {
    prepare(sql: string) {
      if (/SELECT hs\.id, hs\.connector_id/.test(sql) && /FROM host_sessions hs/.test(sql)) {
        return {
          bind(sessionId: string, connectorId: string) {
            assert.equal(sessionId, "session-1");
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return session;
              }
            };
          }
        };
      }

      if (/SELECT capabilities_json/.test(sql) && /FROM connectors/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return {
                  capabilities_json: JSON.stringify(supportsBackfill ? ["host_session_backfill_v2"] : [])
                };
              }
            };
          }
        };
      }

      if (/INSERT INTO threads/.test(sql)) {
        return {
          bind(threadId: string, workspaceId: string, title: string, createdAt: string, updatedAt: string) {
            assert.equal(threadId, "thread-host-session-1-connector-online");
            assert.equal(workspaceId, "workspace-api");
            assert.equal(title, "Existing session");
            assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            return {
              async run() {
                threadRow = {
                  id: threadId,
                  workspace_id: workspaceId,
                  title,
                  state: "idle",
                  realtime_mode: "realtime",
                  last_seq: 0,
                  updated_at: updatedAt
                };
                return { success: true };
              }
            };
          }
        };
      }

      if (/INSERT INTO tasks/.test(sql)) {
        return {
          bind(
            taskId: string,
            workspaceId: string,
            threadId: string,
            title: string,
            connectorId: string,
            createdAt: string,
            updatedAt: string
          ) {
            assert.equal(taskId, "task-host-session-1-connector-online");
            assert.equal(workspaceId, "workspace-api");
            assert.equal(threadId, "thread-host-session-1-connector-online");
            assert.equal(title, "Existing session");
            assert.equal(connectorId, "connector-online");
            assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            return {
              async run() {
                taskRow = {
                  id: taskId,
                  workspace_id: workspaceId,
                  thread_id: threadId,
                  title,
                  category_id: "maintenance",
                  state: "idle",
                  connector_id: connectorId,
                  assigned_agent: "chaop-agent",
                  realtime_mode: "realtime",
                  budget_state: "normal",
                  archived_at: null,
                  updated_at: updatedAt
                };
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE host_sessions/.test(sql) && /attached_task_id = \?/.test(sql)) {
        return {
          bind(taskId: string, threadId: string, updatedAt: string, hostSessionId: string) {
            assert.equal(taskId, "task-host-session-1-connector-online");
            assert.equal(threadId, "thread-host-session-1-connector-online");
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(hostSessionId, "host-session-1");
            return {
              async run() {
                session.attached_task_id = taskId;
                session.attached_thread_id = threadId;
                session.updated_at = updatedAt;
                return { success: true };
              }
            };
          }
        };
      }

      if (/SELECT id, workspace_id, thread_id, title, category_id/.test(sql) && /FROM tasks/.test(sql)) {
        return {
          bind(taskId: string) {
            assert.equal(taskId, "task-host-session-1-connector-online");
            return {
              async first() {
                return taskRow;
              }
            };
          }
        };
      }

      if (/SELECT id, workspace_id, title, state, last_seq/.test(sql) && /FROM threads/.test(sql)) {
        return {
          bind(threadId: string) {
            assert.equal(threadId, "thread-host-session-1-connector-online");
            return {
              async first() {
                return threadRow;
              }
            };
          }
        };
      }

      if (/SELECT id FROM events WHERE id = \? LIMIT 1/.test(sql)) {
        return {
          bind(eventId: string) {
            return {
              async first() {
                return insertedEvents.has(eventId) ? { id: eventId } : null;
              }
            };
          }
        };
      }

      if (/UPDATE threads/.test(sql) && /RETURNING last_seq/.test(sql)) {
        return {
          bind(updatedAt: string, threadId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(threadId, "thread-host-session-1-connector-online");
            return {
              async first() {
                sequenceUpdates += 1;
                return { last_seq: sequenceUpdates };
              }
            };
          }
        };
      }

      if (/INSERT OR IGNORE INTO events/.test(sql)) {
        return {
          bind(
            eventId: string,
            workspaceId: string,
            threadId: string,
            seq: number,
            kind: string,
            priority: string,
            summary: string,
            idempotencyKey: string,
            createdAt: string
          ) {
            assert.match(eventId, /^event-backfill-session-1-/);
            assert.equal(workspaceId, "workspace-api");
            assert.equal(threadId, "thread-host-session-1-connector-online");
            assert.ok(seq >= 1 && seq <= 30);
            assert.equal(kind, "command.output");
            assert.equal(priority, "P3");
            assert.match(summary, /^2026-06-12 10:\d{2} - User: Event \d+$/);
            assert.match(idempotencyKey, /^rollout:session-1:\d+$/);
            assert.match(createdAt, /^2026-06-12T10:\d{2}:00\.000Z$/);
            return {
              async run() {
                insertedEvents.add(eventId);
                eventInsertCount += 1;
                return { success: true, meta: { changes: 1 } };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get eventInserts() {
      return eventInsertCount;
    }
  };

  return db as D1Database & { readonly eventInserts: number };
}

function hostSessionDetachDb(): D1Database {
  const row = {
    id: "host-session-1",
    connector_id: "connector-online",
    hostname: "mac-studio.local",
    workspace_id: "workspace-api",
    session_id: "session-1",
    title: "Attached session",
    title_source: "history",
    cwd: "/workspace/project",
    updated_at: "2026-06-12T10:00:00.000Z",
    attached_task_id: "task-host-1",
    attached_thread_id: "thread-host-1"
  };

  return {
    prepare(sql: string) {
      if (/FROM host_sessions hs/.test(sql) && /WHERE hs\.session_id = \? AND hs\.connector_id = \?/.test(sql)) {
        assert.match(sql, /INNER JOIN connectors c ON c\.id = hs\.connector_id/);
        assert.match(sql, /c\.status <> 'offline'/);
        return {
          bind(sessionId: string, connectorId: string) {
            assert.equal(sessionId, "session-1");
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                return row;
              }
            };
          }
        };
      }

      if (/UPDATE host_sessions/.test(sql) && /attached_task_id = NULL/.test(sql)) {
        return {
          bind(updatedAt: string, hostSessionId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(hostSessionId, "host-session-1");
            row.updated_at = updatedAt;
            row.attached_task_id = null as unknown as string;
            row.attached_thread_id = null as unknown as string;
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    }
  } as unknown as D1Database;
}
