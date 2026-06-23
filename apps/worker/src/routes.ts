import {
  createEnvelope,
  type AgentBackfillEvent,
  type AgentHostSession,
  type AttachHostSessionRequest,
  type AgentBootstrapRequest,
  type AgentBootstrapResponse,
  type CreateCommandRequest,
  type CreateCommandResponse,
  type CreateLocalThreadRequest,
  type DetachHostSessionRequest,
  type DogfoodSafetyPostureResponse,
  type HostSessionAppServerEnsureResult,
  type HostSessionSummary,
  type LocalThreadCreateResult,
  type RefreshHostSessionsResponse,
  type SetDogfoodSafetyPauseRequest,
  type SetDogfoodSafetyPauseResponse,
  type TaskArchiveResponse,
  type TaskArchiveSyncSummary,
  type ThreadEvent,
  type ThreadEventsResponse
} from "@chaop/protocol";
import {
  authenticateAgentBootstrap,
  authenticateAgentToken,
  authenticateBrowser,
  issueAgentToken
} from "./auth.js";
import {
  CommandTargetError,
  DogfoodSafetyError,
  LocalThreadTargetError,
  NotFoundError,
  archiveTaskInDb,
  assertDogfoodSafetyActionAllowed,
  attachCreatedLocalThreadInDb,
  attachHostSessionInDb,
  bootstrapBudgetWindowsInDb,
  chooseConnectorForLocalThread,
  createCommandInDb,
  detachHostSessionInDb,
  ensureConnectorInventory,
  findAttachedHostSessionForTaskInDb,
  hasLiveHostSessionAttachmentInDb,
  listThreadEventsInDb,
  loadBudgetSummaryFromDb,
  loadBootstrapFromDb,
  loadDogfoodSafetyPostureFromDb,
  loadHostSessionInDb,
  markHostSessionAppServerPresentInDb,
  recordHostSessionBackfillEvents,
  recordHostSessions,
  setDogfoodSafetyPauseInDb,
  unarchiveTaskInDb
} from "./db.js";
import { budget, sampleBootstrap } from "./sample-data.js";
import type { Env } from "./types.js";

