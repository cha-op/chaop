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

test("task archive warns when attached connector is degraded", async () => {
  const db = taskArchiveSyncDb({ connectorStatus: "degraded" });
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
    error: "Connector is not ready"
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

test("host session attach resumes available app-server session before attachment", async () => {
  let internalPath = "";
  let dispatchBody: Record<string, unknown> | undefined;
  const db = hostSessionAttachBackfillDb({ supportsAppServer: true, supportsBackfill: false });
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
                session: {
                  session_id: "session-1",
                  title: "Recovered app-server title",
                  title_source: "app_server",
                  app_server_present: true,
                  cwd: "/workspace/project",
                  updated_at: "2026-06-12T10:05:00.000Z"
                }
              }),
              { headers: { "content-type": "application/json; charset=utf-8" } }
            );
          }
        }) as unknown as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as {
    host_session: {
      app_server_present?: boolean;
      title?: string;
      title_source?: string;
      attached_thread_id?: string;
    };
    events?: unknown[];
    backfill?: unknown;
  };

  assert.equal(response.status, 201);
  assert.equal(internalPath, "/internal/ensure-host-session-app-server");
  assert.equal(dispatchBody?.connector_id, "connector-online");
  assert.equal(dispatchBody?.session_id, "session-1");
  assert.equal(dispatchBody?.title, "Existing session");
  assert.equal(dispatchBody?.cwd, "/workspace/project");
  assert.equal(body.host_session.attached_thread_id, "thread-host-session-1-connector-online");
  assert.equal(body.host_session.app_server_present, true);
  assert.equal(body.host_session.title, "Recovered app-server title");
  assert.equal(body.host_session.title_source, "app_server");
  assert.equal(body.events, undefined);
  assert.equal(body.backfill, undefined);
});

test("host session attach reuses the app-server ensured connector when connector id is omitted", async () => {
  const db = hostSessionAttachBackfillDb({ supportsAppServer: true, supportsBackfill: false });
  const response = await handleRequest(
    new Request("https://api.example.com/api/host-sessions/session-1/attach", {
      method: "POST",
      headers: {
        origin: "https://app.example.com"
      },
      body: JSON.stringify({})
    }),
    {
      ...devEnv,
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async () => new Response(
            JSON.stringify({
              session: {
                session_id: "session-1",
                title: "Recovered app-server title",
                title_source: "app_server",
                app_server_present: true,
                cwd: "/workspace/project",
                updated_at: "2026-06-12T10:05:00.000Z"
              }
            }),
            { headers: { "content-type": "application/json; charset=utf-8" } }
          )
        }) as unknown as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );

  assert.equal(response.status, 201);
  assert.deepEqual(db.hostSessionLookupConnectorIds, [
    undefined,
    "connector-online",
    "connector-online",
    "connector-online"
  ]);
});

test("host session attach falls back without the app-server ensure capability", async () => {
  const db = hostSessionAttachBackfillDb({
    supportsAppServer: true,
    supportsAppServerEnsure: false,
    supportsBackfill: false
  });
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
            throw new Error("DO should not receive app-server ensure requests without the ensure capability");
          }
        }) as unknown as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as {
    host_session: {
      app_server_present?: boolean;
      title?: string;
      title_source?: string;
      attached_thread_id?: string;
    };
    events?: unknown[];
    backfill?: unknown;
  };

  assert.equal(response.status, 201);
  assert.equal(body.host_session.attached_thread_id, "thread-host-session-1-connector-online");
  assert.equal(body.host_session.app_server_present, false);
  assert.equal(body.host_session.title, "Existing session");
  assert.equal(body.host_session.title_source, "metadata");
  assert.equal(body.events, undefined);
  assert.equal(body.backfill, undefined);
});

test("host session attach resumes app-server session when stored attachment rows are stale", async () => {
  let internalPath = "";
  const db = hostSessionAttachBackfillDb({
    alreadyAttached: true,
    missingAttachedRows: true,
    supportsAppServer: true,
    supportsBackfill: false
  });
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
          fetch: async (input: RequestInfo | URL) => {
            internalPath = new URL(String(input)).pathname;
            return new Response(
              JSON.stringify({
                session: {
                  session_id: "session-1",
                  title: "Recovered app-server title",
                  title_source: "app_server",
                  app_server_present: true,
                  cwd: "/workspace/project",
                  updated_at: "2026-06-12T10:05:00.000Z"
                }
              }),
              { headers: { "content-type": "application/json; charset=utf-8" } }
            );
          }
        }) as unknown as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as {
    host_session: {
      app_server_present?: boolean;
      title?: string;
      title_source?: string;
      attached_thread_id?: string;
    };
    events?: unknown[];
    backfill?: unknown;
  };

  assert.equal(response.status, 201);
  assert.equal(internalPath, "/internal/ensure-host-session-app-server");
  assert.equal(body.host_session.attached_thread_id, "thread-host-session-1-connector-online");
  assert.equal(body.host_session.app_server_present, true);
  assert.equal(body.host_session.title, "Recovered app-server title");
  assert.equal(body.host_session.title_source, "app_server");
  assert.equal(body.events, undefined);
  assert.equal(body.backfill, undefined);
});

test("host session attach skips backfill when connector is degraded", async () => {
  const db = hostSessionAttachBackfillDb({ connectorStatus: "degraded" });
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
            throw new Error("DO should not receive backfill requests for degraded connectors");
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
  const db = hostSessionAttachBackfillDb({ alreadyAttached: true, supportsAppServer: true });
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
            throw new Error("DO should not receive ensure or backfill requests for existing attachments");
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
  const db = hostSessionDetachDb();
  let internalPath = "";
  let broadcastedEventId = "";
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
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            internalPath = new URL(String(input)).pathname;
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              events?: Array<{ id?: string }>;
            };
            broadcastedEventId = body.events?.[0]?.id ?? "";
            return new Response(JSON.stringify({ broadcasted: body.events?.length ?? 0 }));
          }
        }) as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as {
    host_session: {
      session_id: string;
      attached_task_id?: string;
      attached_thread_id?: string;
    };
    failed_events?: unknown;
  };

  assert.equal(response.status, 200);
  assert.equal(body.host_session.session_id, "session-1");
  assert.equal(body.host_session.attached_task_id, undefined);
  assert.equal(body.host_session.attached_thread_id, undefined);
  assert.equal(db.commandFailures, 1);
  assert.equal(db.taskUpdates, 1);
  assert.equal(db.eventInserts, 1);
  assert.equal(body.failed_events, undefined);
  assert.equal(internalPath, "/internal/broadcast-thread-events");
  assert.match(broadcastedEventId, /^event-/);
});

