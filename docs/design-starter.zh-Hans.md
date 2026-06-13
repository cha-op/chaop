[ [British English](design-starter.md) | 简体中文 ]

# Codex App-Server 控制面来源笔记

本文是来源设计笔记，不是最终面向用户的指南。面向用户的文档默认路径保存英文 canonical 文件，并使用配套的 `*.zh-Hans.md` 文件保存简体中文正文。中文入口包括 `README.zh-Hans.md`、`docs/deployment-guide.zh-Hans.md`、`docs/ux-visual-directions.zh-Hans.md`、`docs/PROJECT_STATE.zh-Hans.md` 和 `docs/PROJECT_TODO.zh-Hans.md`。

# Codex App-Server Control Plane 设计文档

## 0. 项目目标

本项目要实现一个 Web 版 Codex app-server GUI 控制面，用于统一管理多台机器上的本地 Codex app-server。

核心目标：

1. 通过一个稳定公网入口访问 GUI。
2. 多台机器可以不稳定在线；机器下线不影响 GUI 打开、历史状态查看和任务索引。
3. Browser、Cloudflare 控制面、机器 Agent、本地 Codex app-server 之间支持双向通信。
4. 支持实时事件流、任务状态、approval、日志、artifact、agent 在线状态。
5. 前端尽量轻量，使用 Lit + TypeScript。
6. 前端状态尽量事件驱动，避免复杂全局状态框架。
7. 浏览器端使用 localStorage、IndexedDB、Cache API 等本地存储做轻量缓存和恢复。
8. 后端执行侧尽量使用 Rust。
9. Cloudflare Worker / Durable Objects 使用 TypeScript。
10. 为以后桌面端、移动端预留共享协议和 client 层。

---

## 1. 总体架构

```text
Browser GUI / future desktop / future mobile
  |
  | HTTPS + WSS
  v
Cloudflare Pages + Worker
  |
  +-- D1: 结构化控制面数据库
  +-- R2: 大日志、artifact、patch、snapshot
  +-- Durable Objects: WebSocket 协调、presence、agent policy
  |
  | WSS
  v
Rust Agent on each machine
  |
  | local stdio / unix socket / loopback
  v
Codex app-server
```

组件职责：

```text
Cloudflare Pages
  - 托管静态 Web GUI

Cloudflare Worker
  - HTTP API
  - WebSocket upgrade
  - Auth middleware
  - D1/R2 访问
  - Durable Object 路由

Durable Objects
  - Browser WebSocket session
  - Agent WebSocket session
  - Presence
  - Active viewers
  - Agent reporting policy
  - Event fanout
  - Sequence allocation
  - Command lease coordination

D1
  - agents
  - workspaces
  - threads
  - commands
  - approvals
  - events index
  - artifacts metadata
  - audit log

R2
  - stdout/stderr chunks
  - event JSONL
  - patches
  - diffs
  - artifacts
  - snapshots

Rust Agent
  - 连接 Cloudflare WSS
  - 本地连接 Codex app-server
  - 上报 heartbeat、events、logs、artifacts
  - 接收 command、cancel、approval response、reporting policy
  - 本地 SQLite spool
  - 断线恢复和重放
```

核心原则：

```text
D1 = what happened
R2 = large evidence of what happened
Durable Objects = what is happening now
Agent = execution bridge
Browser = event-driven UI projection
```

---

## 2. 技术栈

### Frontend

```text
Language: TypeScript
UI: Lit
Build: Vite
Routing: lightweight custom router or @vaadin/router optional
State: event-driven local store
Persistence:
  - localStorage for small preferences
  - IndexedDB for event cache and thread cache
  - Cache API optional for static/API response cache
WebSocket: native WebSocket wrapper
Validation: zod or valibot optional
```

不使用：

```text
React
Vue
Redux
MobX
大型前端状态框架
```

### Cloudflare

```text
Cloudflare Pages
Cloudflare Workers
Durable Objects
D1
R2
Wrangler
TypeScript
Hono optional
```

Worker 可以使用 Hono 简化路由，但不强制。

### Agent