const HOST_SESSION_BACKFILL_EVENT_LIMIT = 30;

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return optionsResponse(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(request, env, { ok: true, service: "chaop-api", server_time: new Date().toISOString() });
  }

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const originCheck = validateBrowserOrigin(request, env);
    if (!originCheck.ok) return json(request, env, { error: originCheck.message }, originCheck.status);
    const auth = await authenticateBrowser(request, env);
    if (!auth.ok) return json(request, env, { error: auth.message }, auth.status);
    if (!env.DB && !allowsSampleData(env)) {
      return json(request, env, { error: "DB binding is required" }, 503);
    }
    const bootstrap = await loadBootstrapFromDb(env, auth.user);
    return json(request, env, bootstrap ?? sampleBootstrap(auth.user.email));
  }

  if (request.method === "GET" && url.pathname === "/api/usage-summary") {
    const originCheck = validateBrowserOrigin(request, env);
    if (!originCheck.ok) return json(request, env, { error: originCheck.message }, originCheck.status);
    const auth = await authenticateBrowser(request, env);
    if (!auth.ok) return json(request, env, { error: auth.message }, auth.status);
    if (!env.DB && !allowsSampleData(env)) {
      return json(request, env, { error: "DB binding is required" }, 503);
    }
    const summary = env.DB ? await loadBudgetSummaryFromDb(env) : budget;
    return json(request, env, summary);
  }

  if (request.method === "GET" && url.pathname === "/api/safety-posture") {
    const originCheck = validateBrowserOrigin(request, env);
    if (!originCheck.ok) return json(request, env, { error: originCheck.message }, originCheck.status);
    const auth = await authenticateBrowser(request, env);
    if (!auth.ok) return json(request, env, { error: auth.message }, auth.status);
    if (!env.DB && !allowsSampleData(env)) {
      return json(request, env, { error: "DB binding is required" }, 503);
    }
    const response: DogfoodSafetyPostureResponse = {
      safety: await loadDogfoodSafetyPostureFromDb(env)
    };
    return json(request, env, response);
  }

  if (request.method === "POST" && (url.pathname === "/api/safety/pause" || url.pathname === "/api/safety/resume")) {
    const originCheck = validateBrowserOrigin(request, env, { requireOrigin: true });
    if (!originCheck.ok) return json(request, env, { error: originCheck.message }, originCheck.status);
    const auth = await authenticateBrowser(request, env);
    if (!auth.ok) return json(request, env, { error: auth.message }, auth.status);
    if (!env.DB && !allowsSampleData(env)) {
      return json(request, env, { error: "DB binding is required" }, 503);
    }
    const payload = await readOptionalJson(request);
    if (!payload.ok) {
      return json(request, env, { error: payload.message }, 400);
    }
    if (!isSetDogfoodSafetyPauseRequest(payload.value)) {
      return json(request, env, { error: "Invalid safety pause payload" }, 400);
    }
    const response: SetDogfoodSafetyPauseResponse = {
      safety: await setDogfoodSafetyPauseInDb(
        env,
        url.pathname.endsWith("/pause"),
        auth.user,
        payload.value.reason
      )
    };
    return json(request, env, response, 200);
  }

  if (request.method === "POST" && url.pathname === "/api/budget/bootstrap") {
    const originCheck = validateBrowserOrigin(request, env, { requireOrigin: true });
    if (!originCheck.ok) return json(request, env, { error: originCheck.message }, originCheck.status);
    const auth = await authenticateBrowser(request, env);
    if (!auth.ok) return json(request, env, { error: auth.message }, auth.status);
    if (!env.DB) return json(request, env, { error: "DB binding is required" }, 503);
    try {
      await assertDogfoodSafetyActionAllowed(env, "budget_bootstrap");
    } catch (error) {
      if (error instanceof DogfoodSafetyError) {
        return dogfoodSafetyErrorResponse(request, env, error);
      }
      throw error;
    }
    const summary = await bootstrapBudgetWindowsInDb(env);
    return json(request, env, summary, 201);
  }

  if (request.method === "POST" && url.pathname === "/connector/bootstrap") {
    if (!authenticateAgentBootstrap(request, env)) {
      return json(request, env, { error: "Invalid connector bootstrap secret" }, 401);
    }
    const payload = await readJson(request);
    if (!payload.ok) {
      return json(request, env, { error: payload.message }, 400);
    }
    if (!isAgentBootstrapRequest(payload.value)) {
      return json(request, env, { error: "Invalid connector bootstrap payload" }, 400);
    }
    const registration = payload.value;
    const connectorId = stableConnectorId(registration.connector_name, registration.hostname);
    const token = await issueAgentToken(connectorId, env, {
      connectorName: registration.connector_name,
      hostname: registration.hostname,
      workspaceRoot: registration.workspace_root,
      capabilities: registration.capabilities
    });
    await ensureConnectorInventory(env, connectorId, registration);
    const response: AgentBootstrapResponse = {
      connector_id: connectorId,
      token,
      control_url: connectorControlUrl(url, env),
      reporting_policy: {
        policy_version: 1,
        default_level: "background",
        budget_state: "normal",
        scopes: []
      }
    };
    return json(request, env, response, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/commands") {
    const originCheck = validateBrowserOrigin(request, env, { requireOrigin: true });
    if (!originCheck.ok) return json(request, env, { error: originCheck.message }, originCheck.status);
    const auth = await authenticateBrowser(request, env);
    if (!auth.ok) return json(request, env, { error: auth.message }, auth.status);
    const payload = await readJson(request);
    if (!payload.ok) {
      return json(request, env, { error: payload.message }, 400);
    }
    if (!isCreateCommandRequest(payload.value)) {
      return json(request, env, { error: "Invalid command payload" }, 400);
    }
    const commandRequest = payload.value;

    if (!env.DB) {
      if (!allowsSampleData(env)) {
        return json(request, env, { error: "DB binding is required" }, 503);
      }

      const now = new Date().toISOString();
      const response: CreateCommandResponse = {
        accepted: true,
        command: {
          id: `command-${cryptoRandomId().slice(0, 12)}`,
          workspace_id: commandRequest.workspace_id,
          thread_id: commandRequest.thread_id,
          task_id: commandRequest.task_id,
          type: commandRequest.type ?? "placeholder",
          execution_mode: commandRequest.type === "codex" ? commandRequest.execution_mode : undefined,
          prompt: commandRequest.prompt,
          state: "pending",
          target_connector_id: commandRequest.target_connector_id,
          created_at: now,
          updated_at: now
        }
      };
      return json(request, env, response, 202);
    }

    try {
      const safetyResponse = await dogfoodSafetyGuardResponse(request, env, "command_create");
      if (safetyResponse) return safetyResponse;
      const { response, targetConnectorId } = await createCommandInDb(env, auth.user, commandRequest);
      if (targetConnectorId) {
        await dispatchPendingCommand(env, targetConnectorId);
      }
      return json(request, env, response, 202);
    } catch (error) {
      if (error instanceof CommandTargetError) {
        return json(request, env, { error: error.message }, error.status);
      }
      throw error;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/local-threads") {
    const originCheck = validateBrowserOrigin(request, env, { requireOrigin: true });
    if (!originCheck.ok) return json(request, env, { error: originCheck.message }, originCheck.status);
    const auth = await authenticateBrowser(request, env);
    if (!auth.ok) return json(request, env, { error: auth.message }, auth.status);
    if (!env.DB) return json(request, env, { error: "DB binding is required" }, 503);
    if (!env.WORKSPACE_DO) return json(request, env, { error: "Workspace Durable Object binding is unavailable" }, 503);

    const payload = await readJson(request);
    if (!payload.ok) {
      return json(request, env, { error: payload.message }, 400);
    }
    if (!isCreateLocalThreadRequest(payload.value)) {
      return json(request, env, { error: "Invalid local thread payload" }, 400);
    }

    const threadRequest = payload.value;
    try {
      const safetyResponse = await dogfoodSafetyGuardResponse(request, env, "local_thread_create");
      if (safetyResponse) return safetyResponse;
      const connectorId = await chooseConnectorForLocalThread(env, auth.user, threadRequest);
      const session = await requestLocalThreadCreate(env, connectorId, threadRequest);
      const response = await attachCreatedLocalThreadInDb(env, connectorId, threadRequest.workspace_id, session);
      return json(request, env, response, 201);
    } catch (error) {
      if (error instanceof LocalThreadTargetError) {
        return json(request, env, { error: error.message }, error.status);
      }
      if (error instanceof ConnectorRpcError) {
        return json(request, env, { error: error.message }, error.status);
      }
      if (error instanceof NotFoundError) {
        return json(request, env, { error: error.message }, error.status);
      }
      throw error;
    }
  }

  const taskArchiveMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(archive|unarchive)$/);
  if (request.method === "POST" && taskArchiveMatch) {
    const originCheck = validateBrowserOrigin(request, env, { requireOrigin: true });
    if (!originCheck.ok) return json(request, env, { error: originCheck.message }, originCheck.status);
    const auth = await authenticateBrowser(request, env);
    if (!auth.ok) return json(request, env, { error: auth.message }, auth.status);
    if (!env.DB) return json(request, env, { error: "DB binding is required" }, 503);

    const taskId = decodeURIComponent(taskArchiveMatch[1] ?? "");
    try {
      const safetyResponse = await dogfoodSafetyGuardResponse(request, env, "task_archive");
      if (safetyResponse) return safetyResponse;
      const archived = taskArchiveMatch[2] === "archive";
      const task = archived ? await archiveTaskInDb(env, taskId) : await unarchiveTaskInDb(env, taskId);
      const hostSession = await findAttachedHostSessionForTaskInDb(env, taskId);
      const archiveSync = hostSession && isAppServerHostSessionLineage(hostSession)
        ? await requestThreadArchiveSync(env, hostSession, archived)
        : undefined;
      if (hostSession && !archived && archiveSync?.attempted === true && !archiveSync.error) {
        await markHostSessionAppServerPresentInDb(env, hostSession);
      }
      const response: TaskArchiveResponse = {
        task,
        archive_sync: archiveSync
      };
      return json(request, env, response, 200);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return json(request, env, { error: error.message }, error.status);
      }
      if (error instanceof ConnectorRpcError) {
        return json(request, env, { error: error.message }, error.status);
      }
      throw error;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/host-sessions/refresh") {
    const originCheck = validateBrowserOrigin(request, env, { requireOrigin: true });
    if (!originCheck.ok) return json(request, env, { error: originCheck.message }, originCheck.status);
    const auth = await authenticateBrowser(request, env);
    if (!auth.ok) return json(request, env, { error: auth.message }, auth.status);
    if (!env.WORKSPACE_DO) return json(request, env, { error: "Workspace Durable Object binding is unavailable" }, 503);

    const safetyResponse = await dogfoodSafetyGuardResponse(request, env, "host_session_refresh");
    if (safetyResponse) return safetyResponse;
    const refresh = await requestHostSessionRefresh(env);
    const response: RefreshHostSessionsResponse = {
      requested: true,
      dispatched_to: refresh.dispatched_to,
      debounced_connector_count: refresh.debounced_connector_count,
      cooldown_ms: refresh.cooldown_ms,
      server_time: new Date().toISOString()
    };
    return json(request, env, response, 202);
  }

  const threadEventsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/events$/);
  if (request.method === "GET" && threadEventsMatch) {
    const originCheck = validateBrowserOrigin(request, env);
    if (!originCheck.ok) return json(request, env, { error: originCheck.message }, originCheck.status);
    const auth = await authenticateBrowser(request, env);
    if (!auth.ok) return json(request, env, { error: auth.message }, auth.status);
    if (!env.DB) return json(request, env, { error: "DB binding is required" }, 503);

    try {
      const response: ThreadEventsResponse = {
        events: await listThreadEventsInDb(env, decodeURIComponent(threadEventsMatch[1] ?? ""))
      };
      return json(request, env, response, 200);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return json(request, env, { error: error.message }, error.status);
      }
      throw error;
    }
  }

  const attachHostSessionMatch = url.pathname.match(/^\/api\/host-sessions\/([^/]+)\/attach$/);
  if (request.method === "POST" && attachHostSessionMatch) {
    const originCheck = validateBrowserOrigin(request, env, { requireOrigin: true });
    if (!originCheck.ok) return json(request, env, { error: originCheck.message }, originCheck.status);
    const auth = await authenticateBrowser(request, env);
    if (!auth.ok) return json(request, env, { error: auth.message }, auth.status);
    if (!env.DB) return json(request, env, { error: "DB binding is required" }, 503);

    const payload = await readOptionalJson(request);
    if (!payload.ok) {
      return json(request, env, { error: payload.message }, 400);
    }
    if (!isAttachHostSessionRequest(payload.value)) {
      return json(request, env, { error: "Invalid host session attach payload" }, 400);
    }

    try {
      const sessionId = decodeURIComponent(attachHostSessionMatch[1] ?? "");
      const safetyResponse = await dogfoodSafetyGuardResponse(request, env, "host_session_attach");
      if (safetyResponse) return safetyResponse;
      const connectorId = await ensureHostSessionAppServerIfAvailable(env, sessionId, payload.value.connector_id);
      const attachment = await attachHostSessionInDb(
        env,
        sessionId,
        connectorId ?? payload.value.connector_id
      );
      const { attachment_created: attachmentCreated, ...response } = attachment;
      const backfill = attachmentCreated
        ? await requestAndRecordHostSessionBackfill(env, response.host_session)
        : undefined;
      if (backfill) {
        response.events = backfill.events;
        if (backfill.events.length > 0) {
          const latestSeq = Math.max(response.thread.last_seq, ...backfill.events.map((event) => event.seq));
          response.thread = {
            ...response.thread,
            last_seq: latestSeq
          };
        }
        response.backfill = {
          attempted: true,
          imported_event_count: backfill.events.length,
          truncated: backfill.truncated,
          error: backfill.error
        };
      }
      return json(request, env, response, 201);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return json(request, env, { error: error.message }, error.status);
      }
      if (error instanceof ConnectorRpcError) {
        return json(request, env, { error: error.message }, error.status);
      }
      throw error;
    }
  }

  const detachHostSessionMatch = url.pathname.match(/^\/api\/host-sessions\/([^/]+)\/detach$/);
  if (request.method === "POST" && detachHostSessionMatch) {
    const originCheck = validateBrowserOrigin(request, env, { requireOrigin: true });
    if (!originCheck.ok) return json(request, env, { error: originCheck.message }, originCheck.status);
    const auth = await authenticateBrowser(request, env);
    if (!auth.ok) return json(request, env, { error: auth.message }, auth.status);
    if (!env.DB) return json(request, env, { error: "DB binding is required" }, 503);

    const payload = await readOptionalJson(request);
    if (!payload.ok) {
      return json(request, env, { error: payload.message }, 400);
    }
    if (!isDetachHostSessionRequest(payload.value)) {
      return json(request, env, { error: "Invalid host session detach payload" }, 400);
    }

    try {
      const {
        released_connector_ids: releasedConnectorIds,
        failed_events: failedEvents,
        ...response
      } = await detachHostSessionInDb(
        env,
        decodeURIComponent(detachHostSessionMatch[1] ?? ""),
        payload.value.connector_id
      );
      await Promise.all([
        broadcastThreadEvents(env, failedEvents ?? []),
        ...(releasedConnectorIds ?? []).map((targetConnectorId) => dispatchPendingCommand(env, targetConnectorId))
      ]);
      return json(request, env, response, 200);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return json(request, env, { error: error.message }, error.status);
      }
      throw error;
    }
  }

  if (url.pathname === "/ws/browser") {
    const originCheck = validateBrowserOrigin(request, env, { requireOrigin: true });
    if (!originCheck.ok) return json(request, env, { error: originCheck.message }, originCheck.status);
    const auth = await authenticateBrowser(request, env);
    if (!auth.ok) return json(request, env, { error: auth.message }, auth.status);
    return routeWebSocket(request, env, "browser");
  }

  if (url.pathname === "/ws/agent") {
    const auth = await authenticateAgentToken(request, env);
    if (!auth.ok) {
      return json(request, env, { error: auth.message }, auth.status);
    }
    return routeWebSocket(request, env, "agent", auth.connectorId);
  }

  return json(request, env, { error: "Not found" }, 404);
}

