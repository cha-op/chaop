[ British English | [简体中文](ux-visual-directions.zh-Hans.md) ]

# UX Visual Directions

Three visual directions were generated for the first control-loop slice, and one revised task-board view was added after review. They are now treated as complementary product views rather than mutually exclusive choices.

### 1. Operations Map

- Best for: the first dashboard if the main job is to understand the whole fleet quickly.
- Structure: left navigation, top budget strip, host/connector table as the main surface, thread and command activity on the right.
- Strength: makes online/offline status, agent counts, running commands, throttled threads, and budget state visible at once.
- Role: default everyday operations view.

### 1b. Operations Task Board

- Best for: task-focused operations work across agents, workspaces, and threads.
- Structure: an Operations sub-view beside `Map`, using compact Kanban/swimlane organisation.
- Swimlanes: `Running`, `Idle`, `Waiting for approval`, `Waiting for input`, `Throttled`, and `Done`.
- User categories: user-editable labels such as `Release`, `Incident`, `Maintenance`, `Research`, and `Personal`.
- Strength: lets users classify tasks in their own language while preserving system state, connector ownership, realtime/summary status, and cost indicators.
- Role: the task management view inside Operations.

### 2. Thread Command Centre

- Best for: the operator workflow where a user actively drives one Codex thread.
- Structure: thread list rail, large command/event timeline, right inspector for connector lease, budget, approvals, and artifacts.
- Strength: best fit for command submission, live event review, and realtime versus summary mode explanation.
- Role: focused detail view opened from an agent, thread, or task card.

### 3. Budget Reliability Board

- Best for: cost governance and reliability monitoring across many hosts.
- Structure: budget windows at the top, connector policy table in the centre, delayed uploads and policy notices on the right, command activity at the bottom.
- Strength: makes the cost-aware design concrete: P0/P1 reliable, P2/P3 delayed or compacted, local spool visible.
- Role: Usage/Cost and reliability monitoring view.

## Product Navigation Decision

Use all generated directions as first-class views:

- `Operations Map` is the default everyday view.
- `Operations Task Board` is the task-focused view inside Operations.
- `Thread Command Centre` is the focused detail view for one task/thread/agent.
- `Budget Reliability Board` is the Usage/Cost monitoring view.

The first implementation should make the navigation model explicit even if some views begin with thinner data. `Task Board` needs enough structure from the start to support user-defined categories and state-based swimlanes.

## View Focus Rule

Each view should focus on one primary job and do it well. Shared signals such as connection state, realtime/summary mode, and compact budget status may appear across views, but they should stay secondary unless they are the view's core job.

- `Operations Map`: answer "is the fleet healthy, and where should I look next?"
- `Operations Task Board`: answer "what work is moving, blocked, waiting, or done?"
- `Thread Command Centre`: answer "what is happening inside this one task/thread right now?"
- `Budget Reliability Board`: answer "what is the current cost and reliability posture?"

Avoid making every view display every kind of data. If a detail is not needed for the view's primary job, link to the focused view instead of showing it inline.
