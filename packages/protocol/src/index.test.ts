import assert from "node:assert/strict";
import test from "node:test";
import { groupTasksByState, type AgentAppServerInstance, type TaskSummary } from "./index.js";

const connectorAppServerInstance = {
  instance_key: "default",
  scope: "connector",
  endpoint_type: "managed",
  state: "healthy"
} satisfies AgentAppServerInstance;

const workspaceAppServerInstance = {
  instance_key: "workspace-api",
  scope: "workspace",
  workspace_id: "workspace-api",
  endpoint_type: "external",
  state: "degraded"
} satisfies AgentAppServerInstance;

const threadAppServerInstance = {
  instance_key: "thread-api",
  scope: "thread",
  thread_id: "thread-api",
  endpoint_type: "managed",
  state: "draining"
} satisfies AgentAppServerInstance;

// @ts-expect-error workspace placement requires workspace_id.
const invalidWorkspaceAppServerInstance = { instance_key: "workspace-api", scope: "workspace", endpoint_type: "managed", state: "healthy" } satisfies AgentAppServerInstance;

// @ts-expect-error connector placement cannot carry placement target ids.
const invalidConnectorAppServerInstance = { instance_key: "default", scope: "connector", workspace_id: "workspace-api", endpoint_type: "managed", state: "healthy" } satisfies AgentAppServerInstance;

test("AgentAppServerInstance accepts valid placement variants", () => {
  assert.equal(connectorAppServerInstance.scope, "connector");
  assert.equal(workspaceAppServerInstance.workspace_id, "workspace-api");
  assert.equal(threadAppServerInstance.thread_id, "thread-api");
});

test("groupTasksByState preserves empty swimlanes", () => {
  const grouped = groupTasksByState([]);

  assert.deepEqual(Object.keys(grouped), [
    "running",
    "idle",
    "waiting_for_approval",
    "waiting_for_input",
    "throttled",
    "failed",
    "done"
  ]);
});

test("groupTasksByState groups task cards by operational state", () => {
  const tasks: TaskSummary[] = [
    task("task-1", "running"),
    task("task-2", "waiting_for_input"),
    task("task-3", "running")
  ];

  const grouped = groupTasksByState(tasks);

  assert.equal(grouped.running.length, 2);
  assert.equal(grouped.waiting_for_input[0]?.id, "task-2");
  assert.equal(grouped.failed.length, 0);
  assert.equal(grouped.done.length, 0);
});

function task(id: string, state: TaskSummary["state"]): TaskSummary {
  return {
    id,
    workspace_id: "workspace-1",
    thread_id: `thread-${id}`,
    title: id,
    category_id: "incident",
    state,
    realtime_mode: "realtime",
    budget_state: "normal",
    updated_at: "2026-06-09T00:00:00.000Z"
  };
}