async function routeWebSocket(
  request: Request,
  env: Env,
  socketType: "browser" | "agent",
  connectorId?: string
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json(request, env, { error: "Expected WebSocket upgrade" }, 426);
  }

  if (!env.WORKSPACE_DO) {
    return json(request, env, { error: "Workspace Durable Object binding is unavailable" }, 503);
  }

  const id = env.WORKSPACE_DO.idFromName("global");
  const stub = env.WORKSPACE_DO.get(id);
  const upstream = new Request(request);
  upstream.headers.set("x-chaop-socket-type", socketType);
  if (connectorId) {
    upstream.headers.set("x-chaop-connector-id", connectorId);
  }
  return stub.fetch(upstream);
}

export function workerHello(source: "browser" | "agent") {
  return createEnvelope("server.hello", { type: "worker", id: "chaop-api" }, { source });
}

function json(request: Request, env: Env, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders(request, env, {
      "content-type": "application/json; charset=utf-8"
    })
  });
}

async function dogfoodSafetyGuardResponse(
  request: Request,
  env: Env,
  action: Parameters<typeof assertDogfoodSafetyActionAllowed>[1]
): Promise<Response | undefined> {
  try {
    await assertDogfoodSafetyActionAllowed(env, action);
    return undefined;
  } catch (error) {
    if (error instanceof DogfoodSafetyError) {
      return dogfoodSafetyErrorResponse(request, env, error);
    }
    throw error;
  }
}

