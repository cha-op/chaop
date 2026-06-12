import assert from "node:assert/strict";
import test from "node:test";
import { markConnectorDisconnected, recordAgentEvent } from "./db.js";
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

test("recordAgentEvent marks failed command tasks as failed", async () => {
  const db = agentEventGuardDb(
    {
      leaseOwnerConnectorId: "connector-online",
      state: "running"
    },
    {
      expectedCommandState: "failed",
      expectedTaskState: "failed"
    }
  );

  const event = await recordAgentEvent({ DB: db } as Env, "connector-online", {
    command_id: "command-1",
    kind: "command.failed",
    priority: "P1",
    summary: "Failed"
  });

  assert.equal(event?.kind, "command.failed");
  assert.equal(db.commandUpdates, 1);
  assert.equal(db.taskUpdates, 1);
  assert.equal(db.eventInserts, 1);
});

test("markConnectorDisconnected fails active commands and marks connector offline", async () => {
  const db = connectorDisconnectedDb();

  const events = await markConnectorDisconnected({ DB: db } as Env, "connector-online");

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "command.failed");
  assert.equal(events[0]?.seq, 8);
  assert.equal(db.commandFailures, 1);
  assert.equal(db.taskUpdates, 1);
  assert.equal(db.eventInserts, 1);
  assert.equal(db.connectorOfflineUpdates, 1);
});

function agentEventGuardDb(command: {
  leaseOwnerConnectorId: string;
  state: "leased" | "running" | "succeeded";
}, options: {
  expectedCommandState?: string;
  expectedTaskState?: string;
} = {}) {
  const expectedCommandState = options.expectedCommandState ?? "succeeded";
  const expectedTaskState = options.expectedTaskState ?? "done";
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
            assert.equal(nextState, expectedCommandState);
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
            assert.equal(taskState, expectedTaskState);
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
        throw new Error("appendEvent must allocate event sequence with UPDATE ... RETURNING");
      }

      if (/UPDATE threads/.test(sql) && /RETURNING last_seq/.test(sql)) {
        return {
          bind(updatedAt: string, threadId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(threadId, "thread-1");
            return {
              async first() {
                return { last_seq: 1 };
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

function connectorDisconnectedDb() {
  const counters = {
    commandFailures: 0,
    taskUpdates: 0,
    eventInserts: 0,
    connectorOfflineUpdates: 0
  };
  const db = {
    prepare(sql: string) {
      if (/FROM commands/.test(sql) && /lease_owner_connector_id = \?/.test(sql) && /state IN \('leased', 'running'\)/.test(sql)) {
        return {
          bind(connectorId: string) {
            assert.equal(connectorId, "connector-online");
            return {
              async all() {
                return {
                  results: [
                    {
                      id: "command-1",
                      workspace_id: "workspace-api",
                      thread_id: "thread-1",
                      task_id: "task-1",
                      type: "codex",
                      prompt: "continue",
                      state: "running",
                      target_connector_id: "connector-online",
                      created_at: "2026-06-12T10:00:00.000Z",
                      updated_at: "2026-06-12T10:00:01.000Z"
                    }
                  ]
                };
              }
            };
          }
        };
      }

      if (/UPDATE commands/.test(sql) && /state = 'failed'/.test(sql)) {
        return {
          bind(updatedAt: string, commandId: string, connectorId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(commandId, "command-1");
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.commandFailures += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }

      if (/UPDATE tasks/.test(sql)) {
        return {
          bind(updatedAt: string, taskId: string) {
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

      if (/UPDATE threads/.test(sql) && /RETURNING last_seq/.test(sql)) {
        return {
          bind(updatedAt: string, threadId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(threadId, "thread-1");
            return {
              async first() {
                return { last_seq: 8 };
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
            assert.equal(threadId, "thread-1");
            assert.equal(commandId, "command-1");
            assert.equal(seq, 8);
            assert.equal(kind, "command.failed");
            assert.equal(priority, "P1");
            assert.equal(summary, "Connector disconnected before the command completed.");
            return {
              async run() {
                counters.eventInserts += 1;
                return { success: true };
              }
            };
          }
        };
      }

      if (/UPDATE connectors/.test(sql) && /status = 'offline'/.test(sql)) {
        return {
          bind(updatedAt: string, connectorId: string) {
            assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(connectorId, "connector-online");
            return {
              async run() {
                counters.connectorOfflineUpdates += 1;
                return { success: true };
              }
            };
          }
        };
      }

      throw new Error(`Unexpected SQL in test fake: ${sql}`);
    },
    get commandFailures() {
      return counters.commandFailures;
    },
    get taskUpdates() {
      return counters.taskUpdates;
    },
    get eventInserts() {
      return counters.eventInserts;
    },
    get connectorOfflineUpdates() {
      return counters.connectorOfflineUpdates;
    }
  };

  return db as D1Database & typeof counters;
}
