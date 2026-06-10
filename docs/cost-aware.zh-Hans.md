[ [British English](cost-aware.md) | 简体中文 ]

# 成本治理来源笔记

本文是来源成本治理笔记，不是最终面向用户的成本模型。面向用户的成本模型应随实现成熟继续遵循仓库文档约定：默认路径保存英文 canonical 文件，配套 `*.zh-Hans.md` 文件保存简体中文正文。当前由 `docs/deployment-guide.md` 和 `docs/PROJECT_TODO.md` 记录部署值和后续文档工作。

# 成本控制与配额治理补充设计

## 1. 成本控制目标

本系统必须具备 Cloudflare cost-effective 意识。设计目标不是单纯追求最低成本，而是：

1. 避免失控的 WebSocket 消息量。
2. 避免 D1 高频小写入。
3. 避免 R2 小对象爆炸。
4. 避免 Durable Object 持续活跃产生不必要 duration 成本。
5. 能按日和按 4 小时窗口估算用量。
6. 能在接近预算时自动降级。
7. 能对 host / agent / workspace / thread 做硬限流。
8. 能对前端和 agent 明确通知退避原因。
9. 单个 host 只保留一个 Rust connector，由它统一管理该 host 内所有 agent/codex 实例的聚合、限流、重试、spool 和上传。

目标运行规模：

```text
host 数量: 约 4 台
agent 数量: 约 10-20 个逻辑 agent
高强度运行: 十几个 agent 可能同时运行任务
控制面: Cloudflare Pages + Worker + Durable Objects + D1 + R2
host 侧: 每台 host 一个 Rust connector
```

这里的“agent”指逻辑执行单元；“connector”指每台 host 上唯一的 Rust 常驻进程。一个 connector 可以管理多个本地 workspace、Codex app-server session 或逻辑 agent。

---

## 2. 成本相关设计原则

### 2.1 Host 侧必须先聚合

所有本机逻辑 agent 的上报都必须经过同一个 Rust connector。

```text
logical agent A
logical agent B
logical agent C
  |
  v
single Rust connector on host
  |
  | one primary WSS connection
  v
Cloudflare control plane
```

connector 职责：

```text
1. 本机所有逻辑 agent 的消息聚合
2. 本机限流
3. 本机 batching
4. 本机 spool
5. 本机 retry backoff
6. 本机 R2 chunk 聚合
7. 本机 telemetry 降采样
8. 本机 cost budget 执行
9. 本机 reporting policy 执行
```

禁止第一版设计成：

```text
每个逻辑 agent 独立连接 Cloudflare
每个逻辑 agent 独立上报高频 telemetry
每个逻辑 agent 独立写 R2 小对象
```

### 2.2 Cloudflare 侧必须做二次限流

不能只依赖 host 侧自律。Cloudflare 侧必须有硬限制：

```text
per-account budget
per-day budget
per-4h budget
per-host budget
per-connector budget
per-workspace budget
per-thread budget
per-command budget
per-user budget
```

限流位置：

```text
Worker:
  HTTP API rate limit
  command creation limit
  bootstrap / hydrate limit
  artifact download request limit

Durable Object:
  WebSocket inbound message limit
  event fanout limit
  presence update limit
  reporting policy update debounce
  per-thread live stream budget

D1:
  write budget
  event summary insert budget
  audit / approval exempt path

R2:
  object creation budget
  chunk size enforcement
  upload rate limit
```

### 2.3 关键事件不降级，非关键事件可降级

永远优先保留：

```text
agent online/offline
command accepted
command started
command finished
command failed
command cancelled
approval requested
approval decision
lease expired
security-sensitive event
artifact metadata
```

可以降级、聚合或延迟：

```text
stdout/stderr
token-level event
progress tick
telemetry
repo inventory
diff preview
debug trace
large event payload
```

### 2.4 成本状态必须进入系统协议

控制面需要把 budget 状态显式通知 Browser 和 connector。

示例概念：

```text
normal
  - 正常运行

conservative
  - 接近 4 小时窗口预算，开始降频

throttled
  - 已达到某类软限制，非关键事件延迟或聚合

hard_limited
  - 已达到硬限制，拒绝新任务或暂停非关键上传

recovery
  - 进入退避恢复期，逐步恢复频率
```

Browser 应显示：

```text
当前是否降级
哪个维度触发降级
预计何时恢复
哪些数据被延迟
哪些数据仍可靠上传
```

Connector 应执行：