function dogfoodSafetyErrorResponse(request: Request, env: Env, error: DogfoodSafetyError): Response {
  return json(request, env, {
    error: error.message,
    safety: error.posture,
    guard: error.guard
  }, error.status);
}

function optionsResponse(request: Request, env: Env): Response {
  const originCheck = validateBrowserOrigin(request, env);
  if (!originCheck.ok) {
    return json(request, env, { error: originCheck.message }, originCheck.status);
  }

  return new Response(null, {
    status: 204,
    headers: responseHeaders(request, env, {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-chaop-dev-user",
      "access-control-max-age": "86400"
    })
  });
}

function responseHeaders(request: Request, env: Env, init: HeadersInit): Headers {
  const headers = new Headers(init);
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.append("vary", "Origin");
  }
  return headers;
}

function validateBrowserOrigin(
  request: Request,
  env: Env,
  options: { requireOrigin?: boolean } = {}
): { ok: true } | { ok: false; status: number; message: string } {
  const origin = request.headers.get("origin");
  if (!origin) {
    if (options.requireOrigin && env.CHAOP_DEV_ALLOW_INSECURE !== "true") {
      return { ok: false, status: 403, message: "Missing browser origin" };
    }
    return { ok: true };
  }

  return isAllowedBrowserOrigin(origin, env)
    ? { ok: true }
    : { ok: false, status: 403, message: "Disallowed browser origin" };
}