test("host session detach refreshes connector activity after failing a leased command", async () => {
  const db = hostSessionDetachDb({ detachedCommandState: "leased" });
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
      DB: db
    }
  );

  assert.equal(response.status, 200);
  assert.equal(db.commandFailures, 1);
  assert.equal(db.connectorActivityUpdates, 1);
});

test("host session detach dispatches app-server capable connectors after releasing attached-inferred commands", async () => {
  const db = hostSessionDetachDb({
    releaseDetachedCommands: true,
    returnDetachedCommands: false
  });
  let internalPath = "";
  const dispatchedConnectorIds: string[] = [];
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
      DB: db,
      WORKSPACE_DO: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            internalPath = new URL(String(input)).pathname;
            const body = JSON.parse(String(init?.body ?? "{}")) as { connector_id?: string };
            dispatchedConnectorIds.push(body.connector_id ?? "");
            return new Response("{}");
          }
        }) as DurableObjectStub
      } as unknown as DurableObjectNamespace
    }
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.released_connector_ids, undefined);
  assert.equal(db.commandReleases, 1);
  assert.equal(db.commandFailures, 0);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
  assert.equal(db.connectorActivityUpdates, 1);
  assert.equal(internalPath, "/internal/dispatch-pending");
  assert.deepEqual(dispatchedConnectorIds, ["connector-online", "connector-replacement"]);
});

test("host session detach does not release or fail CLI fallback commands", async () => {
  const db = hostSessionDetachDb({
    detachedCommandState: "leased",
    releaseDetachedCommands: true,
    detachedCommandExecutionMode: "codex_cli_fallback"
  });
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
      DB: db
    }
  );

  assert.equal(response.status, 200);
  assert.equal(db.commandReleases, 0);
  assert.equal(db.commandFailures, 0);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
  assert.equal(db.connectorActivityUpdates, 0);
});

test("host session detach does not release same-session leases owned by a replacement connector", async () => {
  const db = hostSessionDetachDb({
    detachedCommandState: "leased",
    detachedLeaseOwnedByReplacement: true,
    returnDetachedCommands: false
  });
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
      DB: db
    }
  );

  assert.equal(response.status, 200);
  assert.equal(db.commandReleases, 0);
  assert.equal(db.commandFailures, 0);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
  assert.equal(db.connectorActivityUpdates, 0);
});

test("host session detach keeps nullable-target leases owned by another connector", async () => {
  const db = hostSessionDetachDb({ returnDetachedCommands: false });
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
      DB: db
    }
  );

  assert.equal(response.status, 200);
  assert.equal(db.commandFailures, 0);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
});

test("host session detach skips side effects when guarded command failure loses the race", async () => {
  const db = hostSessionDetachDb({ detachedCommandFailureChanges: 0 });
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
      DB: db
    }
  );

  assert.equal(response.status, 200);
  assert.equal(db.commandFailures, 0);
  assert.equal(db.connectorActivityUpdates, 0);
  assert.equal(db.taskUpdates, 0);
  assert.equal(db.eventInserts, 0);
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

test("usage summary returns bounded D1 budget windows", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/usage-summary", {
      headers: {
        origin: "https://app.example.com"
      }
    }),
    {
      ...devEnv,
      DB: budgetSummaryDb()
    }
  );
  const body = (await response.json()) as {
    source: string;
    state: string;
    daily_used_pct: number;
    four_hour_used_pct: number;
    burst_used_pct: number;
    delayed_event_count: number;
    compacted_event_count: number;
    local_spool_bytes: number;
    window_sample_count: number;
    d1_write_model: {
      budgeted_rows_written_per_event: number;
      daily_budget_units: number;
      four_hour_hard_budget_units: number;
      burst_budget_units: number;
      command_lifecycle_with_task_rows_written: number;
    };
    constraint_sample_count: number;
    bottleneck_constraint: {
      id: string;
      used_pct: number;
      remaining_ratio: number;
      remaining_event_capacity: number;
    };
    constraints: Array<{
      id: string;
      sampled: boolean;
      state: string;
      used_pct: number | null;
      remaining_ratio: number | null;
      remaining_event_capacity: number | null;
    }>;
    windows: Array<{
      window_type: string;
      used_pct: number;
      budget_units: number;
      events_received: number;
      estimated_d1_rows_written: number;
      budget_state: string;
    }>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.source, "d1_usage_windows");
  assert.equal(body.state, "throttled");
  assert.equal(body.daily_used_pct, 12);
  assert.equal(body.four_hour_used_pct, 17.3);
  assert.equal(body.burst_used_pct, 2.2);
  assert.equal(body.delayed_event_count, 8);
  assert.equal(body.compacted_event_count, 55);
  assert.equal(body.local_spool_bytes, 4096);
  assert.equal(body.window_sample_count, 3);
  assert.equal(body.constraint_sample_count, 3);
  assert.deepEqual(
    [
      body.d1_write_model.budgeted_rows_written_per_event,
      body.d1_write_model.daily_budget_units,
      body.d1_write_model.four_hour_hard_budget_units,
      body.d1_write_model.burst_budget_units,
      body.d1_write_model.command_lifecycle_with_task_rows_written
    ],
    [12, 8333, 1388, 833, 20]
  );
  assert.deepEqual(
    [
      body.bottleneck_constraint.id,
      body.bottleneck_constraint.used_pct,
      body.bottleneck_constraint.remaining_ratio,
      body.bottleneck_constraint.remaining_event_capacity
    ],
    ["d1_rows_written_four_hour", 17.3, 0.827, 1148]
  );
  assert.deepEqual(
    body.constraints.map((constraint) => [
      constraint.id,
      constraint.sampled,
      constraint.state,
      constraint.used_pct,
      constraint.remaining_ratio,
      constraint.remaining_event_capacity
    ]),
    [
      ["d1_rows_written_daily", true, "normal", 12, 0.88, 7333],
      ["d1_rows_written_four_hour", true, "normal", 17.3, 0.827, 1148],
      ["d1_rows_written_burst", true, "normal", 2.2, 0.978, 815],
      ["worker_requests_daily", false, "missing", null, null, null],
      ["durable_object_requests_daily", false, "missing", null, null, null],
      ["d1_rows_read_daily", false, "missing", null, null, null]
    ]
  );
  assert.deepEqual(
    body.windows.map((window) => [
      window.window_type,
      window.used_pct,
      window.budget_units,
      window.events_received,
      window.estimated_d1_rows_written,
      window.budget_state
    ]),
    [
      ["daily", 12, 8333, 1000, 12000, "normal"],
      ["four_hour", 17.3, 1388, 240, 2880, "normal"],
      ["burst", 2.2, 833, 18, 216, "normal"]
    ]
  );
});

