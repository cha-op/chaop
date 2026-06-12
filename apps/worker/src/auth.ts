import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./types.js";

export type AuthResult =
  | { ok: true; user: BrowserIdentity }
  | { ok: false; status: number; message: string };

export type AgentAuthResult =
  | { ok: true; connectorId: string }
  | { ok: false; status: number; message: string };

export type BrowserIdentity = {
  id: string;
  email: string;
  name: string;
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticateBrowser(request: Request, env: Env): Promise<AuthResult> {
  if (env.CHAOP_DEV_ALLOW_INSECURE === "true") {
    const email = request.headers.get("x-chaop-dev-user") ?? "dev@example.com";
    return { ok: true, user: userIdentity(email) };
  }

  const accessJwt = request.headers.get("cf-access-jwt-assertion");
  if (!accessJwt) {
    return {
      ok: false,
      status: 401,
      message: "Missing Cloudflare Access JWT. Confirm this API route is covered by the Browser Access application, or refresh the Access login session."
    };
  }

  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) {
    return { ok: false, status: 403, message: "Missing Cloudflare Access verification config" };
  }

  try {
    const teamDomain = normaliseTeamDomain(env.ACCESS_TEAM_DOMAIN);
    const { payload } = await jwtVerify(accessJwt, jwksForTeam(teamDomain), {
      issuer: teamDomain,
      audience: env.ACCESS_AUD
    });
    const user = identityFromAccessPayload(payload);
    if (!user) {
      return { ok: false, status: 401, message: "Missing Cloudflare Access user identity" };
    }
    return { ok: true, user };
  } catch {
    return { ok: false, status: 403, message: "Invalid Cloudflare Access JWT" };
  }
}

export function authenticateAgentBootstrap(request: Request, env: Env): boolean {
  const expected = env.AGENT_BOOTSTRAP_SECRET;
  const received = request.headers.get("x-chaop-bootstrap-secret");
  return Boolean(expected && received && safeEqual(expected, received));
}

export async function issueAgentToken(
  connectorId: string,
  env: Env,
  registration: {
    connectorName: string;
    hostname: string;
    workspaceRoot: string;
    capabilities: string[];
  }
): Promise<string> {
  if (!env.AGENT_BOOTSTRAP_SECRET) {
    throw new Error("AGENT_BOOTSTRAP_SECRET is required to issue connector tokens");
  }

  if (!env.DB && env.CHAOP_DEV_ALLOW_INSECURE === "true") {
    return issueDevAgentToken(connectorId, env.AGENT_BOOTSTRAP_SECRET);
  }

  if (!env.DB) {
    throw new Error("DB binding is required to issue connector tokens");
  }

  const token = `chaop_agent_${base64UrlEncode(connectorId)}.${cryptoRandomId()}`;
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO connectors (
      id, name, hostname, token_hash, status, realtime_mode, budget_state,
      logical_agent_count, active_command_count, capabilities_json, workspace_root,
      last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'online', 'summary', 'normal', 0, 0, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      hostname = excluded.hostname,
      token_hash = excluded.token_hash,
      status = 'online',
      capabilities_json = excluded.capabilities_json,
      workspace_root = excluded.workspace_root,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at`
  )
    .bind(
      connectorId,
      registration.connectorName,
      registration.hostname,
      tokenHash,
      JSON.stringify(registration.capabilities),
      registration.workspaceRoot,
      now,
      now,
      now
    )
    .run();

  return token;
}

export async function authenticateAgentToken(request: Request, env: Env): Promise<AgentAuthResult> {
  const authorization = request.headers.get("authorization");
  const tokenHeader = request.headers.get("x-chaop-agent-token");
  const token = tokenHeader ?? bearerToken(authorization);
  if (!token?.startsWith("chaop_agent_") || !env.AGENT_BOOTSTRAP_SECRET) {
    return { ok: false, status: 401, message: "Invalid connector token" };
  }

  if (!env.DB && env.CHAOP_DEV_ALLOW_INSECURE === "true") {
    return authenticateDevAgentToken(token, env.AGENT_BOOTSTRAP_SECRET);
  }

  if (!env.DB) {
    return { ok: false, status: 503, message: "Connector token store is unavailable" };
  }

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT id, status FROM connectors WHERE token_hash = ? LIMIT 1"
  )
    .bind(tokenHash)
    .first<{ id: string; status: string }>();

  if (!row || row.status === "offline") {
    return { ok: false, status: 401, message: "Invalid connector token" };
  }

  return { ok: true, connectorId: row.id };
}

function issueDevAgentToken(connectorId: string, secret: string): Promise<string> {
  return tokenSignature(connectorId, secret).then((signature) => {
    return `chaop_agent_dev_${base64UrlEncode(connectorId)}.${signature}`;
  });
}

async function authenticateDevAgentToken(token: string, secret: string): Promise<AgentAuthResult> {
  if (!token.startsWith("chaop_agent_dev_")) {
    return { ok: false, status: 401, message: "Invalid connector token" };
  }

  const tokenBody = token.slice("chaop_agent_dev_".length);
  const [connectorPart, receivedSignature] = tokenBody.split(".");
  if (!connectorPart || !receivedSignature) {
    return { ok: false, status: 401, message: "Invalid connector token" };
  }

  try {
    const connectorId = base64UrlDecode(connectorPart);
    const expectedSignature = await tokenSignature(connectorId, secret);
    if (!safeEqual(expectedSignature, receivedSignature)) {
      return { ok: false, status: 401, message: "Invalid connector token" };
    }
    return { ok: true, connectorId };
  } catch {
    return { ok: false, status: 401, message: "Invalid connector token" };
  }
}

function safeEqual(expected: string, received: string): boolean {
  if (expected.length !== received.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ received.charCodeAt(index);
  }
  return diff === 0;
}

function bearerToken(value: string | null): string | undefined {
  if (!value?.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  return value.slice("bearer ".length);
}

function jwksForTeam(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(teamDomain);
  if (cached) {
    return cached;
  }

  const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
  jwksCache.set(teamDomain, jwks);
  return jwks;
}

function normaliseTeamDomain(teamDomain: string): string {
  return teamDomain.replace(/\/+$/, "");
}

function emailFromPayload(payload: JWTPayload): string | undefined {
  const email = payload.email;
  return typeof email === "string" && email.includes("@") ? email : undefined;
}

export function identityFromAccessPayload(payload: JWTPayload): BrowserIdentity | undefined {
  const email = emailFromPayload(payload);
  if (email) {
    return userIdentity(email);
  }

  const serviceTokenName =
    stringClaim(payload, "common_name") ??
    stringClaim(payload, "name") ??
    stringClaim(payload, "sub");
  if (!serviceTokenName) {
    return undefined;
  }

  const slug = serviceTokenName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "service-token";
  return {
    id: `access-service-${slug}`,
    email: `${slug}@service.chaop.local`,
    name: `Access service token: ${serviceTokenName}`
  };
}

function userIdentity(email: string): BrowserIdentity {
  const normalised = email.toLowerCase();
  return {
    id: `user-${normalised.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    email: normalised,
    name: normalised.split("@")[0] ?? normalised
  };
}

function stringClaim(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

async function tokenSignature(connectorId: string, secret: string): Promise<string> {
  return sha256Hex(`${connectorId}:${secret}`);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): string {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
}
