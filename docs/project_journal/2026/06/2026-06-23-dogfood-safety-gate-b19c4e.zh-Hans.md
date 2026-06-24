---
id: 20260623-b19c4e-zh-Hans
title: 试用安全闸门
status: active
created: 2026-06-23
updated: 2026-06-24
branch: wip/dogfood-safety-gate
pr: 19
supersedes:
superseded_by:
---

[ [British English](2026-06-23-dogfood-safety-gate-b19c4e.md) | 简体中文 ]

# 试用安全闸门

## 摘要
- PR A 从已更新的 `master` 开始，app-server attach/resume PR 已经合并。
- 目标是在加入更完整的 Thread Centre chat flow 之前，先保证 dogfood 使用不会失控地产生成本。
- 这个切片要突出展示当前 safety posture，在 server 侧保护高成本 write 和 refresh actions，并提供即使多个浏览器同时打开也能生效的 emergency pause 或 stop path。

## 实现计划
- 增加 protocol/API safety posture，由当前 Budget Summary 和 emergency pause flag 共同推导。
- 当 posture 不安全时，在 server 侧挡住 command creation、local thread creation、Host Session refresh、app-server attach/backfill 等由浏览器触发的高成本操作。
- 在 Browser 中加入 emergency pause/resume 控制；被禁用的操作需要解释当前触发的限制，而不是静默失败。
- 宽泛 Host Session inventory 继续保持 opt-in，并保留 debounce 设计。
- 开 PR 前补齐测试、双语文档和 deployed E2E smoke 期望。

## 验证计划
- 开发期间运行聚焦的 worker/web 测试。
- 提交前运行完整本地 gate：pnpm 测试、Rust 测试、journal validation、build、formatting 和 diff checks。
- 代码变更后重新部署 API 和 Web，再运行 deployed E2E smoke。
- 合并前跑三路 review，并 resolve 每个 GitHub conversation。