function allowedOrigin(request: Request, env: Env): string | undefined {
  const origin = request.headers.get("origin");
  return origin && isAllowedBrowserOrigin(origin, env) ? origin : undefined;
}

function isAllowedBrowserOrigin(origin: string, env: Env): boolean {
  const configuredOrigin = originFromDomain(env.CHAOP_GUI_DOMAIN);
  return Boolean(
    (configuredOrigin && origin === configuredOrigin) ||
      (env.CHAOP_DEV_ALLOW_INSECURE === "true" && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
  );
}

function originFromDomain(domain: string | undefined): string | undefined {
  if (!domain) {
    return undefined;
  }
  if (domain.startsWith("http://") || domain.startsWith("https://")) {
    return domain.replace(/\/+$/, "");
  }
  return `https://${domain}`;
}

function connectorControlUrl(url: URL, env: Env): string {
  if (env.CHAOP_DEV_ALLOW_INSECURE === "true" && isLocalHost(url.host)) {
    return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/ws/agent`;
  }

  const domain = env.CHAOP_API_DOMAIN?.replace(/^https?:\/\//, "").replace(/\/+$/, "") ?? url.host;
  return `wss://${domain}/ws/agent`;
}

function isLocalHost(host: string): boolean {
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
}

async function dispatchPendingCommand(env: Env, connectorId: string): Promise<void> {
  if (!env.WORKSPACE_DO) return;

  const id = env.WORKSPACE_DO.idFromName("global");
  const stub = env.WORKSPACE_DO.get(id);
  await stub.fetch("https://workspace-do/internal/dispatch-pending", {
    method: "POST",
    body: JSON.stringify({ connector_id: connectorId })
  });
}

async function broadcastThreadEvents(env: Env, events: ThreadEvent[]): Promise<void> {
  if (!env.WORKSPACE_DO || events.length === 0) return;

  const id = env.WORKSPACE_DO.idFromName("global");
  const stub = env.WORKSPACE_DO.get(id);
  await stub.fetch("https://workspace-do/internal/broadcast-thread-events", {
    method: "POST",
    body: JSON.stringify({ events })
  });
}

async function requestHostSessionRefresh(env: Env): Promise<{
  dispatched_to: number;
  debounced_connector_count?: number | undefined;
  cooldown_ms?: number | undefined;
}> {
  if (!env.WORKSPACE_DO) return { dispatched_to: 0 };

  const id = env.WORKSPACE_DO.idFromName("global");
  const stub = env.WORKSPACE_DO.get(id);
  const response = await stub.fetch("https://workspace-do/internal/refresh-host-sessions", {
    method: "POST"
  });
  const body = await response.json().catch(() => ({})) as {
    dispatched_to?: unknown;
    debounced_connector_count?: unknown;
    cooldown_ms?: unknown;
  };
  return {
    dispatched_to: typeof body.dispatched_to === "number" ? body.dispatched_to : 0,
    debounced_connector_count: typeof body.debounced_connector_count === "number"
      ? body.debounced_connector_count
      : undefined,
    cooldown_ms: typeof body.cooldown_ms === "number" ? body.cooldown_ms : undefined
  };
}

class ConnectorRpcError extends Error {
  constructor(
    message: string,
    public readonly status = 502
  ) {
    super(message);
  }
}

async function requestLocalThreadCreate(
  env: Env,
  connectorId: string,
  request: CreateLocalThreadRequest
): Promise<AgentHostSession> {
  if (!env.WORKSPACE_DO) {
    throw new ConnectorRpcError("Workspace Durable Object binding is unavailable", 503);
  }

  const id = env.WORKSPACE_DO.idFromName("global");
  const stub = env.WORKSPACE_DO.get(id);
  const response = await stub.fetch("https://workspace-do/internal/create-local-thread", {
    method: "POST",
    body: JSON.stringify({
      connector_id: connectorId,
      request_id: `thread-create-${cryptoRandomId().slice(0, 16)}`,
      workspace_id: request.workspace_id,
      title: request.title
    })
  });
  const body = await response.json().catch(() => ({})) as Partial<LocalThreadCreateResult> & { error?: unknown };

  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : "Connector could not create the local thread";
    throw new ConnectorRpcError(message, response.status);
  }
  if (!body.session || !isAgentHostSession(body.session)) {
    throw new ConnectorRpcError("Connector returned an invalid local thread response", 502);
  }
  return body.session;
}

async function ensureHostSessionAppServerIfAvailable(
  env: Env,
  sessionId: string,
  connectorId?: string
): Promise<string | undefined> {
  if (!env.DB) return connectorId;
  const hostSession = await loadHostSessionInDb(env, sessionId, connectorId);
  if (!hostSession) {
    throw new NotFoundError("Host session not found");
  }
  if (await hasLiveHostSessionAttachmentInDb(env, hostSession)) {
    return hostSession.connector_id;
  }
  if (!(await connectorHasCapability(env, hostSession.connector_id, "host_session_app_server_ensure"))) {
    return hostSession.connector_id;
  }

  const session = await requestHostSessionAppServerEnsure(env, hostSession);
  if (session.session_id !== hostSession.session_id) {
    throw new ConnectorRpcError("Connector returned a different app-server host session", 502);
  }
  if (session.app_server_present !== true) {
    throw new ConnectorRpcError("Connector did not return an app-server-backed host session", 502);
  }
  await recordHostSessions(
    env,
    hostSession.connector_id,
    { sessions: [session], inventory_scope: "incremental", app_server_inventory_ok: true },
    new Date().toISOString(),
    { workspaceId: hostSession.workspace_id }
  );
  return hostSession.connector_id;
}

async function requestHostSessionAppServerEnsure(
  env: Env,
  hostSession: HostSessionSummary
): Promise<AgentHostSession> {
  if (!env.WORKSPACE_DO) {
    throw new ConnectorRpcError("Workspace Durable Object binding is unavailable", 503);
  }

  const id = env.WORKSPACE_DO.idFromName("global");
  const stub = env.WORKSPACE_DO.get(id);
  const response = await stub.fetch("https://workspace-do/internal/ensure-host-session-app-server", {
    method: "POST",
    body: JSON.stringify({
      connector_id: hostSession.connector_id,
      request_id: `host-session-app-server-${cryptoRandomId().slice(0, 16)}`,
      session_id: hostSession.session_id,
      title: hostSession.title,
      cwd: hostSession.cwd
    })
  });
  const body = await response.json().catch(() => ({})) as Partial<HostSessionAppServerEnsureResult> & { error?: unknown };

  if (!response.ok) {
    const message = typeof body.error === "string"
      ? body.error
      : "Connector could not attach the host session through app-server";
    throw new ConnectorRpcError(message, response.status);
  }
  if (!body.session || !isAgentHostSession(body.session)) {
    throw new ConnectorRpcError("Connector returned an invalid app-server host session response", 502);
  }
  return body.session;
}

async function requestThreadArchiveSync(
  env: Env,
  hostSession: HostSessionSummary,
  archived: boolean
): Promise<TaskArchiveSyncSummary> {
  const availability = await appServerArchiveAvailability(env, hostSession.connector_id);
  if (!availability.available) {
    return {
      attempted: false,
      connector_id: hostSession.connector_id,
      session_id: hostSession.session_id,
      archived,
      error: availability.error
    };
  }
  if (!env.WORKSPACE_DO) {
    return {
      attempted: false,
      connector_id: hostSession.connector_id,
      session_id: hostSession.session_id,
      archived,
      error: "Workspace Durable Object binding is unavailable"
    };
  }

  const id = env.WORKSPACE_DO.idFromName("global");
  const stub = env.WORKSPACE_DO.get(id);
  let response: Response;
  try {
    response = await stub.fetch("https://workspace-do/internal/sync-thread-archive", {
      method: "POST",
      body: JSON.stringify({
        connector_id: hostSession.connector_id,
        request_id: `thread-archive-${cryptoRandomId().slice(0, 16)}`,
        session_id: hostSession.session_id,
        archived
      })
    });
  } catch (error) {
    return {
      attempted: true,
      connector_id: hostSession.connector_id,
      session_id: hostSession.session_id,
      archived,
      error: error instanceof Error ? error.message : "Connector could not sync the thread archive state"
    };
  }
  const body = await response.json().catch(() => ({})) as { error?: unknown; synced?: unknown };

  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : "Connector could not sync the thread archive state";
    return {
      attempted: true,
      connector_id: hostSession.connector_id,
      session_id: hostSession.session_id,
      archived,
      error: message
    };
  }

  return {
    attempted: body.synced !== false,
    connector_id: hostSession.connector_id,
    session_id: hostSession.session_id,
    archived,
    error: body.synced === false ? "No matching app-server thread was found" : undefined
  };
}

