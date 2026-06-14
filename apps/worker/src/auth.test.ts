import assert from "node:assert/strict";
import test from "node:test";
import { authenticateAgentToken, identityFromAccessPayload, issueAgentToken } from "./auth.js";
import type { Env } from "./types.js";

test("Access email identity is normalised for browser API users", () => {
  const identity = identityFromAccessPayload({ email: "Operator@Example.COM" });

  assert.deepEqual(identity, {
    id: "user-operator-example-com",
    email: "operator@example.com",
    name: "operator"
  });
});

test("Access service token identity can omit email", () => {
  const identity = identityFromAccessPayload({
    common_name: "Chaop E2E Service Token",
    sub: "service-token-id"
  });

  assert.deepEqual(identity, {
    id: "access-service-chaop-e2e-service-token",
    email: "chaop-e2e-service-token@service.chaop.local",
    name: "Access service token: Chaop E2E Service Token"
  });
});

test("connector tokens authenticate without marking the connector dispatch-ready", async () => {
  const db = offlineConnectorTokenDb();
  const result = await authenticateAgentToken(
    new Request("https://api.example.com/ws/agent", {
      headers: {
        authorization: "Bearer chaop_agent_valid-token"
      }
    }),
    {
      DB: db,
      AGENT_BOOTSTRAP_SECRET: "test-bootstrap"
    } as Env
  );

  assert.deepEqual(result, { ok: true, connectorId: "connector-offline" });
  assert.equal(db.prepareCount, 1);
});

test("connector bootstrap token issuance registers connector as degraded until agent.ready", async () => {
  const db = tokenIssueDb();
  const token = await issueAgentToken(
    "connector-online",
    {
      DB: db,
      AGENT_BOOTSTRAP_SECRET: "test-bootstrap"
    } as Env,
    {
      connectorName: "mac-studio",
      hostname: "mac-studio.local",
      workspaceRoot: "/workspace",
      capabilities: ["codex_exec"]
    }
  );

  assert.equal(token.startsWith("chaop_agent_"), true);
  assert.equal(db.connectorWrites, 1);
});

function offlineConnectorTokenDb() {
  const counters = {
    prepareCount: 0
  };
  const db = {
    prepare(sql: string) {
      counters.prepareCount += 1;
      if (/SELECT id FROM connectors WHERE token_hash = \?/.test(sql)) {
        return {
          bind(tokenHash: string) {
            assert.match(tokenHash, /^[0-9a-f]{64}$/);
            return {
              async first() {
                return { id: "connector-offline" };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get prepareCount() {
      return counters.prepareCount;
    }
  };

  return db as D1Database & typeof counters;
}

function tokenIssueDb() {
  const counters = {
    connectorWrites: 0
  };
  const db = {
    prepare(sql: string) {
      if (/INSERT INTO connectors/.test(sql)) {
        assert.match(sql, /VALUES \(\?, \?, \?, \?, 'degraded'/);
        assert.match(sql, /status = 'degraded'/);
        assert.match(sql, /active_command_count = 0/);
        return {
          bind(
            connectorId: string,
            connectorName: string,
            hostname: string,
            tokenHash: string,
            capabilitiesJson: string,
            workspaceRoot: string,
            lastSeenAt: string,
            createdAt: string,
            updatedAt: string
          ) {
            assert.equal(connectorId, "connector-online");
            assert.equal(connectorName, "mac-studio");
            assert.equal(hostname, "mac-studio.local");
            assert.match(tokenHash, /^[0-9a-f]{64}$/);
            assert.deepEqual(JSON.parse(capabilitiesJson), ["codex_exec"]);
            assert.equal(workspaceRoot, "/workspace");
            assert.match(lastSeenAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            return {
              async run() {
                counters.connectorWrites += 1;
                return { success: true };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get connectorWrites() {
      return counters.connectorWrites;
    }
  };

  return db as D1Database & typeof counters;
}
