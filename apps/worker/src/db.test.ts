import assert from "node:assert/strict";
import test from "node:test";
import { recordAgentEvent } from "./db.js";
import type { Env } from "./types.js";

test("recordAgentEvent ignores stale events from a connector that lost the lease", async () => {
  const db = agentEventGuardDb({
    leaseOwnerConnectorId: "connector-new",
    state: "leased"
  });

  const event = await recordAgentEvent({ DB: db } as Env, "connector-old", {
    command_id: "command-1",
    kind: "command.finished",
    priority: "P1",
    summary: "Late completion"
  });

  assert.equal(event, undefined);
  assert.equal(db.commandUpdates, 0);
  assert.equal(db.eventInserts, 0);
});

test("recordAgentEvent accepts events from the active lease owner", async () => {
  const db = agentEventGuardDb({
    leaseOwnerConnectorId: "connector-online",
    state: "leased"
  });

  const event = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    kind: "command.finished",
    priority: "P1",
    summary: "Finished"
  });

  assert.equal(event?.kind, "command.finished");
  assert.equal(event?.summary, "Finished");
  assert.equal(db.commandUpdates, 1);
  assert.equal(db.taskUpdates, 1);
  assert.equal(db.eventInserts, 1);
});

function agentEventGuardDb(command: {
  leaseOwnerConnectorId: string;
  state: "leased" | "running" | "succeeded";
}) {
  const counters = {
    commandUpdates: 0,
    taskUpdates: 0,
    eventInserts: 0
  };
  const db = {
    prepare(sql: string) {
      if (/SELECT id, workspace_id, thread_id, task_id, target_connector_id, lease_owner_connector_id, state/.test(sql)) {
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
                  target_connector_id: null,
                  lease_owner_connector_id: command.leaseOwnerConnectorId,
                  state: command.state
                };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /lease_owner_connector_id = \?/.test(sql) && /state IN \('leased', 'running'\)/.test(sql)) {
        return {
          bind(
            nextState: string,
            connectorId: string,
            updatedAt: string,
            commandId: string,
            ownerConnectorId: string
          ) {
            assert.equal(nextState, "succeeded");
            assert.equal(connectorId, "connector-online");
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(ownerConnectorId, "connector-online");
            return {
              async run() {
                counters.commandUpdates += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/UPDATE tasks/.test(sql)) {
        return {
          bind(taskState: string, connectorId: string, updatedAt: string, taskId: string) {
            assert.equal(taskState, "done");
            assert.equal(connectorId, "connector-online");
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

      if (/SELECT last_seq/.test(sql)) {
        return {
          bind(threadId: string) {
            assert.equal(threadId, "thread-1");
            return {
              async first() {
                return { last_seq: 0 };
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
                counters.eventInserts += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE threads/.test(sql) || /UPDATE connectors/.test(sql)) {
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

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get commandUpdates() {
      return counters.commandUpdates;
    },
    get taskUpdates() {
      return counters.taskUpdates;
    },
    get eventInserts() {
      return counters.eventInserts;
    }
  };

  return db as D1Database & typeof counters;
}