```text
降低事件上传频率
增大 batch window
增大 R2 chunk size
停止非关键 telemetry
启用 lazy detail upload
对新任务排队或拒绝
```

---

## 3. 用量窗口设计

系统必须同时维护三类窗口：

```text
daily window
  - 以 UTC day 或用户配置 day 计
  - 用于对齐 Cloudflare daily/free-tier 或预算控制

4-hour window
  - 滚动窗口或固定窗口
  - 用于防止半天内突然爆量

burst window
  - 1 分钟或 5 分钟窗口
  - 用于防止瞬时消息风暴
```

推荐：

```text
daily:
  00:00-24:00 UTC

4-hour:
  00:00-04:00
  04:00-08:00
  08:00-12:00
  12:00-16:00
  16:00-20:00
  20:00-24:00

burst:
  rolling 1 minute
  rolling 5 minutes
```

Cloudflare 侧维护聚合指标：

```text
worker_requests_estimated
do_requests_estimated
do_ws_messages_in
d1_rows_read_estimated
d1_rows_written_estimated
r2_class_a_estimated
r2_class_b_estimated
r2_bytes_stored_delta
r2_bytes_uploaded
browser_ws_connections
connector_ws_connections
events_received
events_persisted
events_dropped_or_compacted
events_spooled_on_connector
```

注意：这些指标是控制面的内部估算，不要求和 Cloudflare billing 完全一致，但必须足够保守，用于提前降级。

---

## 4. 预算模型

第一版需要支持配置预算，而不是把数值写死。

预算分层：

```text
global budget
  - 整个系统每日 / 每 4 小时预算

host budget
  - 每台 host 的消息、写入、上传预算

workspace budget
  - 每个 workspace 的任务和事件预算

thread budget
  - 单个 thread 的 streaming 预算

command budget
  - 单个 command 的最大事件数、最大日志量、最大运行时长
```

预算类型：

```text
message budget
  - WebSocket inbound messages
  - event envelopes

write budget
  - D1 rows written
  - D1 batch writes

object budget
  - R2 object count
  - R2 Class A-like write operations

storage budget
  - R2 bytes
  - local spool bytes

execution budget
  - concurrent commands
  - command runtime
  - command retry count
```

建议默认策略：

```text
global:
  - 每日预算保守使用
  - 每 4 小时最多消耗日预算的 25-35%
  - burst 窗口防止瞬时消息风暴

host:
  - 每台 host 获得基础配额
  - 活跃用户正在查看的 host 可临时提升
  - 不被查看的 host 自动降级到 summary 模式

thread:
  - interactive thread 允许高频
  - watching thread 中频
  - background thread 只传 summary 和关键事件

command:
  - 每个 command 必须有日志量上限
  - 超过上限后切换为 chunked/lazy detail
```

---

## 5. Connector 侧限流与聚合

每台 host 只运行一个 Rust connector。connector 必须在本地做第一层成本控制。

### 5.1 本地连接模型

connector 可以管理多个逻辑执行单元：

```text
host connector
  - logical agent registry
  - workspace registry
  - codex session registry
  - local spool
  - rate limiter
  - batcher
  - uploader
```

Cloudflare 只看到：

```text
host connector online
logical agents attached
logical agents status summary
workspace availability summary
```

而不是让每个逻辑 agent 都产生一条独立公网连接。

### 5.2 Connector 上报模式

connector 支持四种模式：

```text
background
  - 只上传 heartbeat、关键状态、summary
  - 日志和细节尽量本地 spool
  - R2 大 chunk 低频上传

idle
  - 上传 summary 和较低频事件
  - 部分日志 chunk 上传
  - telemetry 降采样

watching
  - 用户正在看相关 agent/thread
  - 中高频事件上传
  - 日志较实时
  - diff preview 有 debounce

interactive
  - 用户正在交互
  - 高频 streaming
  - command state / approval 即时
  - 仍然需要 batch，禁止 token 级无控制刷屏
```

### 5.3 本地 batch

connector 必须支持：

```text
event batching
log batching
telemetry batching
diff debounce
R2 chunk aggregation
```

推荐行为：

```text
interactive:
  event batch: 100-250ms
  log batch: 250ms or size threshold
  diff debounce: 500-1000ms

watching:
  event batch: 500-1000ms
  log batch: 1s
  diff debounce: 2-3s

idle:
  event batch: 2-5s
  log batch: 5s
  diff debounce: 10s

background:
  event batch: 5-10s
  log batch: 10-30s
  diff debounce: 30s or disabled
```

