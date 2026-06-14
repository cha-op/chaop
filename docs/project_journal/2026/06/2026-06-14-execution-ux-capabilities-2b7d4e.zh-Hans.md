---
id: 20260614-2b7d4e-zh-Hans
title: Execution UX 和 Capability 清理
status: completed
created: 2026-06-14
updated: 2026-06-14
branch: wip/execution-ux-capabilities
pr:
supersedes: 20260614-9c3b2d
superseded_by:
---

[ [British English](2026-06-14-execution-ux-capabilities-2b7d4e.md) | 简体中文 ]

# Execution UX 和 Capability 清理

## 摘要
- PR1 将 Browser 里显示用的 execution modes 和现有 protocol command type 分开。
- Thread Command Centre 默认只显示 `Placeholder` 和 `App-server` modes。`CLI fallback` control 只有在 Web build 显式设置 `VITE_CHAOP_SHOW_CODEX_CLI_FALLBACK=true` 时才显示。
- `codex` 仍然是 app-server execution 和 private CLI fallback 共用的 protocol command type，所以本 PR 不改变 Worker dispatch 语义。
- New local thread 的 unavailable states 现在会说明缺少 managed app-server connector，而不是暗示任意 `codex_exec` connector 都能满足这个路径。
- Rust connector fallback events 现在把该路径称为 `Codex CLI fallback`，因此 private fallback output 会和 managed app-server operation 清楚区分。
- 文档现在记录 app-server execution 是预期产品路径，`codex_exec` 是 private fallback/comparison path。

## 实现
- 增加 Web state helpers，用于 command display modes、managed app-server availability、CLI fallback availability，以及 display mode 到 protocol type 的映射。
- 更新 Thread Command Centre：只有当当前 thread attach 到 app-server Host Session，且所属 connector 声明 `codex_app_server_exec` 时，才显示 app-server command control。
- 增加并持久化 `execution_mode` hint，避免隐藏的 CLI fallback command 被 attached app-server Host Session 路由、lease、release 或 fail 劫持；同时显式 app-server request 不会 fallback 到 `codex_exec`。
- 更新 Web 和 Worker sample data，让示例 connector 声明 `codex_app_server_exec`，并把已 attach 示例 Host Session 标为 app-server present。
- 更新 Worker local-thread target errors 和文档，统一使用 managed app-server wording。
- 将 Rust connector/executor 用户可见 fallback summaries 和 tests 从 `Codex exec` 改为 `Codex CLI fallback`。

## 验证
- `project_journal.py validate --repo <repo>`
- `git diff --check`
- `cargo fmt --check`
- `pnpm --filter @chaop/web typecheck`
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`
- Review follow-up regression coverage：attached app-server thread 上的 CLI fallback 会路由到 workspace `codex_exec` connector，pending dispatch 不会给该 command 附上 app-server Host Session target，detach 不会 release 或 fail leased CLI fallback command，非法 execution-mode/type 组合会被拒绝；显式 app-server execution 则要求 attached app-server Host Session。
- `cargo test --workspace`
- `pnpm test`
- `pnpm build`

## 下一切片
- PR2 会增加 connector-managed single app-server lifecycle：启动、检查和重启 dedicated listener，并且只在它足够健康时声明 app-server capabilities。