```text
Language: Rust
Runtime: tokio
WebSocket: tokio-tungstenite or fastwebsockets
Serialization: serde / serde_json
Local DB: rusqlite or sqlx sqlite
Logging: tracing
CLI: clap
Config: toml or json
Process management: tokio::process
Filesystem watching: notify optional
```

---

## 3. Monorepo 结构

```text
codex-control/
  apps/
    web/
      index.html
      vite.config.ts
      src/
        main.ts
        app-root.ts
        router.ts
        api/
        components/
        pages/
        state/
        storage/
        styles/

    worker/
      wrangler.toml
      src/
        index.ts
        routes/
        durable-objects/
        db/
        r2/
        auth/
        protocol/

  crates/
    agent/
      Cargo.toml
      src/
        main.rs
        config.rs
        cloud_ws.rs
        codex_client.rs
        spool.rs
        policy.rs
        telemetry.rs
        workspace.rs

    codex-client/
      Cargo.toml
      src/
        lib.rs

  packages/
    protocol/
      package.json
      src/
        envelope.ts
        messages.ts
        events.ts
        commands.ts
        policy.ts

    client/
      package.json
      src/
        http-client.ts
        ws-client.ts
        control-client.ts

    state/
      package.json
      src/
        event-store.ts
        reducers.ts
        selectors.ts

  migrations/
    d1/
      0001_initial.sql

  docs/
    architecture.md
```

第一版可以先减少包数量，但建议至少保留：

```text
apps/web
apps/worker
crates/agent
packages/protocol
```

---

## 4. 核心协议

所有 Browser、Worker、Durable Object、Agent 之间的消息都使用 envelope。

```ts
export type MessageEnvelope<T = unknown> = {
  v: 1;
  msg_id: string;
  kind: string;
  workspace_id?: string;
  thread_id?: string;
  command_id?: string;
  seq?: number;
  idempotency_key?: string;
  source: {
    type: "browser" | "agent" | "worker" | "system";
    id: string;
  };
  target?: {
    type: "browser" | "agent" | "workspace" | "thread";
    id?: string;
  };
  created_at: string;
  payload: T;
};
```

要求：

1. `msg_id` 全局唯一。
2. 关键消息必须支持 ack。
3. 任务相关消息必须带 `idempotency_key`。
4. Durable Object 为 workspace/thread 分配递增 `seq`。
5. Browser 断线恢复时通过 `after_seq` 补事件。
6. Agent 断线恢复时通过本地 spool 重放未确认消息。

---

## 5. 消息类型

### Browser -> Control Plane

```ts
type BrowserMessage =
  | BrowserPresenceMessage
  | CreateCommandMessage
  | CancelCommandMessage
  | ApprovalResponseMessage
  | SubscribeThreadMessage
  | UnsubscribeThreadMessage
  | ClientAckMessage;
```

### Agent -> Control Plane

```ts
type AgentMessage =
  | AgentHelloMessage
  | AgentHeartbeatMessage
  | AgentInventoryMessage
  | AgentEventMessage
  | AgentCommandStartedMessage
  | AgentCommandFinishedMessage
  | AgentCommandFailedMessage
  | AgentApprovalRequestedMessage
  | AgentArtifactCreatedMessage
  | AgentAckMessage;
```

### Control Plane -> Agent

```ts
type ControlToAgentMessage =
  | ReportingPolicyMessage
  | ExecuteCommandMessage
  | CancelCommandMessage
  | ApprovalDecisionMessage
  | ResumeRequestMessage
  | ServerAckMessage;
```

### Control Plane -> Browser

```ts
type ControlToBrowserMessage =
  | AgentStatusChangedMessage
  | ThreadEventMessage
  | CommandStateChangedMessage
  | ApprovalRequestedMessage
  | ArtifactAvailableMessage
  | ReportingPolicyDebugMessage
  | ServerAckMessage;
```

---

## 6. 前端架构

前端使用 Lit。

### 页面

```text
/
  Dashboard

/agents
  Agent list

/agents/:agentId
  Agent detail

/workspaces
  Workspace list

/workspaces/:workspaceId
  Workspace detail

/workspaces/:workspaceId/threads/:threadId
  Thread detail

/approvals
  Pending approvals

/settings
  Settings
```

### 组件结构