这些数字是默认值，必须可由 Cloudflare reporting policy 覆盖。

### 5.4 本地 spool

connector 必须有本地持久 spool。

spool 用途：

```text
Cloudflare 不可用时保存未发送消息
Cloudflare 限流时保存可延迟消息
网络断开时保存事件
后台模式下保存 lazy detail
R2 上传失败时保存待上传 chunk
```

spool 必须支持：

```text
按优先级队列
按 command/thread 分区
ack 后清理
最大磁盘限制
过期清理
重要事件优先上传
低优先级日志可压缩
低优先级 detail 可丢弃，但必须记录被丢弃摘要
```

spool 优先级：

```text
P0:
  approval
  command terminal state
  security event
  lease / cancel

P1:
  command lifecycle
  artifact metadata
  error event

P2:
  user-visible event summary
  important log checkpoint

P3:
  stdout/stderr detail
  telemetry
  progress
  debug trace
```

### 5.5 Connector 本地硬限制

connector 必须可配置：

```text
max concurrent commands
max events per second
max bytes per second uploaded
max R2 upload bytes per hour
max local spool bytes
max command log bytes
max command runtime
max retry attempts
```

达到限制时：

```text
P0 不丢
P1 尽量不丢
P2 聚合
P3 降采样、压缩、延迟或丢弃
```

所有丢弃或压缩必须产生 summary event：

```text
某时间段内压缩了多少条事件
丢弃了多少低优先级 telemetry
本地保留了多少 detail
是否需要用户主动请求 lazy upload
```

---

## 6. Cloudflare 侧硬限流

Cloudflare 侧必须防止 connector bug、无限循环、消息风暴或 denial-of-wallet。

### 6.1 Worker 层限流

Worker 需要限制：

```text
bootstrap / hydrate 频率
thread events history load 频率
command creation 频率
artifact download 频率
agent registration 频率
browser WebSocket connection 频率
agent WebSocket connection 频率
```

当超限：

```text
HTTP 返回 rate-limited 响应
WebSocket 发送 throttle notice
要求客户端指数退避
必要时拒绝新 command
```

### 6.2 Durable Object 层限流

DO 需要限制：

```text
每 connector 每分钟 inbound message 数
每 workspace 每分钟 inbound event 数
每 thread 每分钟 live broadcast 数
每 browser session 每分钟 presence 数
每 agent 每分钟 policy update 数
每 command 每分钟 event 数
```

DO 对消息分类处理：

```text
P0:
  永远优先处理，除非系统进入 emergency shutdown

P1:
  高优先级，允许少量延迟

P2:
  可 batch

P3:
  可要求 connector 降频或暂停
```

DO 超限处理：

```text
1. 发送 throttle notice 给 connector
2. 提高该 connector 的 batch window
3. 降低该 connector 的 detail level
4. 要求 connector 本地 spool
5. 暂停非关键 event
6. 如果持续违规，断开 connector 并要求退避重连
```

### 6.3 D1 写入限流

D1 写入必须受控。

原则：

```text
不要每条 token/event 都写 D1
不要把 stdout/stderr 原文写 D1
不要写巨大 JSON payload
不要让每个 connector 独立高频 INSERT
```

D1 只写：

```text
command state
approval state
agent state summary
thread event summary
artifact metadata
R2 pointer
audit event
budget summary
throttle summary
```

D1 写入策略：

```text
P0/P1 立即写
P2 batch 写
P3 不写或写 compact summary
```

必须支持：

```text
write budget per day
write budget per 4h
write budget per workspace
write budget per command
```

如果 D1 写入预算接近上限：

```text
停止写低优先级 event summary
提高 event compaction
把详细内容转为 R2 chunk 或 connector local spool
只保留 command lifecycle 和 approval
通知 Browser 当前处于 cost-saving mode
```

### 6.4 R2 写入限流

R2 主要风险是小对象数量和高频写。

R2 策略：

```text
使用 chunk，不使用 per-event object
推荐 chunk size 下限
推荐 chunk flush interval 上限
同一 command 的日志尽量合并
低优先级 detail 可 lazy upload
```

R2 写入限制：

```text
per connector objects per hour
per command objects per hour
per workspace objects per day
minimum object size target
maximum small-object ratio
```

如果 R2 object budget 接近上限：

```text
增大 chunk size
延迟 background log upload
只上传 final compressed log
暂停 telemetry detail upload
保留本地 spool
```

---

## 7. Retry、退避和通知

### 7.1 Connector 退避

