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

  assert.equal(response.status, 401);
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
    new Request("https://api.example.com/api/agent/bootstrap", { method: "POST", body: "{}" }),
    devEnv
  );

  assert.equal(response.status, 401);
});

test("agent bootstrap rejects malformed JSON", async () => {
  const response = await handleRequest(
    new Request("https://api.example.com/api/agent/bootstrap", {
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
    new Request("https://api.example.com/api/agent/bootstrap", {
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
    new Request("https://api.example.com/api/agent/bootstrap", {
      method: "POST",
      headers: { "x-chaop-bootstrap-secret": "test-bootstrap" },
      body: JSON.stringify({
        connector_name: "mac-studio",
        hostname: "mac-studio.local",
        workspace_root: "/Users/joey/Program",
        capabilities: ["placeholder"]
      })
    }),
    devEnv
  );
  const body = (await response.json()) as { connector_id: string; token: string; control_url: string };

  assert.equal(response.status, 201);
  assert.match(body.connector_id, /^connector-mac-studio-mac-studio-local-[0-9a-f]{12}$/);
  assert.equal(body.token.startsWith("chaop_agent_"), true);
  assert.equal(body.control_url, "wss://api.example.com/ws/agent");
});

test("agent bootstrap returns local websocket URL in insecure local dev", async () => {
  const response = await handleRequest(
    new Request("http://127.0.0.1:8787/api/agent/bootstrap", {
      method: "POST",
      headers: { "x-chaop-bootstrap-secret": "test-bootstrap" },
      body: JSON.stringify({
        connector_name: "mac-studio",
        hostname: "mac-studio.local",
        workspace_root: "/Users/joey/Program",
        capabilities: ["placeholder"]
      })
    }),
    devEnv
  );
  const body = (await response.json()) as { control_url: string };

  assert.equal(response.status, 201);
  assert.equal(body.control_url, "ws://127.0.0.1:8787/ws/agent");
});

test("agent bootstrap creates unique connector ids for repeated names", async () => {
  const body = JSON.stringify({
    connector_name: "mac-studio",
    hostname: "mac-studio.local",
    workspace_root: "/Users/joey/Program",
    capabilities: ["placeholder"]
  });
  const first = await handleRequest(
    new Request("https://api.example.com/api/agent/bootstrap", {
      method: "POST",
      headers: { "x-chaop-bootstrap-secret": "test-bootstrap" },
      body
    }),
    devEnv
  );
  const second = await handleRequest(
    new Request("https://api.example.com/api/agent/bootstrap", {
      method: "POST",
      headers: { "x-chaop-bootstrap-secret": "test-bootstrap" },
      body
    }),
    devEnv
  );

  assert.notEqual(
    ((await first.json()) as { connector_id: string }).connector_id,
    ((await second.json()) as { connector_id: string }).connector_id
  );
});

test("agent websocket accepts bootstrap-issued connector token before Durable Object routing", async () => {
  const bootstrapResponse = await handleRequest(
    new Request("https://api.example.com/api/agent/bootstrap", {
      method: "POST",
      headers: { "x-chaop-bootstrap-secret": "test-bootstrap" },
      body: JSON.stringify({
        connector_name: "mac-studio",
        hostname: "mac-studio.local",
        workspace_root: "/Users/joey/Program",
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

function readOnlyBootstrapDb(): D1Database {
  return {
    prepare(sql: string) {
      assert.doesNotMatch(sql, /INSERT INTO users/);
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
  options: { supportsCodex?: boolean } = {}
): D1Database {
  const supportsCodex = options.supportsCodex ?? true;
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

      if (/SELECT c\.id/.test(sql) && /WHERE c\.id = \?/.test(sql)) {
        assert.match(sql, /workspace_connectors/);
        assert.match(sql, /wc\.workspace_id = \?/);
        assert.match(sql, /wc\.can_execute = 1/);
        assert.match(sql, /c\.status <> 'offline'/);
        assert.match(sql, /capabilities_json LIKE/);
        return {
          bind(connectorId: string, workspaceId: string, commandType: string) {
            assert.equal(connectorId.startsWith("connector-"), true);
            assert.equal(workspaceId, "workspace-api");
            assert.equal(commandType === "placeholder" || commandType === "codex", true);
            return {
              async first() {
                if (commandType === "codex" && !supportsCodex) {
                  return null;
                }
                return row;
              }
            };
          }
        };
      }

      if (/INSERT INTO commands/.test(sql) || /INSERT INTO events/.test(sql) || /UPDATE threads/.test(sql)) {
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

      if (/SELECT last_seq/.test(sql)) {
        return {
          bind(threadId: string) {
            assert.equal(threadId, "thread-orders-500");
            return {
              async first() {
                return { last_seq: 0 };
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