```text
components/
  app-shell.ts
  nav-sidebar.ts
  agent-status-pill.ts
  connection-indicator.ts
  event-stream.ts
  log-viewer.ts
  approval-card.ts
  command-input.ts
  artifact-list.ts
  thread-list.ts
  workspace-list.ts

pages/
  dashboard-page.ts
  agents-page.ts
  agent-detail-page.ts
  workspace-page.ts
  thread-page.ts
  approvals-page.ts
  settings-page.ts
```

---

## 7. 前端状态模型

前端状态尽量事件驱动，不引入大型状态框架。

状态来源只有三类：

```text
1. Network inbound
   - HTTP hydrate response
   - WebSocket message

2. User action
   - route change
   - prompt submit
   - approve/reject
   - cancel/retry
   - UI preference change

3. Rare timers
   - WebSocket reconnect backoff
   - presence heartbeat
   - idle detection
   - cache cleanup
```

避免：

```text
频繁 polling
复杂全局 mutable store
组件之间直接互相改状态
大量 setInterval
```

### Event Store

前端维护一个轻量 event store。

```ts
export type AppEvent =
  | { type: "hydrate.received"; payload: BootstrapPayload }
  | { type: "ws.connected" }
  | { type: "ws.disconnected"; reason?: string }
  | { type: "agent.updated"; agent: AgentSummary }
  | { type: "thread.event"; thread_id: string; event: ThreadEvent }
  | { type: "command.updated"; command: CommandSummary }
  | { type: "approval.requested"; approval: ApprovalSummary }
  | { type: "approval.resolved"; approval_id: string; state: "approved" | "rejected" }
  | { type: "route.changed"; route: RouteState }
  | { type: "presence.changed"; presence: BrowserPresence }
  | { type: "settings.changed"; settings: UserSettings };
```

Store 接口：

```ts
export class EventStore {
  dispatch(event: AppEvent): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): AppState;
}
```

Lit 组件不直接持有复杂业务状态。组件只做：

```text
subscribe store
render snapshot
dispatch user event
```

---

## 8. Browser 本地存储策略

### localStorage

只存小型、非敏感、用户偏好类数据。

```text
theme
sidebar collapsed
last selected workspace
last selected agent
last opened thread
log viewer preferences
draft prompt per thread
```

示例 key：

```text
codex.ui.theme
codex.ui.sidebar.collapsed
codex.ui.lastWorkspaceId
codex.ui.lastAgentId
codex.draft.thread.{threadId}
```

不要在 localStorage 存：

```text
access token
agent secret
large event logs
large artifacts
sensitive command output
```

### IndexedDB

用于较大但仍属于前端 cache 的数据。

```text
bootstrap cache
agent list cache
workspace list cache
recent thread summaries
recent event summaries
log chunks cache
artifact metadata cache
```

建议 DB：

```text
codex-control-cache
```

Object stores：

```text
kv
agents
workspaces
threads
events
commands
approvals
artifacts
```

IndexedDB 数据必须被视为 cache，不是 source of truth。

### Cache API

可选，用于缓存静态资源或只读 API 响应。

第一版可以不做 Service Worker，避免复杂度。

---

## 9. 前端启动流程

```text
1. Load static app from Pages
2. Read localStorage preferences
3. Read IndexedDB bootstrap cache
4. Render stale cached UI immediately if available
5. Call GET /api/bootstrap
6. Apply hydrate.received event
7. Persist fresh bootstrap to IndexedDB
8. Open WebSocket /ws/browser
9. Send browser_presence
10. Apply inbound WebSocket events
11. On route change, send updated browser_presence
```

页面刷新后应尽快显示缓存状态，然后用服务端 hydrate 覆盖。

---

## 10. Browser Presence 与 Agent 上报策略

Browser 需要告诉控制面用户当前是否在线、是否 idle、正在看什么。

```ts
export type BrowserPresence = {
  session_id: string;
  visible: boolean;
  active: boolean;
  route: string;
  focus?: {
    workspace_id?: string;
    thread_id?: string;
    agent_id?: string;
    mode: "idle" | "watching" | "interactive";
  };
  last_input_at: number;
};
```

触发 presence 更新的事件：