## 进展
- 已实现 protocol safety posture、Worker guard、emergency pause/resume API，以及 Browser safety strip。
- 已在 server 侧保护 command creation、local thread creation、Host Session refresh、app-server attach、task archive/unarchive 和 budget bootstrap。
- 已补充 conservative posture、emergency pause/resume、blocked command creation、blocked Host Session refresh、migration coverage、null telemetry handling，以及 Browser safety helper behaviour 的测试。
- 已修复第一条 review 发现的问题：dogfood safety posture 和 server-side guard decisions 现在会纳入 connector 与 active task 的 budget states。
- Browser API error 现在会保留结构化 safety payload，因此 server-side safety block 可以立即更新本地 UI posture。
- 已修复第二条 review 发现的问题：emergency-pause state 无法读取时现在会 fail closed，而不是继续允许受保护的写入。
- 已新增 `agent_event` guard；当 dogfood safety 暂停或进入 hard limit 时，运行中的 connector WebSocket events 会在 D1 event persistence 前被拒绝。
- 已细化 `agent_event` 行为：pause 或 hard limit 期间会挡住高频非终态 events，但 `command.finished` / `command.failed` 仍可关闭 command 并清理 socket activity。
- 自动 `agent.ready` Host Session refresh dispatch 现在也会走同一个 `host_session_refresh` safety action；当 refresh 被挡住时，同一轮 ready cycle 也不会继续派发 pending command。
- `/api/safety-posture` 继续作为短缓存 live Cloudflare telemetry 的显式刷新路径，并会把该 sample 写入低频 telemetry bucket，供后续写入 guard 复用。
- 已把 safety 文案从宽泛的 “dogfood writes” 收窄为 “guarded dogfood actions”，避免把仍需保留的 cleanup paths 误描述为同一类受阻动作。
- 已把 conservative Host Session refresh block 和 focused pending command dispatch 拆开，避免 conservative posture 卡住已经接受的工作。
- 每次 pending command lease/dispatch 前都会重新检查 `command_create` safety，因此 terminal command cleanup 不会在 dogfood safety pause、hard limit 或 throttled 状态下启动下一条 pending command。
- pause、throttle 或 hard limit 期间，非终态 connector progress events 现在会被丢弃且不写 D1，但仍会 ACK，让 connector 可以继续发送 terminal cleanup event。
- malformed emergency-pause setting rows 现在会 fail closed，与 pause state 无法读取时的行为保持一致。
- 已移除 tracked journal entries 中的本机验证路径。
- 本地 dev mode 无 D1 binding 时，standalone safety-posture endpoint 现在会与 sample bootstrap data 保持一致。
- legacy bootstrap payload 缺少 `safety` 时现在会自动补默认 posture，避免 Web/API 错峰部署导致 Browser shell 空白。
- 受保护写路径的 safety check 现在只读取已持久化 telemetry sample，不再等待 live Cloudflare GraphQL；`/api/safety-posture` 仍作为显式 live refresh 路径。
- Host Session detach 现在也经过 safety gate，因为 detach 可能清除 attachment、失败 command，并触发 released work dispatch。
- stale app-server target cleanup 之后会在 direct `agent.ready` 和 internal dispatch paths 上重新检查 `command_create` safety，再决定是否 dispatch pending commands。
- 无 D1 的 sample mode 只保留 read-only safety：sample refresh 会被 sample safety 阻挡，pause/resume 必须有真实 D1 binding。
- Server 返回 safety block 并带回新 posture 后，Host Session auto-refresh 会立刻停止。
- 已修复同一 Cloudflare telemetry bucket 内的持久化路径：累计 counters 增长时会更新既有 bucket row，让后续 write guards 与最近一次显式 safety 或 budget refresh 对齐。
- 受保护写路径读取 telemetry 时现在会按当前 UTC 日分别取每个 metric 的已持久化最大累计 counter，因此后续更低的 Cloudflare sample 不会放松更早触发的 hard limit。
- production Host Session refresh 现在会在 D1 binding 不可用时 fail closed，同时 sample mode refresh 继续由 sample safety 控制。
- `/api/safety-posture` 返回前现在会把 live safety refresh telemetry 和当前日已持久化最大值合并，保持 Browser controls 与受保护写入决策一致。
- 当 `host_session_refresh` safety 阻挡宽泛清单写入时，进行中的 `agent.host_sessions` report 现在会被丢弃；清掉刷新标记后，保守状态下仍会继续释放已允许的待派发命令。
- 已新增 `app_server_instances_report` safety 覆盖；紧急暂停、限流和硬限制现在也会阻挡连接器状态报告持久化。
- 启动响应里的安全姿态现在会复用预算板同一份预算约束和状态推导，因此实时遥测不会让首屏预算姿态和安全姿态互相矛盾。
- safety block 期间继续把 terminal command event 作为 cleanup path，同时确保 cleanup 不会在 `command_create` 被阻挡时继续派发新工作。
- Budget Summary 计算现在会合并当前 UTC 日已持久化的 Cloudflare telemetry 最大值，因此后续 live sample 较低时，`/api/bootstrap` 和 `/api/usage-summary` 仍会与受保护写入决策保持一致。
- 受保护写入检查现在会复用短缓存的 live Cloudflare telemetry sample；因此即使 telemetry sample 持久化失败，显式 live safety refresh 也能在同一个 Worker isolate 内继续阻挡写入。
- connector WebSocket close 期间的 app-server stopped status 写入现在也会经过 `app_server_instances_report` safety action，避免断连清理绕过状态报告保护。
- live telemetry fallback cache 现在会在同一个 UTC 日和 telemetry selector 内跨 sample bucket 保留，并按每个 metric 的高水位合并，因此后续更低的 live sample 不会丢失 hard-limit protection。
- duplicate connector retirement 期间的 app-server stopped 写入现在也会走同一个 `app_server_instances_report` safety action，同时保留 command/offline cleanup。
- safety pause 或 hard limit 期间现在仍会记录 `command.started` event，让已经派发的 command 离开会过期的 lease state；高频 progress output 仍可被丢弃以减少写入。
- safety resume 后现在会 best-effort 触发一次全局 pending-command dispatch，避免 operator 解除 pause 后，已排队工作还要等其他 connector event 才继续。
- live telemetry 的 daily high-water fallback 现在会保留到 UTC 日结束，因此 telemetry sample 持久化失败后，短 bucket TTL 过期也不会放松同一天已经触发的 hard limit。

## 本地验证
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`
- `pnpm --filter @chaop/worker test -- --test-name-pattern "dogfood safety pause|command started|safety pause and resume"`
- `pnpm --filter @chaop/worker test -- --test-name-pattern "cached live hard limit"`
- `pnpm test`
- `pnpm build`
- `cargo fmt --check`
- `project-journal validate --repo .`
- `git diff --check`

## 下一步
- 重新运行三路 review，并在 merge 前 resolve 所有 GitHub conversations。