function isAppServerHostSessionLineage(hostSession: HostSessionSummary): boolean {
  return hostSession.app_server_present === true || hostSession.title_source === "app_server";
}

async function requestAndRecordHostSessionBackfill(
  env: Env,
  hostSession: HostSessionSummary
): Promise<{
  events: Awaited<ReturnType<typeof recordHostSessionBackfillEvents>>;
  truncated?: boolean | undefined;
  error?: string | undefined;
} | undefined> {
  if (!env.DB || !env.WORKSPACE_DO || !hostSession.connector_id || !hostSession.attached_thread_id) {
    return undefined;
  }
  if (!(await connectorSupportsHostSessionBackfill(env, hostSession.connector_id))) {
    return undefined;
  }

  try {
    const result = await requestHostSessionBackfill(env, hostSession.connector_id, hostSession.session_id);
    const events = await recordHostSessionBackfillEvents(env, hostSession, result.events ?? []);
    return { events, truncated: result.truncated };
  } catch (error) {
    return {
      events: [],
      error: error instanceof Error ? error.message : "Host session history backfill failed"
    };
  }
}

async function connectorSupportsHostSessionBackfill(env: Env, connectorId: string): Promise<boolean> {
  return connectorHasCapability(env, connectorId, "host_session_backfill_v2");
}