```text
visibilitychange
focus
blur
mousemove
keydown
pointerdown
route change
WebSocket connected
WebSocket reconnected
```

Presence 发送策略：

```text
- route / focus 改变时立即发送
- hidden -> visible 立即发送
- idle -> active 立即发送
- active -> idle 延迟 60-120 秒
- 正常 presence heartbeat 每 10 秒
```

Durable Object 聚合所有 Browser session 的 presence，计算每个 agent/thread 的最高关注级别：

```text
interactive > watching > idle > background
```

下发给 Agent：

```ts
export type ReportingPolicy = {
  policy_version: number;
  default_level: "background" | "idle" | "watching" | "interactive";
  scopes: Array<{
    workspace_id?: string;
    thread_id?: string;
    agent_id?: string;
    level: "background" | "idle" | "watching" | "interactive";
    heartbeat_ms: number;
    telemetry_ms: number;
    event_batch_ms: number;
    log_batch_ms: number;
    diff_debounce_ms: number;
    upload_detail: boolean | "summary";
  }>;
};
```

推荐策略表：

```text
background:
  heartbeat_ms = 60000
  telemetry_ms = 60000
  event_batch_ms = 5000
  log_batch_ms = 10000
  diff_debounce_ms = 30000
  upload_detail = false

idle:
  heartbeat_ms = 30000
  telemetry_ms = 30000
  event_batch_ms = 2000
  log_batch_ms = 5000
  diff_debounce_ms = 10000
  upload_detail = "summary"

watching:
  heartbeat_ms = 10000
  telemetry_ms = 5000
  event_batch_ms = 1000
  log_batch_ms = 1000
  diff_debounce_ms = 3000
  upload_detail = true

interactive:
  heartbeat_ms = 5000
  telemetry_ms = 1000
  event_batch_ms = 200
  log_batch_ms = 250
  diff_debounce_ms = 1000
  upload_detail = true
```

规则：

```text
升频立即
降频延迟 10-30 秒
policy 更新 debounce 1-3 秒
approval 永远立即上传
command state 永远立即上传
agent online/offline 永远立即上传
```

---

## 11. HTTP API

### Bootstrap

```http
GET /api/bootstrap
```

返回：

```ts
type BootstrapPayload = {
  user: UserSummary;
  agents: AgentSummary[];
  workspaces: WorkspaceSummary[];
  recent_threads: ThreadSummary[];
  running_commands: CommandSummary[];
  pending_approvals: ApprovalSummary[];
  server_time: string;
};
```

### Agents

```http
GET /api/agents
GET /api/agents/:agentId
```

### Workspaces

```http
GET /api/workspaces
GET /api/workspaces/:workspaceId
```

### Threads

```http
GET /api/workspaces/:workspaceId/threads
GET /api/threads/:threadId
GET /api/threads/:threadId/events?after_seq=123&limit=500
```

### Commands

```http
POST /api/commands
POST /api/commands/:commandId/cancel
POST /api/commands/:commandId/retry
```

### Approvals

```http
GET /api/approvals?state=pending
POST /api/approvals/:approvalId/approve
POST /api/approvals/:approvalId/reject
```

### Artifacts

```http
GET /api/artifacts/:artifactId
GET /api/artifacts/:artifactId/download
```

---

## 12. WebSocket Endpoints

```text
/ws/browser
/ws/agent
```

Worker 负责：

```text
1. 校验 auth
2. 解析 session / agent identity
3. 选择 Durable Object
4. 把 WebSocket upgrade 转给 DO
```

Browser WebSocket 连接后：

```text
1. server hello
2. client hello
3. browser_presence
4. subscriptions
5. normal event stream
```

Agent WebSocket 连接后：

```text
1. server hello
2. agent hello
3. auth verification
4. resume negotiation
5. heartbeat
6. command/event stream
```

---

