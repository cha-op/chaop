---
id: 20260623-5b7a2c-zh-Hans
title: Host Session Inventory Cost Control
status: completed
created: 2026-06-23
updated: 2026-06-23
branch: wip/app-server-attach-resume
pr: 18
supersedes:
superseded_by:
---

[ [British English](2026-06-23-host-session-inventory-cost-control-5b7a2c.md) | 简体中文 ]

# Host Session Inventory Cost Control

## 摘要
- Host Session inventory 现在默认按需触发。Connector 空闲时保持静默，不再周期性重扫本机 Codex sessions。
- Browser 的 Host Sessions 页面保留手动 refresh 按钮，并增加显式启用的一分钟自动刷新开关，供正在关注本机 sessions 的用户使用。
- Workspace Durable Object 会按 connector 去重 refresh 请求，并使用一分钟冷却时间，所以额外的浏览器设备或标签页不会让 connector inventory refresh 成倍增加。
- Thread event realtime 仍然是高频路径；inventory 覆盖范围更宽、成本更高、紧急度更低，因此会刻意保持低频。

## 实现说明
- `POST /api/host-sessions/refresh` 现在会返回 dispatched、debounced 和 cooldown counts，Browser 可以说明一次 refresh 为什么 fan out 或为什么被冷却。
- `WorkspaceDO` 请求 inventory 时会为每个 connector 选择最新的 ready socket，然后把这个 socket 标记为 Host Session refresh pending，让 command dispatch 继续等待这次本机快照。
- 可靠的 full Host Session inventory report 现在会带着 `snapshot: true` 广播给 browser，因此 live browser state 可以剪掉该 connector 已经 omitted 的 stale sessions。
- Full Host Session snapshot payload 会同时包含 unchanged reported sessions 和 changed rows，因此 Browser 不会剪掉本轮 report 中存在、但没有触发 D1 update 的 sessions。
- app-server inventory failed、缺少 app-server evidence 或被截断的 full Host Session report 现在会作为 non-snapshot update 广播，因此 Browser 会保留 D1 已保留的 app-server sessions，直到可靠 full report 到达。
- Review follow-up：Host Session refresh pending guard 现在有有界等待时间，所以 inventory report 卡住或缺失时不会永远阻塞 command dispatch。
- Review follow-up：如果 connector socket 在持有 pending Host Session refresh 时断开，Durable Object 会清理这个 connector 的 refresh cooldown，因此 reconnect 后可以立刻重新请求 inventory。
- Review follow-up：Host Session sync metadata 现在会把已存储的 reported sessions 和实际发生变更的 rows 分开计数，unchanged inventory report 不会再发布 `stored_session_count = 0`。
- Rust connector 不再在普通 `agent.ready` 更新或 idle read tick 后发送 Host Session inventory。显式 `host_sessions.refresh` 请求和用户动作路径仍然会发送一次 report。
- Browser 不再在 refresh 请求后连续做三次 bootstrap reload。WebSocket live 时等待 realtime Host Sessions update；WebSocket 不在线时只做一次延迟 bootstrap 读取作为 fallback。

## 验证
- `pnpm --filter @chaop/protocol test`
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`
- reconnect cooldown 修复后再次运行 `pnpm --filter @chaop/worker test`。
- full-inventory browser snapshot 修复后再次运行 `pnpm --filter @chaop/worker test`。
- unchanged-row snapshot payload 修复后再次运行 `pnpm --filter @chaop/worker test`。
- reliable-snapshot downgrade 修复后运行 `pnpm --filter @chaop/worker test` 和 `pnpm --filter @chaop/web test`。
- `cargo test --workspace`
- `pnpm test`
- `pnpm build`
- Project journal validator。
- `git diff --check`
- complete host-session snapshot 修复后的 API/Web deployed smoke 已通过：direct health/bootstrap/assets 通过，browser shell bootstrap 返回 `200`，Budget Board telemetry 显示 `normal` 且 source 为 Cloudflare Analytics。
- Internal `codex-readonly` review 发现 connector-level pending inventory 需要拦住同一 connector 的所有 peer sockets；后续修复已经加入该 guard 和回归测试。
- 修复后的第二轮 internal `codex-readonly` review 返回 `LGTM`。

## 下一步
- 部署后短暂打开 connector，观察 D1 rows-written residual。
- 如果 Cloudflare counters 仍然显示无法解释的写入增长，再继续做精确 D1 query-meta attribution。
