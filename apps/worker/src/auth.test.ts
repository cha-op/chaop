import assert from "node:assert/strict";
import test from "node:test";
import { identityFromAccessPayload } from "./auth.js";

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