async function connectorSupportsAppServerArchive(env: Env, connectorId: string): Promise<boolean> {
  return (await appServerArchiveAvailability(env, connectorId)).available;
}

async function appServerArchiveAvailability(
  env: Env,
  connectorId: string
): Promise<{ available: boolean; error: string }> {
  if (!env.DB) {
    return { available: false, error: "DB binding is required" };
  }
  const row = await env.DB.prepare(
    `SELECT status, capabilities_json
     FROM connectors
     WHERE id = ?
     LIMIT 1`
  )
    .bind(connectorId)
    .first<{ status: string; capabilities_json: string | null }>();
  if (!row) {
    return { available: false, error: "Connector is not registered" };
  }
  if (row.status === "offline") {
    return { available: false, error: "Connector is offline" };
  }
  if (row.status !== "online") {
    return { available: false, error: "Connector is not ready" };
  }
  try {
    const capabilities = JSON.parse(row.capabilities_json ?? "[]") as unknown;
    if (Array.isArray(capabilities) && capabilities.includes("app_server_archive")) {
      return { available: true, error: "" };
    }
  } catch {
    return { available: false, error: "Connector capability metadata is invalid" };
  }
  return { available: false, error: "Connector does not support app-server archive sync" };
}

async function connectorHasCapability(env: Env, connectorId: string, capability: string): Promise<boolean> {
  if (!env.DB) return false;
  const row = await env.DB.prepare(
    `SELECT capabilities_json
     FROM connectors
     WHERE id = ? AND status = 'online'
     LIMIT 1`
  )
    .bind(connectorId)
    .first<{ capabilities_json: string | null }>();
  if (!row?.capabilities_json) return false;
  try {
    const capabilities = JSON.parse(row.capabilities_json) as unknown;
    return Array.isArray(capabilities) && capabilities.includes(capability);
  } catch {
    return false;
  }
}

