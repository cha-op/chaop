---
id: 20260613-e4a7c9
title: App-server Execution Slice
status: completed
created: 2026-06-13
updated: 2026-06-13
branch: wip/app-server-command-execution
pr: https://github.com/cha-op/chaop/pull/5
supersedes:
  - 20260610-b7f2c1
superseded_by:
---

[ British English | [简体中文](2026-06-13-app-server-execution-e4a7c9.zh-Hans.md) ]

# App-server Execution Slice

## Summary
- This slice adds a real Codex app-server execution path for Chaop commands.
- The path is opt-in through private connector config: `execution.mode = "app_server"` plus `session_inventory.app_server_url`.
- The CLI adapter remains available as `execution.mode = "codex_exec"` for fallback and comparison.

## Decisions
- Run app-server commands only for Chaop threads or tasks already attached to a local app-server Host Session.
- Keep command dispatch compatible with the existing `codex` command type; the Worker now includes the attached local session target in `command.dispatch`.
- Resolve the stored app-server `sessionId` to the current app-server `Thread.id` before execution, then call `thread/resume` and `turn/start`.
- Return concise Chaop lifecycle events and final assistant-message summaries from the app-server turn rather than uploading local command output, transcripts, or artefact data.

## Implementation Notes
- Protocol adds `CommandTargetHostSession` and optional `CommandDispatch.target_host_session`.
- Worker command leasing joins attached `host_sessions` so the Durable Object can dispatch the local session target to the connector.
- Command creation now prefers the connector that owns the attached Host Session for the selected thread/task, instead of choosing an arbitrary recent workspace connector.
- Attached app-server commands require the owning connector to advertise `codex_app_server_exec`; Worker creation/leasing and the Rust connector both refuse to fall back to plain `codex_exec`.
- Connector config adds `execution.mode = "app_server"` and advertises `codex_app_server_exec` only when `session_inventory.app_server_url` is also configured, without also advertising the CLI-only `codex_exec` capability.
- The Rust connector keeps its control WebSocket responsive while the app-server command runs in a background worker.
- The app-server execution path handles synchronous terminal `turn/start` responses and asynchronous `turn/completed` notifications.
- App-server `thread/resume` and `turn/start` use the attached session cwd when it is absolute, falling back to connector `workspace_root` only when the attached cwd is missing or invalid.
- Command session resolution scans app-server `thread/list` pages under the command timeout budget instead of reusing the archive sync page budget.
- Connector cancellation or command timeout best-effort sends app-server `turn/interrupt` when a turn id is already known or can still be recovered from the `turn/start` response.
- App-server `commandExecution` output is intentionally not converted into Chaop command events by default.
- PR readiness review found and fixed a dispatch consistency bug where command creation selected the latest attached Host Session but command leasing could join an older duplicate attachment row; leasing now uses the same task-first, latest-updated Host Session selection.

## Validation Targets
- Worker tests for command dispatch target host-session mapping.
- Worker tests assert command leasing joins only the latest task-first attached Host Session.
- Rust tests for app-server session resolution, deep page scanning, `thread/resume`, `turn/start`, terminal turn handling, completion notifications, cancellation interrupts, and command-output omission.
- Rust tests cover the `turn/start` cancellation window before the connector has read the turn id.
- Full `pnpm test`, Rust workspace tests, build, journal validation, and PR readiness review before merge.

## Next Steps
- R2 artefact capture remains deferred.
- Budget aggregation beyond command lifecycle summaries remains a later slice.
