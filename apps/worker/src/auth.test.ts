import assert from "node:assert/strict";
import test from "node:test";
import { authenticateAgentToken, identityFromAccessPayload } from "./auth.js";
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

test("offline connector tokens can authenticate and mark the connector online", async () => {
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
  assert.equal(db.onlineUpdates, 1);
});

function offlineConnectorTokenDb() {
  const counters = {
    onlineUpdates: 0
  };
  const db = {
    prepare(sql: string) {
      if (/SELECT id, status FROM connectors WHERE token_hash = \?/.test(sql)) {
        return {
          bind(tokenHash: string) {
            assert.match(tokenHash, /^[0-9a-f]{64}$/);
            return {
              async first() {
                return { id: "connector-offline", status: "offline" };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /status = 'online'/.test(sql)) {
        return {
          bind(lastSeenAt: string, updatedAt: string, connectorId: string) {
            assert.match(lastSeenAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-offline");
            return {
              async run() {
                counters.onlineUpdates += 1;
                return { success: true };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get onlineUpdates() {
      return counters.onlineUpdates;
    }
  };

  return db as D1Database & typeof counters;
}