## 13. D1 Schema 初版

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  last_seen_at TEXT,
  last_focus_level TEXT,
  capabilities_json TEXT,
  load_json TEXT,
  version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_url TEXT,
  default_branch TEXT,
  policy_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspace_agents (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  local_path TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  can_execute INTEGER NOT NULL DEFAULT 1,
  last_indexed_at TEXT,
  PRIMARY KEY (workspace_id, agent_id)
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  codex_thread_id TEXT,
  title TEXT,
  sticky_agent_id TEXT,
  state TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT,
  type TEXT NOT NULL,
  target_agent_id TEXT,
  target_selector_json TEXT,
  state TEXT NOT NULL,
  lease_owner_agent_id TEXT,
  lease_until TEXT,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT,
  command_id TEXT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  payload_summary_json TEXT,
  payload_r2_key TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(thread_id, seq)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT,
  command_id TEXT,
  state TEXT NOT NULL,
  requested_payload_json TEXT NOT NULL,
  response_payload_json TEXT,
  requested_at TEXT NOT NULL,
  responded_at TEXT,
  responded_by TEXT
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT,
  command_id TEXT,
  kind TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER,
  content_type TEXT,
  sha256 TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip TEXT,
  user_agent TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_threads_workspace ON threads(workspace_id, updated_at);
CREATE INDEX idx_commands_state ON commands(state, updated_at);
CREATE INDEX idx_events_thread_seq ON events(thread_id, seq);
CREATE INDEX idx_approvals_state ON approvals(state, requested_at);
CREATE INDEX idx_artifacts_thread ON artifacts(thread_id, created_at);
```

---

## 14. R2 Key 设计

```text
logs/{workspace_id}/{thread_id}/{command_id}/events-0001.jsonl.gz
logs/{workspace_id}/{thread_id}/{command_id}/stdout-0001.txt
logs/{workspace_id}/{thread_id}/{command_id}/stderr-0001.txt

patches/{workspace_id}/{thread_id}/{command_id}.patch
diffs/{workspace_id}/{thread_id}/{command_id}.diff

artifacts/{workspace_id}/{thread_id}/{artifact_id}/{filename}

snapshots/{workspace_id}/{snapshot_id}.tar.zst
```

规则：

```text
不要每条 event 一个 object
使用 chunk
推荐 chunk size: 256KB - 4MB
D1 只存 r2_key 和 summary
```

---

## 15. Durable Object 设计

第一版使用 `WorkspaceDO`。

职责：

```text
- 管理 workspace 内 browser sockets
- 管理 workspace 内 agent sockets
- 维护 active viewers
- 计算 reporting policy
- 广播 thread events
- 分配 thread seq
- 管理 command lease
- 批量持久化 events
```

后续如果单 workspace 压力变大，可以拆：

```text
ThreadDO(thread_id)
AgentDO(agent_id)
UserPresenceDO(user_id)
```

### WorkspaceDO 内部状态

```ts
type WorkspaceDOState = {
  workspace_id: string;
  browsers: Map<string, BrowserSocketState>;
  agents: Map<string, AgentSocketState>;
  viewers: Map<string, BrowserPresence>;
  threadSeq: Map<string, number>;
  reportingPolicies: Map<string, ReportingPolicy>;
  pendingEventBatches: Map<string, ThreadEvent[]>;
};
```

---

## 16. Agent 设计

Agent 长期运行在每台机器上。

### Agent 职责

```text
1. 读取本地配置
2. 连接 Cloudflare /ws/agent
3. 完成认证
4. 发送 agent hello
5. 发送 heartbeat
6. 接收 reporting policy
7. 接收 execute command
8. 本地调用 Codex app-server
9. 上传 event/log/artifact
10. 本地 SQLite spool
11. 断线重连
12. 重放未 ack 消息
```

### Agent 本地配置

```toml
agent_id = "agent_macmini"
control_url = "wss://codex.example.com/ws/agent"
workspace_root = "/Users/me/projects"
spool_db = "/Users/me/.codex-control/agent.db"

[auth]
token_file = "/Users/me/.codex-control/token"

[codex]
transport = "stdio"
command = "codex"
args = ["app-server", "--listen", "stdio://"]
```

### Agent 本地 SQLite

```sql
CREATE TABLE outgoing_messages (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  workspace_id TEXT,
  thread_id TEXT,
  command_id TEXT,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE local_commands (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT,
  state TEXT NOT NULL,
  local_process_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE upload_chunks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT,
  command_id TEXT,
  local_path TEXT NOT NULL,
  r2_key TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## 17. Command 状态机

```text
pending
  -> leased
  -> running
  -> succeeded

pending
  -> leased
  -> running
  -> failed

pending
  -> leased
  -> lost
  -> pending

running
  -> cancelling
  -> cancelled

running
  -> interrupted
```

Lease 规则：

```text
lease_until = now + 60s
agent renew every 20s
lease expired -> lost
retryable lost -> pending
non-retryable lost -> interrupted
```

---

## 18. Approval 流程

```text
1. Codex app-server requests approval
2. Agent sends approval_requested immediately
3. DO broadcasts to active browsers
4. Worker writes approval to D1
5. Browser user approve/reject
6. Worker writes approval decision
7. DO sends approval_decision to Agent
8. Agent resumes Codex operation
9. audit_log records decision
```

Approval 永远高优先级，不受 reporting policy 降频影响。

---

## 19. 前端事件驱动实现要点

Lit 组件应遵循：

```text
组件不直接发 HTTP
组件不直接写 IndexedDB
组件不直接操作 WebSocket
组件只 dispatch AppEvent 或调用 action
状态只从 EventStore snapshot 派生
```

建议层级：

```text
UI component
  -> action function
  -> client/http or client/ws
  -> inbound event
  -> EventStore reducer
  -> Lit re-render
```

示例：

```ts
async function approveApproval(approvalId: string) {
  store.dispatch({ type: "approval.local_pending", approval_id: approvalId });
  await controlClient.approveApproval(approvalId);
}
```

服务端之后会通过 WebSocket 返回权威状态：

```ts
store.dispatch({
  type: "approval.resolved",
  approval_id: approvalId,
  state: "approved",
});
```

前端可做 optimistic UI，但最终以服务端事件为准。

---

## 20. 前端定时器使用限制

允许的定时器：

```text
WebSocket reconnect backoff
presence heartbeat，每 10s
idle detector，低频
cache cleanup，低频
optional UI clock
```

不允许：

```text
每秒全局 polling API
每个组件独立 setInterval
用定时器同步复杂状态
```

状态更新原则：

```text
network inbound drives state
user action drives state
rare timers only maintain liveness
```

---

## 21. MVP 范围

第一阶段必须实现：

```text
1. Cloudflare Pages 部署 Lit GUI
2. Worker 提供 /api/bootstrap
3. Worker 提供 /ws/browser
4. Worker 提供 /ws/agent
5. D1 schema migration
6. WorkspaceDO 处理 Browser/Agent WebSocket
7. Rust Agent 连接 /ws/agent
8. Agent heartbeat
9. GUI 显示 agent online/offline
10. Browser presence
11. DO 根据 presence 下发 reporting policy
12. GUI 创建 command
13. Agent 接收 command
14. Agent 调用本地 Codex app-server
15. Agent streaming event 回 DO
16. DO 广播到 Browser
17. D1 保存 command/event summary
18. R2 保存大日志 chunk
19. Browser 刷新后 hydrate 历史状态
```

第二阶段：

```text
approval
cancel/retry
artifact browser
local spool resume
lazy detail upload
multi-agent scheduling
workspace-agent mapping
audit log
```

第三阶段：

```text
desktop wrapper with Tauri
mobile wrapper with Capacitor or native client
Git-based failover
workspace snapshot
multi-user RBAC
Cloudflare Access integration
```

---

## 22. 开发顺序

### Step 1: Protocol

实现：

```text
packages/protocol
  envelope.ts
  messages.ts
  policy.ts
```

定义：

```text
MessageEnvelope
BrowserPresence
ReportingPolicy
AgentSummary
WorkspaceSummary
ThreadSummary
CommandSummary
ApprovalSummary
ThreadEvent
```

### Step 2: Worker + D1

实现：

```text
D1 migration
GET /api/bootstrap
mock agents/workspaces/threads
```

### Step 3: Lit GUI

实现：

```text
app-shell
dashboard-page
agents-page
connection-indicator
EventStore
IndexedDB cache wrapper
localStorage preferences
```

### Step 4: Browser WebSocket

实现：

```text
/ws/browser
Browser hello
presence
WebSocket reconnect
event dispatch
```

### Step 5: Agent WebSocket

实现：

```text
Rust agent config
connect WSS
agent hello
heartbeat
receive reporting_policy
```

### Step 6: Durable Object

实现：

```text
browser socket registry
agent socket registry
presence aggregation
policy calculation
broadcast
```

### Step 7: Command Execution

实现：

```text
POST /api/commands
DO lease command
send execute_command to agent
agent invokes Codex app-server
stream events back
persist summaries
```

### Step 8: R2 Logs

实现：

```text
agent chunks logs
upload via Worker or signed endpoint
D1 artifact/log pointer
GUI log viewer lazy loads chunks
```

---

## 23. 安全约束

```text
1. 不直接公网暴露 Codex app-server
2. Codex app-server 只通过 stdio/unix/loopback 给 agent 使用
3. Browser 使用用户认证
4. Agent 使用机器 token
5. Agent token 不存浏览器
6. localStorage 不存敏感 token
7. Approval 决策写 audit_log
8. 所有 command 都记录 created_by
9. 所有 dangerous operation 必须可审计
```

---

## 24. Codex 开发任务清单

请按顺序实现。

### Task 1

创建 monorepo 基础结构：

```text
apps/web
apps/worker
crates/agent
packages/protocol
migrations/d1
```

### Task 2

实现 TypeScript protocol package：

```text
MessageEnvelope
BrowserPresence
ReportingPolicy
AgentSummary
WorkspaceSummary
ThreadSummary
CommandSummary
ThreadEvent
```

### Task 3

实现 Cloudflare Worker skeleton：

```text
GET /api/health
GET /api/bootstrap
GET /ws/browser
GET /ws/agent
WorkspaceDO class
```

### Task 4

实现 D1 migration：

```text
users
agents
workspaces
workspace_agents
threads
commands
events
approvals
artifacts
audit_log
```

### Task 5

实现 Lit frontend skeleton：

```text
app-root
app-shell
dashboard-page
agents-page
thread-page
EventStore
localStorage preferences
IndexedDB cache
```

### Task 6

实现 Browser WebSocket client：

```text
connect
reconnect
send hello
send presence
receive events
dispatch to EventStore
```

### Task 7

实现 Rust Agent skeleton：

```text
config load
WSS connect
agent hello
heartbeat
receive reporting_policy
local SQLite spool skeleton
```

### Task 8

实现 Durable Object presence aggregation：

```text
track browser sessions
track agent sessions
compute reporting policy
send policy to agent
```

### Task 9

实现 command flow：

```text
GUI submit command
Worker creates command in D1
DO leases command
Agent executes placeholder command
Agent streams mock events
GUI renders events
```

### Task 10

接入真实 Codex app-server：

```text
Agent starts or connects to local Codex app-server
Agent translates execute_command to Codex app-server request
Agent streams Codex notifications back to control plane
```

---

## 25. 非目标

第一版不做：

```text
复杂 RBAC
多人协作编辑
完整移动端
完整桌面端
跨机器 workspace failover
复杂日志全文搜索
高级计费统计
Kubernetes 部署
自托管 Postgres
```

第一版目标是：

```text
可靠连接
可靠状态
清晰协议
轻量前端
Rust agent
Cloudflare 控制面
事件驱动 UI
```

---

## 26. 设计结论

本项目采用：

```text
Frontend: Lit + TypeScript
Control Plane: Cloudflare Pages + Worker + Durable Objects
Database: D1
Object Storage: R2
Agent: Rust
State Model: event-driven
Browser Persistence: localStorage + IndexedDB
Realtime: WebSocket
```

设计重点：

```text
不要让不稳定机器承载控制面
不要让前端状态框架变成核心复杂度
不要把大日志写进 D1
不要用 polling 驱动状态
不要直接暴露 Codex app-server
```

最终系统应该表现为：

```text
用户打开 GUI -> 立即从本地 cache 渲染 -> Worker hydrate 最新状态 -> WebSocket 接入实时事件 -> Browser presence 影响 agent 上报频率 -> Agent 根据关注度动态调整同步策略 -> 关键状态始终可靠持久化
```
