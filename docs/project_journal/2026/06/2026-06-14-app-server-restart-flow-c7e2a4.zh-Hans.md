---
id: 20260614-c7e2a4-zh-Hans
title: App-server Restart Flow
status: completed
created: 2026-06-14
updated: 2026-06-15
branch: wip/app-server-restart-flow
pr: https://github.com/cha-op/chaop/pull/15
supersedes: 20260614-a5d8c0
superseded_by:
---

[ [British English](2026-06-14-app-server-restart-flow-c7e2a4.md) | 简体中文 ]

# App-server Restart Flow

## 摘要
- PR6 增加 connector 侧 managed app-server restart 的 draining primitive。
- Periodic restart 和本机 upgrade-marker restart 请求现在会在 active turns drain 期间撤回 app-server capabilities。
- Active turns 结束后，connector 会重启 managed listener；如果某个 turn 被遗弃并超过配置的 drain timeout，则会强制重启。

## 已完成工作
- 增加 managed app-server 配置项：`drain_timeout_seconds`、`scheduled_restart_interval_seconds` 和 `upgrade_marker_file`。
- 为 AppServerManager 增加 pending restarts、scheduled restart deadlines，以及 upgrade marker modification tracking。
- 增加 `draining` lifecycle transitions：runtime config 在 drain 期间不返回 app-server URL，因此 `agent.ready` 不再声明 app-server thread/archive/execution capabilities。
- 在 app-server command 运行期间增加有界的 app-server runtime maintenance tick，因此 scheduled 或 marker-triggered restart 可以在长 turn 期间进入 drain、上报 capability 变化，但不会做普通 health-check restart。
- App-server command completion 现在会在 final event dispatch 之前推进 runtime state，但恢复 readiness 和刷新 host sessions 会延后到 final command events 被确认之后。
- `agent.ready` ack tracking 现在会在 capability payload 变化后清除 stale acknowledgements，因此未确认的 draining update 之后，恢复的 app-server capabilities 会被重新发送。
- 如果 connector 启动时 marker 文件尚不存在，那么配置的 upgrade marker 文件首次创建也会作为 restart request 处理。
- Upgrade marker restart requests 现在会覆盖 pending scheduled restart requests，因此 operator 触发的本机 marker 不会被 periodic restart 掩盖。
- 强制 drain-timeout restart 完成后继续保留 operator 可见的 summary；如果强制重启后没有恢复 healthy，也会保留底层 restart error。
- 如果 scheduled restart 在 active-turn drain 期间发现 managed child 已经退出，会先遵守 startup backoff，而不是在 drain timeout 后立刻强制重启。
- 当 managed app-server 已经 degraded、没有可停止的 child process，或 managed child 已经退出时，scheduled restart 现在会尊重 startup backoff，并且不会在 backoff window 内反复 bump instance generation 或 control-plane reports。
- Restart request 不再通过复用 connector 不拥有的 healthy listener 来误报成功，包括 managed child 已经被 stop 之后的情况；pending restart 会保持 blocked，直到 unowned listener 被停止。
- Restart attempt 只有在可以真实推进时才会清空 pending drain request，然后重置 periodic schedule、停止 managed child，并复用现有 health-check/start path。
- 更新部署指南里的配置示例和 operator guidance，说明 scheduled restart 与 upgrade marker 的使用方式。

## 验证
- `cargo fmt --check`
- `cargo test -p chaop-agent`
- `pnpm test`
- `pnpm build`
- `git diff --check`
- Project journal validator
- Sensitive deployment value scan

## 下一步
- PR7 增加 multi-instance 和 placement foundation 时，应复用这些 lifecycle primitives。
- 后续切片如果增加远程 UI/API 的 restart scheduling control，可以建立在同一套 manager 语义上，而不改变 drain 行为。
