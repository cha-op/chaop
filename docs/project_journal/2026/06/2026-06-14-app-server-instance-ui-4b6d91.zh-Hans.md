---
id: 20260614-4b6d91-zh-Hans
title: AppServerInstance UI
status: completed
created: 2026-06-14
updated: 2026-06-14
branch: wip/app-server-instance-ui
pr:
supersedes: 20260614-6e5f4a
superseded_by:
---

[ [British English](2026-06-14-app-server-instance-ui-4b6d91.md) | 简体中文 ]

# AppServerInstance UI

## 摘要
- PR4 把 cost-safe AppServerInstance model 显示到 Browser 里，但不增加高频 charts 或 log streams。
- Operations Map 的侧栏现在聚焦 app-server instances，不再显示泛化的 thread leads。
- Host Sessions 现在会在 reported sessions 旁显示对应 connector 的 app-server state，并在侧栏保留紧凑的 app-server instance 列表。

## 已完成工作
- 增加 Web display helpers，用于按 connector 过滤 AppServerInstance、按 operator priority 排序、选择 primary instance，以及生成 state labels。
- 增加 instance cards，显示 connector identity、endpoint type、scope、active turn count、generation、changed age、seen age、instance key，以及 summary/error 文案。
- 增加 Host Sessions row chips，让 unattached 和 attached sessions 在扫视时能看到 connector 的 primary app-server health。
- 扩展 fallback sample data，覆盖 healthy、degraded 和 restarting states。
- 视觉 smoke 发现 Operations Map primary panel 变窄后 realtime chip 可能溢出，因此收紧了 Fleet health row layout。

## 验证
- `pnpm --filter @chaop/web test`
- 对本地 Vite fallback data 跑 Playwright CLI screenshot smoke，覆盖 Operations Map 和 Host Sessions。
- `pnpm test`
- `pnpm build`
- `cargo fmt --check`
- `git diff --check`

## 下一步
- PR5 应该让 managed app-server execution 成为默认 command path，同时继续把 `codex_exec` 放在显式 private/developer flag 后面。
- PR5 不应该加入 lifecycle restart/drain controls；这些仍然留给 PR6。
