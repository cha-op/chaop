---
id: 20260614-a5d8c0
title: Default App-server Command Path
status: completed
created: 2026-06-14
updated: 2026-06-14
branch: wip/default-app-server-command-path
pr:
supersedes: 20260614-4b6d91
superseded_by:
---

[ British English | [简体中文](2026-06-14-default-app-server-command-path-a5d8c0.zh-Hans.md) ]

# Default App-server Command Path

## Summary
- PR5 makes managed app-server execution the default command path for attached app-server threads.
- Thread Command Centre keeps explicit execution modes, but implicit mode selection now prefers app-server when the selected thread can use it.
- The Worker no longer accepts a bare `codex` command that would fall through to connector `codex_exec`; CLI fallback must be requested explicitly with `execution_mode = "codex_cli_fallback"`.

## Completed Work
- Added Web command-mode helpers for default mode selection and implicit app-server promotion.
- Added UI state so changing threads resets implicit command selection, while an operator's explicit mode choice is preserved until it becomes invalid.
- Changed D1 command creation to infer `execution_mode = "app_server"` when a `codex` command targets an attached app-server Host Session.
- Rejected bare `codex` command creation when there is no attached app-server target and no explicit CLI fallback execution mode.
- Added positive and negative route tests for the explicit CLI fallback path.

## Validation
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`

## Next Steps
- PR6 should add drain, scheduled restart, and upgrade flow for managed app-server instances.
- PR6 should keep AppServerInstance state reporting cost-safe by batching lifecycle state updates and avoiding high-frequency browser polling.