connector 遇到 Cloudflare 限流或错误时必须指数退避。

退避维度：

```text
WebSocket reconnect
message resend
R2 chunk upload
inventory sync
telemetry upload
lazy detail upload
```

退避规则：

```text
普通网络错误:
  指数退避，带 jitter

rate limit:
  遵守 server 提供的 retry_after
  没有 retry_after 时使用保守退避

hard limit:
  停止非关键上传
  保留本地 spool
  周期性发送低频 heartbeat

auth error:
  不无限重试
  进入 disabled 状态
```

### 7.2 Control Plane 通知

Cloudflare 侧要向 Browser 和 connector 发出明确通知。

通知类型：

```text
budget_warning
budget_throttled
hard_limited
retry_after
policy_downgrade
policy_restore
spool_required
lazy_upload_required
```

Browser 需要显示：

```text
当前系统是否降级
哪些 host 被限流
哪些 thread 不是实时完整数据
是否有本地 spool 未上传
是否需要等待 host 恢复上传
```

Connector 需要执行：

```text
按 retry_after 暂停对应维度
调整 reporting policy
提高 batch size
降低 detail level
把可延迟数据写入本地 spool
```

---

## 8. Attention-aware 与 Cost-aware 的组合

原有 attention-aware 策略继续保留，但必须叠加 cost-aware 策略。

最终 effective policy 由以下因素共同决定：

```text
browser attention level
  background / idle / watching / interactive

system budget state
  normal / conservative / throttled / hard_limited / recovery

host budget state
  normal / throttled / hard_limited

command priority
  normal / high / critical

event priority
  P0 / P1 / P2 / P3
```

规则：

```text
用户关注可以升频
预算压力可以降频
P0 事件不受普通降频影响
hard limit 可以拒绝新任务
interactive 不代表无限制上传
```

示例：

```text
用户正在 interactive 查看 thread
但 4 小时 R2 object budget 已接近上限

结果:
  command state 仍立即上传
  approval 仍立即上传
  stdout/stderr 仍实时显示，但 connector 聚合后发送
  R2 chunk size 增大
  低优先级 telemetry 暂停
  diff preview debounce 增大
```

---

## 9. 成本估算与用量面板

系统必须提供一个 Usage / Cost 面板。第一版可以是估算，不需要和 Cloudflare 账单精确一致。

面板按以下维度显示：

```text
当前 4 小时窗口
当天累计
过去 7 天
过去 30 天
```

显示内容：

```text
Worker request estimate
Durable Object message estimate
D1 rows read estimate
D1 rows written estimate
R2 object writes estimate
R2 object reads estimate
R2 bytes stored estimate
R2 bytes uploaded estimate
active connectors
logical agents
running commands
events received
events persisted
events compacted
events delayed
events dropped
local spool pending estimate
```

按资源拆分：

```text
by host
by connector
by workspace
by thread
by command
by event priority
```

需要有预算状态：

```text
daily budget used %
4h budget used %
burst budget used %
projected daily usage
projected monthly usage
```

### 9.1 4 小时规划

每 4 小时窗口应维护预算消耗。

示例：

```text
daily_budget = 100 units
4h_budget_soft = 20 units
4h_budget_hard = 35 units
```

行为：

```text
< 60% soft:
  normal

60-90% soft:
  conservative

90-100% soft:
  throttled

> hard:
  hard_limited
```

使用固定 4 小时窗口的好处：

```text
实现简单
容易在 UI 里解释
能防止早上几个小时打爆全天预算
```

### 9.2 日预算

日预算用于全局保护。

```text
< 70%:
  normal

70-85%:
  conservative

85-95%:
  throttled

> 95%:
  hard_limited for non-critical operations
```

日预算接近上限时：

```text
拒绝新 background commands
限制并发 commands
暂停 lazy detail upload
只保留关键事件
要求 connector 本地 spool
Browser 显示明确警告
```

---

## 10. 高强度场景下的默认规划

目标场景：

```text
4 hosts
10-20 logical agents
十几个 agent 可同时高强度运行
```

建议默认限制：

```text
每 host 一个 connector
每 connector 一个主 WebSocket
每 connector 内部聚合所有 logical agent
每 connector 限制同时高频 interactive streams
每 workspace 限制同时 running commands
每 command 限制最大日志速率
每 thread 限制 live event broadcast 速率
```

高强度运行时的优先级：

```text
1. command lifecycle
2. approval
3. current user focused thread
4. running thread summary
5. artifact metadata
6. logs
7. telemetry
8. debug trace
```