test("usage summary marks missing D1 budget windows as unsampled", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/usage-summary", {
      headers: {
        origin: "https://app.example.com"
      }
    }),
    {
      ...devEnv,
      DB: budgetSummaryDb(["daily", "burst"])
    }
  );
  const body = (await response.json()) as {
    source: string;
    state: string;
    daily_used_pct: number | null;
    four_hour_used_pct: number | null;
    burst_used_pct: number | null;
    window_sample_count: number;
    constraint_sample_count: number;
    bottleneck_constraint: { id: string; remaining_ratio: number };
    constraints: Array<{ id: string; sampled: boolean }>;
    windows: Array<{ window_type: string; used_pct: number; budget_units: number }>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.source, "d1_usage_windows");
  assert.equal(body.state, "throttled");
  assert.equal(body.daily_used_pct, null);
  assert.equal(body.four_hour_used_pct, 17.3);
  assert.equal(body.burst_used_pct, null);
  assert.equal(body.window_sample_count, 1);
  assert.equal(body.constraint_sample_count, 1);
  assert.deepEqual(
    [body.bottleneck_constraint.id, body.bottleneck_constraint.remaining_ratio],
    ["d1_rows_written_four_hour", 0.827]
  );
  assert.deepEqual(
    body.constraints.map((constraint) => [constraint.id, constraint.sampled]),
    [
      ["d1_rows_written_daily", false],
      ["d1_rows_written_four_hour", true],
      ["d1_rows_written_burst", false],
      ["worker_requests_daily", false],
      ["durable_object_requests_daily", false],
      ["d1_rows_read_daily", false]
    ]
  );
  assert.deepEqual(body.windows.map((window) => [window.window_type, window.used_pct, window.budget_units]), [["four_hour", 17.3, 1388]]);
});

test("usage summary reports missing percentages when no current D1 budget windows exist", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/usage-summary", {
      headers: {
        origin: "https://app.example.com"
      }
    }),
    {
      ...devEnv,
      DB: budgetSummaryDb([], { expiredWindowTypes: ["daily", "four_hour", "burst"] })
    }
  );
  const body = (await response.json()) as {
    source: string;
    daily_used_pct: number | null;
    four_hour_used_pct: number | null;
    burst_used_pct: number | null;
    window_sample_count: number;
    constraint_sample_count: number;
    bottleneck_constraint?: unknown;
    constraints: Array<{ id: string; sampled: boolean; used_pct: number | null }>;
    windows: unknown[];
  };

  assert.equal(response.status, 200);
  assert.equal(body.source, "empty");
  assert.equal(body.daily_used_pct, null);
  assert.equal(body.four_hour_used_pct, null);
  assert.equal(body.burst_used_pct, null);
  assert.equal(body.window_sample_count, 0);
  assert.equal(body.constraint_sample_count, 0);
  assert.equal(body.bottleneck_constraint, undefined);
  assert.deepEqual(
    body.constraints.map((constraint) => [constraint.id, constraint.sampled, constraint.used_pct]),
    [
      ["d1_rows_written_daily", false, null],
      ["d1_rows_written_four_hour", false, null],
      ["d1_rows_written_burst", false, null],
      ["worker_requests_daily", false, null],
      ["durable_object_requests_daily", false, null],
      ["d1_rows_read_daily", false, null]
    ]
  );
  assert.deepEqual(body.windows, []);
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

test("command creation rejects unknown execution mode", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        type: "codex",
        execution_mode: "shell",
        prompt: "Summarise current errors"
      })
    }),
    devEnv
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid command payload" });
});

test("command creation rejects execution mode without codex command type", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        type: "placeholder",
        execution_mode: "codex_cli_fallback",
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

test("command creation rejects codex commands without app-server attachment or explicit CLI fallback", async () => {
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

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "Codex commands require an attached app-server host session or explicit CLI fallback execution mode"
  });
});

test("command creation accepts explicit CLI fallback target connectors", async () => {
  const envWithExecutableConnector: Env = {
    ...devEnv,
    DB: commandTargetDb(
      { id: "connector-online" },
      {
        expectedTargetConnectorIdSource: "explicit",
        expectedExecutionMode: "codex_cli_fallback"
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
        execution_mode: "codex_cli_fallback",
        prompt: "Say exactly: chaop-smoke",
        target_connector_id: "connector-online"
      })
    }),
    envWithExecutableConnector
  );
  const body = (await response.json()) as {
    command: { target_connector_id?: string; type: string; execution_mode?: string };
  };

  assert.equal(response.status, 202);
  assert.equal(body.command.type, "codex");
  assert.equal(body.command.execution_mode, "codex_cli_fallback");
  assert.equal(body.command.target_connector_id, "connector-online");
});

test("command creation targets the connector that owns an attached host session", async () => {
  const envWithAttachedSession: Env = {
    ...devEnv,
    DB: commandTargetDb(
      { id: "connector-online" },
      {
        attachedThreadConnectorId: "connector-attached",
        attachedThreadAppServerPresent: true,
        expectedExecutionMode: "app_server"
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
        prompt: "Continue the attached session"
      })
    }),
    envWithAttachedSession
  );
  const body = (await response.json()) as {
    command: { target_connector_id?: string; type: string; execution_mode?: string };
  };

  assert.equal(response.status, 202);
  assert.equal(body.command.type, "codex");
  assert.equal(body.command.execution_mode, "app_server");
  assert.equal(body.command.target_connector_id, "connector-attached");
});

