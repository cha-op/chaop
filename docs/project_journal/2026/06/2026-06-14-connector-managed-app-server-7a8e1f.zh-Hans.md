---
id: 20260614-7a8e1f-zh-Hans
title: Connector 管理的 App-server 生命周期
status: completed
created: 2026-06-14
updated: 2026-06-14
branch: wip/connector-managed-app-server
pr: https://github.com/cha-op/chaop/pull/11
supersedes: 20260614-9c3b2d
superseded_by:
---

[ [British English](2026-06-14-connector-managed-app-server-7a8e1f.md) | 简体中文 ]

# Connector 管理的 App-server 生命周期

## 摘要
- PR2 让 Rust connector 在配置后管理一个专用的本机 Codex app-server listener。
- Managed mode 会在没有健康 listener 时带上配置的 profile/model、app-server 专用 extra args 和 listener URL 启动 `codex app-server`。
- Connector 会先健康检查 listener，再暴露 app-server capabilities。
- Runtime capabilities 现在会通过 `agent.ready` 刷新，所以不健康的 managed app-server 路径不会继续被选中执行新的 app-server 工作。
- 持久化 AppServerInstance state、写入去重、batching、debounce 和全局 rate limits 保留到后续 AppServerInstance 切片。

## 实现
- 增加 `session_inventory.managed_app_server` 配置，包含 `enabled`、`listen_url`、`startup_timeout_seconds` 和 `restart_backoff_seconds`。
- 增加 app-server manager：检查本机 protocol health，启动配置的 listener，并在启动或子进程健康失败后按 backoff 重试。
- 增加 runtime connector config 路径，让 bootstrap、`agent.ready`、Host Session inventory、thread creation、archive sync 和 app-server command execution 使用同一份 effective app-server URL。
- 增加 `agent.ready` capability payload，以及 Worker 侧 connector capability refresh。
- 增加 review-fix 覆盖：Worker dispatch 需要 ready gate、已认证 reconnect handshake、不再悬空 unavailable app-server commands、graceful process termination 时 managed child shutdown、`CODEX_HOME` 继承，以及 Codex profile/model 和 app-server 专用 extra args 转发。
- Managed app-server restart backoff 从失败启动尝试完成后开始计算，避免长启动超时后马上进入下一轮重试。
- Managed app-server child 现在会运行在独立 process group 中，让 connector shutdown 能终止自己管理的 app-server 进程树，而不是只终止直接子进程。
- Stale cleanup 现在会在存在替代 app-server attachment 时，把 attached app-server command 释放回 pending auto dispatch；只有没有替代执行目标时才失败。
- Scoped stale cleanup 现在会在同一轮 dispatch 里立刻把这些被释放的 attached command 派发给 replacement connector socket，不再等之后某次无关 global dispatch。
- Stale cleanup 也会覆盖已经被释放成 `auto`、但仍带有具体 app-server lease target 的 command；如果 replacement app-server 在 lease 前消失，会失败该 command，而不是让它永久 pending。
- Host Session inventory report 现在会分开追踪 sent 和 acknowledged payload，未 ack 的相同 report 会按间隔重试，并且 command 运行期间也会消费 `agent.host_sessions` ack。
- Managed app-server listener URL 现在限制为 loopback host，避免错误的 `listen_url` 把 app-server protocol 暴露到 LAN interface。
- Connector realtime update 现在会带上 connector `updated_at`，并广播 capability change 和 ready socket 丢失状态，所以旧 bootstrap response 不会重新启用不可用的 app-server controls。
- Agent token authentication 不再把 connector 标记为 dispatch-ready；只有 `agent.ready` 可以恢复 `online` 执行状态。
- Bootstrap connector reconciliation 现在把 bootstrap 视为完整 snapshot，同时保留 realtime `connectors.updated` 的 partial merge 路径，所以 polling 可以移除漏掉 offline realtime event 的 connector。
- Host-session backfill 和 app-server archive sync 现在都要求 connector 处于 `online` 状态，与 command dispatch eligibility 保持一致。
- Command dispatch 现在会记录 socket-local command IDs，并且每个 connector 只向最新的一条 ready socket 派发 pending work；replacement socket 关闭时不会失败已经派发给 surviving peer 的工作。
- Connector bootstrap 现在会先把 connector 注册为 `degraded`，直到 `agent.ready` 才恢复；bootstrap 和 token authentication 不再让 connector 进入 dispatch-ready 状态。
- Managed app-server cleanup 现在会在直接子进程已经退出时继续终止 process-group descendants。
- Dispatch 现在会在 `send()` 前记录 socket-local command ownership；如果 send 失败后 socket 关闭，Worker 仍然能 scoped-fail 已经 lease 的 command，而不是让它等到 lease 过期。
- Web realtime connector update 现在如果引入之前未知的 connector id，会触发一次 bootstrap refresh；这样 local-thread controls 依赖该 connector 前，workspace connector links 已经补齐。
- Dispatch send failure 现在会释放刚 lease 的 command，把失败 socket 标记为不可用于 dispatch，并在存在其它 ready peer 时通过 peer 重试；`/api/commands` 会保持 accepted，不会把 best-effort dispatch send failure 暴露成 500。
- 会释放或结束 lease 的 rejected stale command events 现在会先清理 socket-local command ownership 再重新 dispatch，避免旧 socket 关闭时误 fail 已经移动到 replacement socket 的 command。
- 更新英文和简体中文部署、成本文档。

## 验证
- `cargo test -p chaop-agent`
- `pnpm --filter @chaop/worker test`
- `pnpm test`
- `pnpm build`
- `cargo fmt --check`
- `git diff --check`
- `python3 <project-journal-skill>/scripts/project_journal.py validate --repo .`
- 敏感部署值扫描没有匹配项。

## 下一切片
- PR3 会增加 cost-safe AppServerInstance state model，包括 reporting、batching、debounce 和 rate limits。