async function requestHostSessionBackfill(
  env: Env,
  connectorId: string,
  sessionId: string
): Promise<{ events: AgentBackfillEvent[]; truncated?: boolean }> {
  if (!env.WORKSPACE_DO) {
    throw new ConnectorRpcError("Workspace Durable Object binding is unavailable", 503);
  }

  const id = env.WORKSPACE_DO.idFromName("global");
  const stub = env.WORKSPACE_DO.get(id);
  const response = await stub.fetch("https://workspace-do/internal/backfill-host-session", {
    method: "POST",
    body: JSON.stringify({
      connector_id: connectorId,
      request_id: `host-session-backfill-${cryptoRandomId().slice(0, 16)}`,
      session_id: sessionId,
      limit: HOST_SESSION_BACKFILL_EVENT_LIMIT
    })
  });
  const body = await response.json().catch(() => ({})) as {
    events?: unknown;
    truncated?: unknown;
    error?: unknown;
  };

  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : "Connector could not backfill the host session";
    throw new ConnectorRpcError(message, response.status);
  }
  if (body.events !== undefined && !Array.isArray(body.events)) {
    throw new ConnectorRpcError("Connector returned an invalid host session backfill response", 502);
  }
  const events = (body.events ?? []).filter(isAgentBackfillEvent);
  return {
    events: events.slice(-HOST_SESSION_BACKFILL_EVENT_LIMIT),
    truncated: body.truncated === true || events.length > HOST_SESSION_BACKFILL_EVENT_LIMIT
  };
}

async function readJson(
  request: Request
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, message: "Invalid JSON request body" };
  }
}

async function readOptionalJson(
  request: Request
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const text = await request.text();
  if (text.trim().length === 0) {
    return { ok: true, value: {} };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, message: "Invalid JSON request body" };
  }
}

function isAgentBootstrapRequest(value: unknown): value is AgentBootstrapRequest {
  return (
    isRecord(value) &&
    isNonEmptyString(value.connector_name) &&
    isNonEmptyString(value.hostname) &&
    isNonEmptyString(value.workspace_root) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((item) => typeof item === "string")
  );
}

function isCreateCommandRequest(value: unknown): value is CreateCommandRequest {
  return (
    isRecord(value) &&
    isNonEmptyString(value.workspace_id) &&
    isNonEmptyString(value.prompt) &&
    optionalString(value.thread_id) &&
    optionalString(value.task_id) &&
    optionalCommandType(value.type) &&
    optionalCommandExecutionMode(value.execution_mode) &&
    commandExecutionModeMatchesType(value) &&
    optionalString(value.target_connector_id)
  );
}

function isSetDogfoodSafetyPauseRequest(value: unknown): value is SetDogfoodSafetyPauseRequest {
  return isRecord(value) && optionalString(value.reason);
}

function isCreateLocalThreadRequest(value: unknown): value is CreateLocalThreadRequest {
  return (
    isRecord(value) &&
    isNonEmptyString(value.workspace_id) &&
    optionalString(value.title) &&
    optionalString(value.connector_id)
  );
}

function isAttachHostSessionRequest(value: unknown): value is AttachHostSessionRequest {
  return isRecord(value) && optionalString(value.connector_id);
}

function isDetachHostSessionRequest(value: unknown): value is DetachHostSessionRequest {
  return isRecord(value) && optionalString(value.connector_id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function optionalCommandType(value: unknown): value is CreateCommandRequest["type"] {
  return value === undefined || value === "placeholder" || value === "codex";
}

function optionalCommandExecutionMode(value: unknown): value is CreateCommandRequest["execution_mode"] {
  return value === undefined || value === "app_server" || value === "codex_cli_fallback";
}

function commandExecutionModeMatchesType(value: Record<string, unknown>): boolean {
  return value.execution_mode === undefined || value.type === "codex";
}

function isAgentHostSession(value: unknown): value is AgentHostSession {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.session_id) &&
    isNonEmptyString(value.title) &&
    (value.title_source === "metadata" ||
      value.title_source === "app_server" ||
      value.title_source === "history" ||
      value.title_source === "fallback") &&
    (value.app_server_present === undefined || typeof value.app_server_present === "boolean") &&
    optionalString(value.cwd) &&
    isNonEmptyString(value.updated_at)
  );
}

function isAgentBackfillEvent(value: unknown): value is AgentBackfillEvent {
  if (!isRecord(value)) return false;
  return (
    isThreadEventKind(value.kind) &&
    (value.priority === "P0" || value.priority === "P1" || value.priority === "P2" || value.priority === "P3") &&
    isNonEmptyString(value.summary) &&
    isNonEmptyString(value.idempotency_key) &&
    isNonEmptyString(value.created_at)
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

function stableConnectorId(name: string, hostname: string): string {
  const slug = `${name}-${hostname}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `connector-${slug || "local"}`;
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function allowsSampleData(env: Env): boolean {
  return env.CHAOP_DEV_ALLOW_INSECURE === "true";
}
