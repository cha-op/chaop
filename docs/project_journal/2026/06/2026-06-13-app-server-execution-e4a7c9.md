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
- PR readiness review also aligned command leasing with command creation for task commands whose thread is attached but whose task attachment is missing; leasing now falls back from task attachment to thread attachment only when no task-attached Host Session exists.
- Offline frozen-diff review found and fixed a pending-command detach race; detaching an app-server Host Session now fails pending or expired-leased Codex commands that can no longer resolve any replacement app-server attachment, instead of leaving them permanently pending.
- Final PR readiness review tightened that detach cleanup further: only replacement app-server Host Sessions owned by the same target connector can preserve a pending command.
- Final offline review found that app-server command startup kept paging after a session match; the command resolver now returns as soon as the target app-server session is found.
- Final independent review found and fixed the lease-before-dispatch detach window; detaching an app-server Host Session now fails both pending and leased-but-not-running Codex commands that depend on that attachment.
- Final frozen-diff review found a remaining detach/dispatch acknowledgement race; Worker command-event acknowledgements now include `accepted`, and the Rust connector aborts local execution when `command.started` is rejected as stale.
- Detached-command replacement matching now keeps the outer replacement scoped to the command target connector while using the same connector-agnostic task-first existence check as command leasing, so cross-connector task attachments cannot incorrectly enable a thread fallback.
- Independent PR review found a detach ordering race; detach now clears the Host Session attachment before failing commands that depended on the saved old attachment, so concurrent command creation cannot target a session that is already being detached.
- Independent PR review found the stale `command.started` race could still win after cleanup selected a leased command. App-server-only connector starts now revalidate the current task/thread Host Session target before accepting `command.started`.
- Detached-command cleanup also covers legacy or delayed app-server commands with `target_connector_id IS NULL`, while preserving replacement matching for any current app-server Host Session that command leasing could select.
- Independent PR review found a remaining create/detach cross-request race where command creation could read an old app-server attachment, then insert after detach cleanup had already scanned commands. App-server Codex command creation now uses a guarded insert that only writes the command if the current task/thread Host Session selected by the same task-first/latest ordering still resolves to the same app-server target.
- Independent PR review found a reattach-after-dispatch race: the same connector could receive a command for one app-server Host Session, then attach a different Host Session to the same task/thread before sending `command.started`. App-server `command.started` events now include `target_host_session_id`, and Worker acknowledgements reject starts unless that session still matches the current task/thread target.
- Follow-up independent review found a remaining TOCTOU window between the `command.started` Host Session identity check and the command state update. Worker now folds the current Host Session target check into the same guarded `UPDATE commands ... WHERE ... EXISTS (...)` statement that moves the command to `running`.
- Detached-command replacement matching now also requires the replacement connector to be executable, online, and advertising `codex_app_server_exec`, so cleanup is not suppressed by an attached Host Session that command leasing cannot actually dispatch to.
- Independent review found that `command.started` Host Session revalidation could still be skipped for an externally registered connector that advertised both `codex_exec` and `codex_app_server_exec`. Worker now stores the app-server Host Session id selected at command lease time and requires started events for that leased target to echo the same target before the guarded state update can run.

## Validation Targets
- Worker tests for command dispatch target host-session mapping.
- Worker tests assert command leasing joins only the latest task-first attached Host Session.
- Worker tests assert command leasing preserves the task-first, thread-fallback attachment selection SQL.
- Worker route tests cover app-server Host Session detach failing pending attachment-dependent Codex commands.
- Worker route tests assert detached-command replacement matching is scoped to the command target connector.
- Worker route tests assert detached-command replacement matching requires executable online app-server connector capability and uses the same task-first blocking rule as command leasing.
- Worker route tests assert detached-command cleanup covers leased commands immediately instead of waiting for lease expiry.
- Worker route tests assert Host Session detach clears the attachment before command cleanup queries run.
- Worker Durable Object tests assert stale agent command events receive `server.ack` with `accepted: false`.
- Worker tests assert app-server-leased `command.started` events without the leased target session id are rejected, while ordinary Codex starts without an app-server lease target remain accepted.
- Worker DB tests assert app-server-only `command.started` events are rejected after the current Host Session attachment is gone.
- Worker DB tests assert app-server-only `command.started` events are rejected after the same connector reattaches a different Host Session to the command scope.
- Worker DB tests assert app-server-only `command.started` events are accepted only when the guarded command-state update still resolves the current target Host Session to the event `target_host_session_id`.
- Worker route tests assert app-server command creation returns `409 Conflict` when the attached Host Session changes before the command insert.
- Rust tests for app-server session resolution, deep page scanning, `thread/resume`, `turn/start`, terminal turn handling, completion notifications, cancellation interrupts, and command-output omission.
- Rust tests assert app-server command session resolution stops paging once the target session is found.
- Rust tests assert rejected command-event acknowledgements are recognised instead of treated as successful acks.
- Rust tests assert app-server `command.started` event payloads identify the target Host Session, without leaking that field onto non-started events.
- Rust tests cover the `turn/start` cancellation window before the connector has read the turn id.
- Full `pnpm test`, Rust workspace tests, build, journal validation, and PR readiness review before merge.

## Next Steps
- R2 artefact capture remains deferred.
- Budget aggregation beyond command lifecycle summaries remains a later slice.
