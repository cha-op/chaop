# UX Visual Directions [ British English | 简体中文 ]

## British English

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

## 简体中文

本次为第一轮控制闭环切片生成了三个视觉方向，并在评审后追加了一个任务板视图。它们现在不是互斥选项，而是互相补充的产品视图。

### 1. Operations Map

- 适合场景：如果第一屏最重要的是快速理解整组机器和 connector 的状态，它最适合作为 dashboard。
- 结构：左侧导航、顶部预算条、主区域 host/connector 表格、右侧 thread 和 command 活动。
- 优点：online/offline、agent 数量、running command、throttled thread 和预算状态可以同时被看到。
- 角色：日常默认 operations 视图。

### 1b. Operations Task Board

- 适合场景：跨 agent、workspace 和 thread 管理任务。
- 结构：作为 Operations 下与 `Map` 并列的子视图，使用紧凑的 Kanban/swimlane 组织方式。
- Swimlane：`Running`、`Idle`、`Waiting for approval`、`Waiting for input`、`Throttled` 和 `Done`。
- 用户分类：支持用户自定义标签，例如 `Release`、`Incident`、`Maintenance`、`Research` 和 `Personal`。
- 优点：用户可以按自己的语言分类任务，同时保留系统状态、connector 归属、realtime/summary 状态和成本指标。
- 角色：Operations 内的任务管理视图。

### 2. Thread Command Centre

- 适合场景：用户正在主动操作某一个 Codex thread。
- 结构：thread 列表窄栏、大型 command/event 时间线、右侧 connector lease、预算、approval 和 artifact 检查面板。
- 优点：最适合 command 提交、实时事件查看，以及解释 realtime 和 summary mode 的区别。
- 角色：从 agent、thread 或 task card 打开的聚焦详情视图。

### 3. Budget Reliability Board

- 适合场景：跨多台 host 做成本治理和可靠性监控。
- 结构：顶部预算窗口、中间 connector policy 表格、右侧 delayed upload 和 policy notice、底部 command activity。
- 优点：能把 cost-aware 设计具体化：P0/P1 可靠，P2/P3 延迟或压缩，本地 spool 可见。
- 角色：Usage/Cost 和可靠性监控视图。

## 产品导航决策

所有已生成方向都纳入第一版产品导航：

- `Operations Map` 是日常默认视图。
- `Operations Task Board` 是 Operations 内的任务聚焦视图。
- `Thread Command Centre` 是单个 task/thread/agent 的聚焦详情视图。
- `Budget Reliability Board` 是 Usage/Cost 监控视图。

第一轮实现应先把导航模型明确下来，即使部分视图一开始只有较薄的数据。`Task Board` 从一开始就需要支持用户自定义分类和基于状态的 swimlane。

## 视图聚焦规则

每个视图都应该专注一个主要任务，并把这个任务做好。连接状态、realtime/summary mode、简要预算状态等共享信号可以出现在多个视图里，但除非它们就是当前视图的核心任务，否则应保持为辅助信息。

- `Operations Map`：回答“整组机器是否健康，我下一步该看哪里？”
- `Operations Task Board`：回答“哪些工作正在推进、阻塞、等待或完成？”
- `Thread Command Centre`：回答“这个单一 task/thread 现在具体发生了什么？”
- `Budget Reliability Board`：回答“当前成本和可靠性姿态是什么？”

不要让每个视图都展示所有类型的数据。如果某个细节不是当前视图主要任务所需，应链接到对应的聚焦视图，而不是直接塞进当前页面。