test("command creation routes CLI fallback away from attached app-server sessions", async () => {
  const envWithAttachedSession: Env = {
    ...devEnv,
    DB: commandTargetDb(
      { id: "connector-online" },
      {
        attachedThreadConnectorId: "connector-attached",
        attachedThreadAppServerPresent: true,
        supportsCodex: true,
        supportsAppServerExec: false,
        expectedTargetConnectorIdSource: "auto",
        expectedAutoConnectorId: "connector-online",
        expectedExecutionMode: "codex_cli_fallback"
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
        execution_mode: "codex_cli_fallback",
        prompt: "Run through the private CLI fallback"
      })
    }),
    envWithAttachedSession
  );
  const body = (await response.json()) as { command: { target_connector_id?: string; type: string } };

  assert.equal(response.status, 202);
  assert.equal(body.command.type, "codex");
  assert.equal(body.command.target_connector_id, "connector-online");
});

test("command creation rejects app-server execution without an attached app-server session", async () => {
  const envWithNonAppServerSession: Env = {
    ...devEnv,
    DB: commandTargetDb(
      { id: "connector-online" },
      {
        attachedThreadConnectorId: "connector-attached",
        attachedThreadAppServerPresent: false
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
        execution_mode: "app_server",
        prompt: "Run through the managed app-server path"
      })
    }),
    envWithNonAppServerSession
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "App-server execution requires an attached app-server host session"
  });
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
        supportsAppServerExec: true,
        expectedExecutionMode: "app_server"
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
  const body = (await response.json()) as {
    command: { target_connector_id?: string; type: string; execution_mode?: string };
  };

  assert.equal(response.status, 202);
  assert.equal(body.command.type, "codex");
  assert.equal(body.command.execution_mode, "app_server");
  assert.equal(body.command.target_connector_id, "connector-attached");
});

test("command creation rejects attached app-server commands when the attachment changes before insert", async () => {
  const envWithDetachedSession: Env = {
    ...devEnv,
    DB: commandTargetDb(
      { id: "connector-online" },
      {
        attachedThreadConnectorId: "connector-attached",
        attachedThreadAppServerPresent: true,
        supportsCodex: false,
        supportsAppServerExec: true,
        guardedCommandInsertChanges: 0,
        expectedExecutionMode: "app_server"
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
    envWithDetachedSession
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Attached host session changed before command creation"
  });
});

test("command creation rejects attached placeholder commands when the attachment changes before insert", async () => {
  const envWithDetachedSession: Env = {
    ...devEnv,
    DB: commandTargetDb(
      { id: "connector-online" },
      {
        attachedThreadConnectorId: "connector-attached",
        attachedThreadAppServerPresent: false,
        guardedCommandInsertChanges: 0
      }
    )
  };
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        prompt: "Record a placeholder command for the attached session"
      })
    }),
    envWithDetachedSession
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Attached host session changed before command creation"
  });
});

test("command creation rejects explicit attached targets when the attachment changes before insert", async () => {
  const envWithDetachedSession: Env = {
    ...devEnv,
    DB: commandTargetDb(
      { id: "connector-online" },
      {
        attachedThreadConnectorId: "connector-attached",
        attachedThreadAppServerPresent: true,
        supportsCodex: false,
        supportsAppServerExec: true,
        guardedCommandInsertChanges: 0,
        expectedTargetConnectorIdSource: "explicit",
        expectedExecutionMode: "app_server"
      }
    )
  };
  const response = await handleRequest(
    new Request("https://api.example.com/api/commands", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        target_connector_id: "connector-attached",
        type: "codex",
        prompt: "Continue the explicit attached app-server session"
      })
    }),
    envWithDetachedSession
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Attached host session changed before command creation"
  });
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

test("command creation rejects explicit CLI fallback target connectors without codex_exec capability", async () => {
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
        execution_mode: "codex_cli_fallback",
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
      assert.doesNotMatch(sql, /GROUP BY budget_state/);
      if (/FROM host_sessions hs/.test(sql)) {
        assert.match(sql, /INNER JOIN connectors c ON c\.id = hs\.connector_id/);
        assert.match(sql, /c\.status <> 'offline'/);
        assert.match(sql, /hs\.attached_task_id IS NOT NULL OR hs\.attached_thread_id IS NOT NULL/);
      }
      if (/FROM app_server_instances/.test(sql)) {
        assert.match(sql, /INNER JOIN connectors c ON c\.id = asi\.connector_id/);
        assert.match(sql, /c\.status <> 'offline'/);
        assert.match(sql, /c\.capabilities_json LIKE '%"app_server_instance_state"%'/);
      }
      return {
        bind() {
          return this;
        },
        async first() {
          return undefined;
        },
        async all() {
          return { results: [] };
        }
      };
    }
  } as unknown as D1Database;
}