如果十几个 agent 同时运行：

```text
用户正在看的 1-3 个 thread:
  保持较实时

其他 running thread:
  summary mode

background thread:
  本地 spool + 低频 checkpoint

telemetry:
  host-level 聚合，不做 per-agent 高频上报
```

host-level telemetry 应聚合：

```text
host load
host memory
host disk
total running commands
per logical agent summary
```

不要每个逻辑 agent 单独高频上报完整 telemetry。

---

## 11. Cloudflare Hibernation 要求

Durable Objects 必须使用 WebSocket Hibernation 能力，避免空闲 WebSocket 长时间让 Object 保持活跃。

要求：

```text
空闲连接不应产生持续 active duration
presence 心跳频率要保守
policy 更新要 debounce
没有 live 事件时不要用 timer 保持 DO 活跃
DO 不运行后台 loop
```

避免：

```text
DO 内部 setInterval 做持续轮询
每秒向所有 browser 广播状态
普通 accept 导致 WebSocket 持续 duration 成本
无意义 heartbeat fanout
```

---

## 12. 页面和用户体验要求

GUI 必须让用户知道当前数据是否实时、完整、降级或延迟。

每个 thread / agent 页面显示：

```text
realtime
summary mode
cost-saving mode
throttled
waiting for connector upload
local detail unavailable until host online
```

日志 viewer 显示：

```text
live stream
partial stream
summary only
detail available on demand
detail delayed due to budget
```

当用户点击“加载完整日志”：

```text
如果 budget 允许:
  请求 connector lazy upload

如果 budget 紧张:
  提示会延迟上传或只加载压缩摘要

如果 host 离线:
  提示 detail 暂不可用，已保留索引和摘要
```

---

## 13. 设计中的非目标

第一版不要求：

```text
精确复刻 Cloudflare 账单
实时读取 Cloudflare billing API
复杂财务报表
自动购买/升级计划
无限制高频日志
多 connector per host
每个 agent 独立公网连接
```

第一版必须做到：

```text
估算用量
按日和按 4 小时窗口治理
connector 本地聚合
Cloudflare 侧硬限流
可解释的降级
可恢复的 retry/backoff
关键事件可靠上传
非关键事件可延迟、聚合或 lazy upload
```

---

## 14. 对原设计文档的修改要求

原设计中的具体 API 名称、文件名、表名、组件名可以作为示例，不作为强制规范。本文档只规定功能边界和系统行为。

实现时应避免过早固定：

```text
具体 API path
具体文件命名
具体类名
具体前端组件名
具体数据库字段细节
```

必须固定的是：

```text
每 host 单 Rust connector
connector 聚合多个 logical agent
Cloudflare 侧有硬限流
系统有 daily / 4-hour / burst 用量窗口
关键事件优先级不可降级
非关键事件可 batch / debounce / lazy upload
D1 不存大 payload
R2 不写 per-event 小对象
Durable Objects 使用 hibernation 友好设计
Browser 显示成本降级状态
```

---

## 15. 更新后的 MVP 要求

MVP 在原有功能基础上增加：

```text
1. 每 host 只运行一个 connector
2. connector 管理多个 logical agent
3. connector 实现本地 event/log/telemetry 聚合
4. connector 实现本地 spool
5. connector 执行 reporting policy
6. connector 执行 cost policy
7. Cloudflare DO 实现 per connector inbound 限流
8. Cloudflare Worker/DO 维护 daily / 4-hour / burst 估算计数
9. Cloudflare 能下发 throttle notice 和 retry_after
10. Browser 显示 cost-saving / throttled / summary mode
11. 非关键 event 可以延迟或 compact
12. 关键 event 始终优先上传和持久化
```

MVP 不需要精确计费，但必须有保守估算和硬保护。

---

## 16. 最终设计结论

系统应采用：

```text
Cloudflare:
  稳定控制面 + 估算用量 + 硬限流 + 降级通知

Rust connector:
  每 host 唯一公网连接者 + 聚合器 + 限流器 + spool + retry/backoff

Logical agents:
  不直接连接 Cloudflare
  不直接高频上报
  由 connector 统一管理

Browser:
  事件驱动 UI
  显示实时性和成本降级状态
  用户关注度影响上报频率，但不绕过预算限制
```

最终目标：

```text
十几个 agent 高强度运行时，系统仍能保持关键状态可靠、GUI 可用、成本可预测，并在预算紧张时自动降级，而不是把 Cloudflare 用量打爆。
```
