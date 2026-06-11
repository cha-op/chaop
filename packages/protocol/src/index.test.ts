import assert from "node:assert/strict";
import test from "node:test";
import { groupTasksByState, type TaskSummary } from "./index.js";

test("groupTasksByState preserves empty swimlanes", () => {
  const grouped = groupTasksByState([]);

  assert.deepEqual(Object.keys(grouped), [
    "running",
    "idle",
    "waiting_for_approval",
    "waiting_for_input",
    "throttled",
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