function budgetSummaryDb(
  omitWindowTypes: string[] = [],
  options: { expiredWindowTypes?: string[] | undefined } = {}
): D1Database {
  const windows: Record<string, Record<string, unknown>> = {
    daily: {
      id: "usage-daily",
      window_type: "daily",
      window_start: "2026-06-15T00:00:00.000Z",
      window_end: "2026-06-16T00:00:00.000Z",
      budget_state: "conservative",
      used_pct: 125.44,
      events_received: 1000,
      events_compacted: 55,
      events_delayed: 8,
      local_spool_bytes: 4096,
      updated_at: "2026-06-15T09:00:00.000Z"
    },
    four_hour: {
      id: "usage-four-hour",
      window_type: "four_hour",
      window_start: "2026-06-15T08:00:00.000Z",
      window_end: "2026-06-15T12:00:00.000Z",
      budget_state: "hard_limited",
      used_pct: 88.88,
      events_received: 240,
      events_compacted: 20,
      events_delayed: 4,
      local_spool_bytes: 2048,
      updated_at: "2026-06-15T09:01:00.000Z"
    },
    burst: {
      id: "usage-burst",
      window_type: "burst",
      window_start: "2026-06-15T09:00:00.000Z",
      window_end: "2026-06-15T09:01:00.000Z",
      budget_state: "normal",
      used_pct: 21,
      events_received: 18,
      events_compacted: 0,
      events_delayed: 0,
      local_spool_bytes: 0,
      updated_at: "2026-06-15T09:01:00.000Z"
    }
  };
  for (const windowType of omitWindowTypes) {
    delete windows[windowType];
  }

  return {
    prepare(sql: string) {
      if (/FROM usage_windows/.test(sql)) {
        assert.match(sql, /WHERE window_type = \?/);
        assert.match(sql, /window_start <= \?/);
        assert.match(sql, /window_end > \?/);
        assert.match(sql, /ORDER BY window_end DESC, updated_at DESC, id DESC/);
        assert.match(sql, /LIMIT 1/);
        return {
          bind(windowType: string, windowStartAt: string, windowEndAt: string) {
            assert.match(windowStartAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(windowEndAt, windowStartAt);
            return {
              async first() {
                if (options.expiredWindowTypes?.includes(windowType)) {
                  return undefined;
                }
                return windows[windowType];
              }
            };
          }
        };
      }

      if (/FROM connectors/.test(sql) && /GROUP BY budget_state/.test(sql)) {
        assert.match(sql, /status <> 'offline'/);
        return {
          async all() {
            return { results: [{ budget_state: "throttled", count: 1 }] };
          }
        };
      }

      if (/FROM tasks/.test(sql) && /GROUP BY budget_state/.test(sql)) {
        assert.match(sql, /archived_at IS NULL/);
        return {
          async all() {
            return { results: [{ budget_state: "conservative", count: 2 }] };
          }
        };
      }

      throw new Error(`Unexpected SQL in budget summary fake: ${sql}`);
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
    guardedCommandInsertChanges?: number;
    expectedTargetConnectorIdSource?: "explicit" | "attached" | "auto";
    expectedAutoConnectorId?: string;
    expectedExecutionMode?: "app_server" | "codex_cli_fallback";
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
                    session_id: "session-attached-task",
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
                    session_id: "session-attached-thread",
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
        assert.match(sql, /c\.status = 'online'/);
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

      if (/SELECT c\.id/.test(sql) && /ORDER BY c\.last_seen_at DESC/.test(sql)) {
        assert.match(sql, /workspace_connectors/);
        assert.match(sql, /wc\.workspace_id = \?/);
        assert.match(sql, /wc\.can_execute = 1/);
        assert.match(sql, /c\.status = 'online'/);
        assert.match(sql, /capabilities_json LIKE/);
        return {
          bind(workspaceId: string, commandType: string) {
            assert.equal(workspaceId, "workspace-api");
            assert.equal(commandType === "placeholder" || commandType === "codex", true);
            return {
              async first() {
                if (commandType === "codex" && !supportsCodex) {
                  return null;
                }
                return row ? { id: options.expectedAutoConnectorId ?? row.id } : null;
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

      if (/INSERT INTO commands/.test(sql)) {
        return {
          bind(...args: unknown[]) {
            const [
              commandId,
              workspaceId,
              threadId,
              taskId,
              commandType,
              prompt,
              state,
              targetConnectorId
            ] = args as [
              string,
              string,
              string | null,
              string | null,
              string,
              string,
              string,
              string | null
            ];
            assert.match(commandId, /^command-/);
            assert.equal(workspaceId, "workspace-api");
            assert.equal(threadId, "thread-orders-500");
            assert.equal(taskId, null);
            assert.equal(commandType === "placeholder" || commandType === "codex", true);
            assert.equal(typeof prompt, "string");
            assert.equal(state, "pending");
            if (/WHERE EXISTS/.test(sql)) {
              const targetConnectorIdSource = args[8];
              const leaseTargetHostSessionId = args[9];
              const executionMode = args[10];
              const appServerPresentGuard = args[25];
              assert.equal(targetConnectorId, "connector-attached");
              assert.equal(targetConnectorIdSource, options.expectedTargetConnectorIdSource ?? "attached");
              assert.equal(executionMode, options.expectedExecutionMode ?? null);
              assert.equal(
                leaseTargetHostSessionId,
                attachedThreadAppServerPresent ? "session-attached-thread" : null
              );
              assert.equal(appServerPresentGuard, attachedThreadAppServerPresent ? 1 : 0);
              assert.match(sql, /COALESCE\(hs\.app_server_present, 0\) = \?/);
              assert.match(sql, /hs\.id = \(\s+SELECT hs2\.id/);
              assert.match(sql, /hs\.connector_id = \?/);
              assert.match(sql, /hs\.session_id = \?/);
              assert.match(sql, /ORDER BY\s+CASE WHEN \? IS NOT NULL AND hs2\.attached_task_id = \?/);
              assert.match(sql, /OR NOT EXISTS \(\s+SELECT 1\s+FROM host_sessions hst/);
            } else {
              const executionMode = args[9];
              assert.equal(targetConnectorId, options.expectedAutoConnectorId ?? row?.id ?? null);
              assert.equal(executionMode, options.expectedExecutionMode ?? null);
            }
            return {
              async run() {
                return { meta: { changes: options.guardedCommandInsertChanges ?? 1 } };
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
        assert.match(sql, /c\.status = 'online'/);
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

      if (/hs\.app_server_present = 1/.test(sql) && /hs\.title_source = 'app_server'/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async all() {
                return {
                  results: [...sessions.values()].filter(
                    (session) =>
                      session.connector_id === connectorId &&
                      session.app_server_present === 1 &&
                      session.title_source === "app_server"
                  )
                };
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
  options: {
    connectorStatus?: string | undefined;
    supportsBackfill?: boolean | undefined;
    supportsAppServer?: boolean | undefined;
    supportsAppServerEnsure?: boolean | undefined;
    appServerPresent?: boolean | undefined;
    alreadyAttached?: boolean | undefined;
    missingAttachedRows?: boolean | undefined;
  } = {}
): D1Database & { readonly eventInserts: number; readonly hostSessionLookupConnectorIds: Array<string | undefined> } {
  const connectorStatus = options.connectorStatus ?? "online";
  const supportsBackfill = options.supportsBackfill ?? true;
  const supportsAppServer = options.supportsAppServer ?? false;
  const supportsAppServerEnsure = options.supportsAppServerEnsure ?? supportsAppServer;
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
    app_server_present: options.appServerPresent ? 1 : 0,
    cwd: "/workspace/project",
    attached_task_id: options.alreadyAttached ? taskId : null as string | null,
    attached_thread_id: options.alreadyAttached ? threadId : null as string | null,
    updated_at: "2026-06-12T10:00:00.000Z"
  };
  let threadRow: Record<string, unknown> | undefined = options.alreadyAttached && !options.missingAttachedRows
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
  let taskRow: Record<string, unknown> | undefined = options.alreadyAttached && !options.missingAttachedRows
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
  const hostSessionLookupConnectorIds: Array<string | undefined> = [];

  const db = {
    prepare(sql: string) {
      if (/SELECT hs\.id, hs\.connector_id/.test(sql) && /FROM host_sessions hs/.test(sql)) {
        return {
          bind(sessionId: string, connectorId?: string) {
            assert.equal(sessionId, "session-1");
            hostSessionLookupConnectorIds.push(connectorId);
            if (connectorId !== undefined) {
              assert.equal(connectorId, "connector-online");
            }
            return {
              async first() {
                return session;
              }
            };
          }
        };
      }

      if (/SELECT capabilities_json/.test(sql) && /FROM connectors/.test(sql)) {
        assert.match(sql, /status = 'online'/);
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async first() {
                if (connectorStatus !== "online") {
                  return null;
                }
                const capabilities = [
                  ...(supportsBackfill ? ["host_session_backfill_v2"] : []),
                  ...(supportsAppServer ? ["codex_app_server_exec"] : []),
                  ...(supportsAppServerEnsure ? ["host_session_app_server_ensure"] : [])
                ];
                return {
                  capabilities_json: JSON.stringify(capabilities)
                };
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
                return { workspace_id: "workspace-api" };
              }
            };
          }
        };
      }

      if (/INSERT INTO host_sessions/.test(sql)) {
        return {
          bind(
            hostSessionId: string,
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
            assert.equal(hostSessionId, "host-session-session-1-connector-online");
            assert.equal(connectorId, "connector-online");
            assert.equal(hostname, "mac-studio.local");
            assert.equal(workspaceId, "workspace-api");
            assert.equal(sessionId, "session-1");
            assert.equal(title, "Recovered app-server title");
            assert.equal(titleSource, "app_server");
            assert.equal(appServerPresent, 1);
            assert.equal(cwd, "/workspace/project");
            assert.match(discoveredAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(updatedAt, "2026-06-12T10:05:00.000Z");
            return {
              async run() {
                session.title = title;
                session.title_source = titleSource;
                session.app_server_present = appServerPresent;
                session.cwd = cwd ?? "/workspace/project";
                session.updated_at = updatedAt;
                return { success: true };
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
            assert.equal(title, session.title);
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
            assert.equal(title, session.title);
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

      if (/INSERT INTO usage_windows/.test(sql)) {
        return usageWindowUpsertFake();
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

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get eventInserts() {
      return eventInsertCount;
    },
    get hostSessionLookupConnectorIds() {
      return hostSessionLookupConnectorIds;
    }
  };

  return db as D1Database & { readonly eventInserts: number; readonly hostSessionLookupConnectorIds: Array<string | undefined> };
}

function hostSessionDetachDb(options: {
  returnDetachedCommands?: boolean;
  detachedCommandState?: "pending" | "leased";
  detachedCommandFailureChanges?: number;
  releaseDetachedCommands?: boolean;
  detachedLeaseOwnedByReplacement?: boolean;
  detachedCommandExecutionMode?: "app_server" | "codex_cli_fallback";
} = {}): D1Database & {
  readonly commandReleases: number;
  readonly commandFailures: number;
  readonly connectorActivityUpdates: number;
  readonly taskUpdates: number;
  readonly eventInserts: number;
} {
  const counters = {
    commandReleases: 0,
    commandFailures: 0,
    connectorActivityUpdates: 0,
    taskUpdates: 0,
    eventInserts: 0
  };
  let attachmentCleared = false;
  const row = {
    id: "host-session-1",
    connector_id: "connector-online",
    hostname: "mac-studio.local",
    workspace_id: "workspace-api",
    session_id: "session-1",
    title: "Attached session",
    title_source: "history",
    app_server_present: 1,
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

      if (/FROM commands cmd/.test(sql)) {
        assert.equal(attachmentCleared, true);
        assert.match(sql, /cmd\.type = 'codex'/);
        assert.match(sql, /COALESCE\(cmd\.execution_mode, ''\) <> 'codex_cli_fallback'/);
        assert.match(sql, /cmd\.target_connector_id = \?/);
        assert.match(sql, /cmd\.target_connector_id IS NULL/);
        assert.match(sql, /cmd\.state = 'pending'/);
        assert.match(sql, /cmd\.state = 'leased'/);
        assert.match(sql, /cmd\.lease_target_host_session_id = \?/);
        assert.match(sql, /cmd\.lease_owner_connector_id = \?/);
        assert.match(sql, /cmd\.state = 'leased'\s+AND cmd\.lease_owner_connector_id = \?\s+AND \(\s+cmd\.lease_target_host_session_id = \?/);
        assert.match(sql, /cmd\.state = 'pending'\s+AND cmd\.lease_target_host_session_id = \?/);
        assert.doesNotMatch(sql, /cmd\.lease_until IS NOT NULL/);
        assert.match(sql, /NOT EXISTS \(\s+SELECT 1\s+FROM host_sessions hs/);
        assert.match(sql, /INNER JOIN connectors c ON c\.id = hs\.connector_id/);
        assert.match(sql, /INNER JOIN workspace_connectors wc/);
        assert.match(sql, /wc\.can_execute = 1/);
        assert.match(sql, /c\.status = 'online'/);
        assert.match(sql, /c\.capabilities_json LIKE '%"codex_app_server_exec"%'/);
        assert.match(sql, /WHERE hs\.id = COALESCE\(/);
        assert.match(sql, /hs_task\.id <> \?/);
        assert.match(sql, /hs_thread\.id <> \?/);
        assert.doesNotMatch(sql, /CASE\s+WHEN cmd\.task_id IS NOT NULL/);
        assert.match(sql, /ORDER BY hs_task\.updated_at DESC,\s+hs_task\.id DESC/);
        assert.match(sql, /ORDER BY hs_thread\.updated_at DESC,\s+hs_thread\.id DESC/);
        assert.match(sql, /LIMIT 1/);
        assert.match(sql, /cmd\.target_connector_id IS NULL OR hs\.connector_id = cmd\.target_connector_id/);
        assert.match(sql, /hst\.id <> \?/);
        assert.doesNotMatch(sql, /hst\.connector_id = cmd\.target_connector_id/);
        assert.doesNotMatch(sql, /hst\.app_server_present = 1/);
        assert.doesNotMatch(sql, /hs\.attached_task_id = cmd\.task_id/);
        return {
          bind(
            workspaceId: string,
            connectorId: string,
            pendingLeaseTargetHostSessionId: string,
            legacyLeaseOwnerConnectorId: string,
            leasedLeaseTargetHostSessionId: string,
            taskIdPresent: string | null,
            taskId: string | null,
            threadIdPresent: string | null,
            threadId: string | null,
            excludedHostSessionId: string,
            excludedTaskHostSessionId: string
          ) {
            assert.equal(workspaceId, "workspace-api");
            assert.equal(connectorId, "connector-online");
            assert.equal(pendingLeaseTargetHostSessionId, "session-1");
            assert.equal(legacyLeaseOwnerConnectorId, "connector-online");
            assert.equal(leasedLeaseTargetHostSessionId, "session-1");
            assert.equal(taskIdPresent, "task-host-1");
            assert.equal(taskId, "task-host-1");
            assert.equal(threadIdPresent, "thread-host-1");
            assert.equal(threadId, "thread-host-1");
            assert.equal(excludedHostSessionId, "host-session-1");
            assert.equal(excludedTaskHostSessionId, "host-session-1");
            return {
              async all() {
                const commandWasReleased = counters.commandReleases > 0;
                return {
                  results: options.returnDetachedCommands === false
                    || commandWasReleased
                    || options.detachedLeaseOwnedByReplacement
                    || options.detachedCommandExecutionMode === "codex_cli_fallback"
                    ? [] : [
                    {
                      id: "command-detached",
                      workspace_id: "workspace-api",
                      thread_id: "thread-host-1",
                      task_id: "task-host-1",
                      type: "codex",
                      prompt: "Continue this attached session",
                      state: options.detachedCommandState ?? "pending",
                      target_connector_id: "connector-online",
                      execution_mode: options.detachedCommandExecutionMode ?? null,
                      lease_owner_connector_id: "connector-online",
                      created_at: "2026-06-12T10:01:00.000Z",
                      updated_at: "2026-06-12T10:01:00.000Z"
                    }
                  ]
                };
              }
            };
            }
          };
        }

      if (/UPDATE commands/.test(sql) && /SET state = 'pending'/.test(sql)) {
        assert.match(sql, /target_connector_id = CASE WHEN target_connector_id_source = 'attached' THEN NULL ELSE target_connector_id END/);
        assert.match(sql, /COALESCE\(execution_mode, ''\) <> 'codex_cli_fallback'/);
        assert.match(sql, /target_connector_id_source = CASE WHEN target_connector_id_source = 'attached' THEN 'auto' ELSE target_connector_id_source END/);
        assert.match(sql, /lease_owner_connector_id = NULL/);
        assert.match(sql, /lease_until = NULL/);
        assert.match(sql, /lease_target_host_session_id = \(\s+SELECT hs\.session_id/);
        assert.match(sql, /state = 'pending'\s+AND lease_target_host_session_id = \?/);
        assert.match(sql, /state = 'leased'/);
        assert.match(sql, /lease_owner_connector_id = \?/);
        assert.match(sql, /state = 'leased'\s+AND lease_owner_connector_id = \?\s+AND \(\s+lease_target_host_session_id = \?/);
        assert.match(sql, /AND EXISTS \(\s+SELECT 1\s+FROM host_sessions hs/);
        assert.match(sql, /hs_task\.connector_id <> \? OR hs_task\.session_id <> \?/);
        assert.match(sql, /hs_thread\.connector_id <> \? OR hs_thread\.session_id <> \?/);
        assert.match(sql, /hst\.connector_id <> \? OR hst\.session_id <> \?/);
        assert.match(sql, /commands\.target_connector_id_source = 'attached'/);
        assert.match(sql, /commands\.target_connector_id IS NULL/);
        assert.match(sql, /hs\.connector_id = commands\.target_connector_id/);
        return {
          bind(
            replacementTaskConnectorId: string,
            replacementTaskSessionId: string,
            replacementThreadConnectorId: string,
            replacementThreadSessionId: string,
            replacementFallbackConnectorId: string,
            replacementFallbackSessionId: string,
            updatedAt: string,
            workspaceId: string,
            connectorId: string,
            pendingLeaseTargetHostSessionId: string,
            legacyLeaseOwnerConnectorId: string,
            leasedLeaseTargetHostSessionId: string,
            taskIdPresent: string | null,
            taskId: string | null,
            threadIdPresent: string | null,
            threadId: string | null,
            excludedTaskConnectorId: string,
            excludedTaskSessionId: string,
            excludedThreadConnectorId: string,
            excludedThreadSessionId: string,
            excludedFallbackConnectorId: string,
            excludedFallbackSessionId: string
          ) {
            assert.equal(replacementTaskConnectorId, "connector-online");
            assert.equal(replacementTaskSessionId, "session-1");
            assert.equal(replacementThreadConnectorId, "connector-online");
            assert.equal(replacementThreadSessionId, "session-1");
            assert.equal(replacementFallbackConnectorId, "connector-online");
            assert.equal(replacementFallbackSessionId, "session-1");
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(workspaceId, "workspace-api");
            assert.equal(connectorId, "connector-online");
            assert.equal(pendingLeaseTargetHostSessionId, "session-1");
            assert.equal(legacyLeaseOwnerConnectorId, "connector-online");
            assert.equal(leasedLeaseTargetHostSessionId, "session-1");
            assert.equal(taskIdPresent, "task-host-1");
            assert.equal(taskId, "task-host-1");
            assert.equal(threadIdPresent, "thread-host-1");
            assert.equal(threadId, "thread-host-1");
            assert.equal(excludedTaskConnectorId, "connector-online");
            assert.equal(excludedTaskSessionId, "session-1");
            assert.equal(excludedThreadConnectorId, "connector-online");
            assert.equal(excludedThreadSessionId, "session-1");
            assert.equal(excludedFallbackConnectorId, "connector-online");
            assert.equal(excludedFallbackSessionId, "session-1");
            return {
              async run() {
                const changes =
                  options.releaseDetachedCommands
                    && counters.commandReleases === 0
                    && !options.detachedLeaseOwnedByReplacement
                    && options.detachedCommandExecutionMode !== "codex_cli_fallback"
                    ? 1
                    : 0;
                counters.commandReleases += changes;
                return { meta: { changes } };
              }
            };
          }
        };
      }

      if (/SELECT DISTINCT c\.id AS connector_id/.test(sql)) {
        assert.match(sql, /FROM connectors c/);
        assert.match(sql, /INNER JOIN workspace_connectors wc/);
        assert.match(sql, /wc\.workspace_id = \?/);
        assert.match(sql, /wc\.can_execute = 1/);
        assert.match(sql, /c\.status = 'online'/);
        assert.match(sql, /c\.capabilities_json LIKE '%"codex_app_server_exec"%'/);
        return {
          bind(workspaceId: string) {
            assert.equal(workspaceId, "workspace-api");
            return {
              async all() {
                return {
                  results: options.releaseDetachedCommands && !options.detachedLeaseOwnedByReplacement
                    ? [{ connector_id: "connector-online" }, { connector_id: "connector-replacement" }]
                    : []
                };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /state = 'failed'/.test(sql)) {
        assert.match(sql, /workspace_id = \?/);
        assert.match(sql, /type = 'codex'/);
        assert.match(sql, /COALESCE\(execution_mode, ''\) <> 'codex_cli_fallback'/);
        assert.match(sql, /target_connector_id = \? OR target_connector_id IS NULL/);
        assert.match(sql, /state = 'pending'\s+AND lease_target_host_session_id = \?/);
        assert.match(sql, /state = 'leased'/);
        assert.match(sql, /lease_owner_connector_id = \?/);
        assert.match(sql, /state = 'leased'\s+AND lease_owner_connector_id = \?\s+AND \(\s+lease_target_host_session_id = \?/);
        assert.match(sql, /AND NOT EXISTS \(\s+SELECT 1\s+FROM host_sessions hs/);
        assert.match(sql, /WHERE hs\.id = COALESCE\(/);
        assert.match(sql, /wc\.workspace_id = commands\.workspace_id/);
        assert.match(sql, /commands\.task_id IS NOT NULL/);
        assert.match(sql, /hs_task\.attached_task_id = commands\.task_id/);
        assert.match(sql, /commands\.thread_id IS NOT NULL/);
        assert.match(sql, /hs_thread\.attached_thread_id = commands\.thread_id/);
        assert.match(sql, /commands\.task_id IS NULL/);
        assert.match(sql, /hst\.workspace_id = commands\.workspace_id/);
        assert.match(sql, /hst\.attached_task_id = commands\.task_id/);
        assert.match(sql, /commands\.target_connector_id IS NULL OR hs\.connector_id = commands\.target_connector_id/);
        return {
          bind(
            updatedAt: string,
            commandId: string,
            workspaceId: string,
            connectorId: string,
            pendingLeaseTargetHostSessionId: string,
            legacyLeaseOwnerConnectorId: string,
            leasedLeaseTargetHostSessionId: string,
            taskIdPresent: string | null,
            taskId: string | null,
            threadIdPresent: string | null,
            threadId: string | null,
            excludedTaskHostSessionId: string,
            excludedThreadHostSessionId: string,
            excludedFallbackHostSessionId: string
          ) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-detached");
            assert.equal(workspaceId, "workspace-api");
            assert.equal(connectorId, "connector-online");
            assert.equal(pendingLeaseTargetHostSessionId, "session-1");
            assert.equal(legacyLeaseOwnerConnectorId, "connector-online");
            assert.equal(leasedLeaseTargetHostSessionId, "session-1");
            assert.equal(taskIdPresent, "task-host-1");
            assert.equal(taskId, "task-host-1");
            assert.equal(threadIdPresent, "thread-host-1");
            assert.equal(threadId, "thread-host-1");
            assert.equal(excludedTaskHostSessionId, "host-session-1");
            assert.equal(excludedThreadHostSessionId, "host-session-1");
            assert.equal(excludedFallbackHostSessionId, "host-session-1");
            return {
              async run() {
                const changes =
                  options.detachedCommandExecutionMode === "codex_cli_fallback"
                    ? 0
                    : options.detachedCommandFailureChanges ?? 1;
                counters.commandFailures += changes;
                return { meta: { changes } };
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

      if (/UPDATE connectors/.test(sql) && /active_command_count/.test(sql)) {
        return {
          bind(activeCount: number, updatedAt: string, connectorId: string) {
            assert.equal(activeCount, 0);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.connectorActivityUpdates += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE tasks/.test(sql) && /state = 'failed'/.test(sql)) {
        return {
          bind(updatedAt: string, taskId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(taskId, "task-host-1");
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
            assert.equal(threadId, "thread-host-1");
            return {
              async first() {
                return { last_seq: 12 };
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
            assert.equal(threadId, "thread-host-1");
            assert.equal(commandId, "command-detached");
            assert.equal(seq, 12);
            assert.equal(kind, "command.failed");
            assert.equal(priority, "P1");
            assert.equal(summary, "Host session was detached before the command could run.");
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

      if (/UPDATE host_sessions/.test(sql) && /attached_task_id = NULL/.test(sql)) {
        return {
          bind(updatedAt: string, hostSessionId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(hostSessionId, "host-session-1");
            attachmentCleared = true;
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
    },
    get commandReleases() {
      return counters.commandReleases;
    },
    get commandFailures() {
      return counters.commandFailures;
    },
    get connectorActivityUpdates() {
      return counters.connectorActivityUpdates;
    },
    get taskUpdates() {
      return counters.taskUpdates;
    },
    get eventInserts() {
      return counters.eventInserts;
    }
  } as unknown as D1Database & typeof counters;
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
