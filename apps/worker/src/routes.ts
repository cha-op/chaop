import {
  createEnvelope,
  type AgentHostSession,
  type AttachHostSessionRequest,
  type AgentBootstrapRequest,
  type AgentBootstrapResponse,
  type CreateCommandRequest,
  type CreateCommandResponse,
  type CreateLocalThreadRequest,
  type DetachHostSessionRequest,
  type LocalThreadCreateResult,
  type RefreshHostSessionsResponse
} from "@chaop/protocol";
import {
  authenticateAgentBootstrap,
  authenticateAgentToken,
  authenticateBrowser,
  issueAgentToken
} from "./auth.js";
import {
  CommandTargetError,
  LocalThreadTargetError,
  NotFoundError,
  archiveTaskInDb,
  attachCreatedLocalThreadInDb,
  attachHostSessionInDb,
  chooseConnectorForLocalThread,
  createCommandInDb,
  detachHostSessionInDb,
  ensureConnectorInventory,
  loadBootstrapFromDb,
  unarchiveTaskInDb
} from "./db.js";
import { budget, sampleBootstrap } from "./sample-data.js";
import type { Env } from "./types.js";

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
    return json(request, env, budget);
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
      const connectorId = await chooseConnectorForLocalThread(env, auth.user, threadRequest);
      const session = await requestLocalThreadCreate(env, connectorId, threadRequest);
      const response = await attachCreatedLocalThreadInDb(env, connectorId, session);
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
      const task = taskArchiveMatch[2] === "archive"
        ? await archiveTaskInDb(env, taskId)
        : await unarchiveTaskInDb(env, taskId);
      return json(request, env, { task }, 200);
    } catch (error) {
      if (error instanceof NotFoundError) {
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

    const dispatchedTo = await requestHostSessionRefresh(env);
    const response: RefreshHostSessionsResponse = {
      requested: true,
      dispatched_to: dispatchedTo,
      server_time: new Date().toISOString()
    };
    return json(request, env, response, 202);
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
      const response = await attachHostSessionInDb(
        env,
        decodeURIComponent(attachHostSessionMatch[1] ?? ""),
        payload.value.connector_id
      );
      return json(request, env, response, 201);
    } catch (error) {
      if (error instanceof NotFoundError) {
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
      const response = await detachHostSessionInDb(
        env,
        decodeURIComponent(detachHostSessionMatch[1] ?? ""),
        payload.value.connector_id
      );
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

async function requestHostSessionRefresh(env: Env): Promise<number> {
  if (!env.WORKSPACE_DO) return 0;

  const id = env.WORKSPACE_DO.idFromName("global");
  const stub = env.WORKSPACE_DO.get(id);
  const response = await stub.fetch("https://workspace-do/internal/refresh-host-sessions", {
    method: "POST"
  });
  const body = await response.json().catch(() => ({})) as { dispatched_to?: unknown };
  return typeof body.dispatched_to === "number" ? body.dispatched_to : 0;
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
      title: request.title,
      cwd: request.cwd
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
    optionalString(value.target_connector_id)
  );
}

function isCreateLocalThreadRequest(value: unknown): value is CreateLocalThreadRequest {
  return (
    isRecord(value) &&
    isNonEmptyString(value.workspace_id) &&
    optionalString(value.title) &&
    optionalString(value.connector_id) &&
    optionalString(value.cwd)
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

function isAgentHostSession(value: unknown): value is AgentHostSession {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.session_id) &&
    isNonEmptyString(value.title) &&
    (value.title_source === "metadata" ||
      value.title_source === "app_server" ||
      value.title_source === "history" ||
      value.title_source === "fallback") &&
    optionalString(value.cwd) &&
    isNonEmptyString(value.updated_at)
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
