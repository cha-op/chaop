---
id: 20260613-e4a7c9
title: App-server Execution Slice
status: completed
created: 2026-06-13
updated: 2026-06-13
branch:
pr:
supersedes:
  - 20260610-b7f2c1
superseded_by:
---

[ British English | [简体中文](2026-06-13-app-server-execution-e4a7c9.zh-Hans.md) ]

# App-server Execution Slice

## Summary
- This slice adds a real Codex app-server execution path for Chaop commands.
- The path is opt-in through private connector config: `execution.mode = "app_server"` and `session_inventory.app_server_url`.
- The CLI adapter remains available as `execution.mode = "codex_exec"` for fallback and comparison.

## Decisions
- Run app-server commands only for Chaop threads or tasks already attached to a local app-server Host Session.
- Keep command dispatch compatible with the existing `codex` command type; the Worker now includes the attached local session target in `command.dispatch`.
- Resolve the stored app-server `sessionId` to the current app-server `Thread.id` before execution, then call `thread/resume` and `turn/start`.
- Return concise Chaop lifecycle events from the final app-server turn rather than uploading full local transcript or artefact data.

## Implementation Notes
- Protocol adds `CommandTargetHostSession` and optional `CommandDispatch.target_host_session`.
- Worker command leasing joins attached `host_sessions` so the Durable Object can dispatch the local session target to the connector.
- Command creation now prefers the connector that owns the attached Host Session for the selected thread/task, instead of choosing an arbitrary recent workspace connector.
- Attached app-server commands require the owning connector to advertise `codex_app_server_exec`; Worker creation/leasing and the Rust connector both refuse to fall back to plain `codex_exec`.
- Connector config adds `execution.mode = "app_server"` and advertises `codex_app_server_exec` without also advertising the CLI-only `codex_exec` capability.
- The Rust connector keeps its control WebSocket responsive while the app-server command runs in a background worker.
- The app-server execution path handles synchronous terminal `turn/start` responses and asynchronous `turn/completed` notifications.
- App-server `thread/resume` and `turn/start` use the attached session cwd when it is absolute, falling back to connector `workspace_root` only when the attached cwd is missing or invalid.

## Validation Targets
- Worker tests for command dispatch target host-session mapping.
- Rust tests for app-server session resolution, `thread/resume`, `turn/start`, terminal turn handling, and completion notifications.
- Full `pnpm test`, Rust workspace tests, build, journal validation, and PR readiness review before merge.

## Next Steps
- R2 artefact capture remains deferred.
- Budget aggregation beyond command lifecycle summaries remains a later slice.
