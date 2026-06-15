---
id: 20260614-a5d8c0-zh-Hans
title: Default App-server Command Path
status: completed
created: 2026-06-14
updated: 2026-06-14
branch: wip/default-app-server-command-path
pr:
supersedes: 20260614-4b6d91
superseded_by:
---

[ [British English](2026-06-14-default-app-server-command-path-a5d8c0.md) | 简体中文 ]

# Default App-server Command Path

## 摘要
- PR5 让 managed app-server execution 成为已 attach app-server threads 的默认 command path。
- Thread Command Centre 仍然保留显式 execution modes，但隐式 mode selection 现在会在所选 thread 可用时优先选择 app-server。
- Worker 不再接受会意外落到 connector `codex_exec` 的裸 `codex` command；CLI fallback 必须显式传 `execution_mode = "codex_cli_fallback"`。

## 已完成工作
- 增加 Web command-mode helpers，用于选择默认 mode，以及在隐式选择时提升到 app-server。
- 增加 UI state：切换 thread 会重置隐式 command selection；operator 显式选择的 mode 会保留，直到该 mode 失效。
- 修改 D1 command creation：当 `codex` command 目标是已 attach 的 app-server Host Session 时，自动推断 `execution_mode = "app_server"`。
- 当没有 attached app-server target 且没有显式 CLI fallback execution mode 时，拒绝创建裸 `codex` command。
- 为显式 CLI fallback path 增加正向和反向 route tests。

## 验证
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`

## 下一步
- PR6 应该增加 managed app-server instances 的 drain、scheduled restart 和 upgrade flow。
- PR6 仍需保持 AppServerInstance state reporting 的成本安全：批量处理 lifecycle state updates，并避免高频 browser polling。
