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
- Follow-up review of that fix found the guarded update still needed to compare the event target against the lease-time target, not only the current attachment. The guarded `command.started` update now also checks `lease_target_host_session_id` against the event target in the same SQL statement.
- Independent review found that a targeted `command.started` event could still be accepted for an ordinary Codex lease with no app-server lease target because the guarded SQL treated a `NULL` lease target as permissive. The guarded update now requires a non-null lease-time app-server target that equals the event target.
- Independent review found detach cleanup could fail nullable-target leased commands owned by another connector and unrelated to the detached app-server Host Session. The leased cleanup branch now requires either a matching lease-time Host Session target or, for legacy null lease targets, the detached connector as lease owner.
- Follow-up independent review found detach cleanup replacement suppression still used any matching leaseable Host Session instead of the exact task-first/latest Host Session that command leasing would select. Detached-command cleanup now uses the same scalar Host Session target selection before checking app-server execution eligibility.
- Follow-up independent review found rejected stale app-server `command.started` acknowledgements could leave the command leased until an unrelated future trigger. Rejected targeted starts now release the app-server lease back to pending, and the Durable Object immediately re-dispatches pending commands across available agent sockets.
- Follow-up frozen-diff review found detach cleanup still inferred pending command dependency from task/thread scope, which could fail ordinary pending `codex_exec` commands created before a Host Session was attached. App-server command creation now persists the intended Host Session id, and detach cleanup only fails pending commands whose stored app-server target matches the detached session.
- Codex review-gate found remaining hardening gaps before merge: app-server assistant deltas are now capped by `codex_output_max_bytes`, detach cleanup revalidates replacement Host Sessions in the guarded failure update, leased detach cleanup refreshes connector activity counts, pending-command Host Session selection no longer uses SQLite outer references in subquery `ORDER BY`, and the cost guide now shows copyable separate TOML mode snippets.
- Follow-up independent review found detach cleanup could still fail a command after it was re-leased or retargeted between the cleanup `SELECT` and failure `UPDATE`. The guarded failure update now revalidates command workspace, type, target connector, scope, lease ownership, and current replacement Host Session selection before writing task or event side effects.
- Follow-up frozen-diff review found rejected stale app-server starts released lease fields but left the stale implicit `target_connector_id` from command creation. Releasing that stale app-server lease now clears only attached-session inferred targets, so immediate re-dispatch can follow the current attachment without allowing explicitly targeted commands to drift to another connector.
- Follow-up independent review found the guarded detach failure update compared `lease_target_host_session_id` to the internal `host_sessions.id` instead of the app-server session id stored in commands. The guarded update now uses `hostSession.session_id` for lease-target matching and reserves `hostSession.id` only for excluding the detached row from replacement selection.
- Codex review-gate found one more stale-start release race: rejected app-server `command.started` acknowledgements now release back to pending only when the current task/thread target resolves to an executable replacement app-server Host Session. If no replacement exists, the command stays app-server-scoped for detach cleanup instead of becoming a generic `codex_exec` command.
- Follow-up frozen-diff review found that stale-start release still constrained replacement Host Sessions to the old connector even when the command target was inferred from an attached session. Rejected starts now allow cross-connector replacement only for `attached` inferred targets; explicit targets remain pinned to the requested connector.
- Follow-up reviews found two remaining stuck or drift paths: expired app-server leases could fall back to `codex_exec`, and explicit app-server targets could stay leased forever after another connector took over the attachment. Pending dispatch now excludes non-null app-server lease targets from the CLI branch, and rejected explicit-target app-server starts fail the command instead of drifting or staying leased.
- Final PR readiness reviews found that cross-connector replacement still failed when the replacement app-server Host Session reused the same app-server session id, and detach cleanup could still fail attached-inferred commands instead of requeueing them for a valid replacement. Stale-start release now excludes only the old connector/session pair, and detach cleanup source-aware releases attachment-inferred commands back to pending before running failure cleanup.
- Final independent review found detach cleanup could still release or fail a command already leased by a replacement connector that reused the same app-server session id. Detach cleanup now requires leased commands to be owned by the detached connector before release or failure handling.
- Third PR readiness review found auto-target commands could get stuck if a task/thread gained an app-server attachment after command creation but before lease. Pending dispatch now allows `auto` targets to retarget to the current app-server attachment owner and converts that lease to an `attached` target before dispatch.
- Follow-up third review found the auto-retarget branch was too broad and the migration over-relaxed existing targeted commands. Auto retargeting now requires the current attachment to be an app-server Host Session, and the migration backfills existing non-null target connectors as `explicit` so upgrade keeps their previous fixed-target behaviour.
- Follow-up frozen-diff review found command leasing could still dispatch stale work if the selected Host Session changed between the pending-command `SELECT` and lease `UPDATE`. The lease update now revalidates the same task-first Host Session target, connector target rules, online executable connector state, and app-server capability before taking the lease.
- Follow-up frozen-diff review also found detach release could leave attached-inferred commands pending until an unrelated trigger. Detach now returns replacement app-server connector ids internally, strips that metadata from the public response, and immediately asks the Durable Object to dispatch pending work to those connectors.
- Codex review-gate found that detach-generated command failure events were persisted but not broadcast to live browser sockets. Detach now returns those events as internal metadata, the HTTP route strips them from the public response, and the Durable Object broadcasts them through a dedicated internal endpoint.
- Codex review-gate also found that non-app-server attached-inferred commands could be inserted after the selected attachment changed. Command creation now revalidates all attached-inferred Host Session targets before insert, while only app-server Codex commands persist a lease-time app-server target.
- Codex review-gate found stale rejected final acknowledgements could stop without polling the connector's next pending command. The Durable Object now polls pending work for the same connector after rejected final command events.
- Offline frozen-diff review found that a command already bound to a stored app-server session target could still be leased against a newer current attachment before any release/retarget flow cleared that stored target. Pending dispatch now requires stored app-server lease targets to be empty or match the selected Host Session session id before dispatch or lease update.

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
- Worker tests assert app-server-leased `command.started` events are rejected when the event target matches the current attachment but differs from the lease-time target.
- Worker tests assert ordinary Codex leases reject targeted app-server `command.started` events, even when the current attachment matches the event target.
- Worker route tests assert Host Session detach does not fail nullable-target leased commands that are owned by another connector.
- Worker route tests assert detach cleanup replacement suppression uses the same scalar task-first/latest Host Session target selection as command leasing.
- Worker route tests assert app-server command creation persists the intended Host Session target id and detach cleanup only matches pending commands with that explicit target.
- Worker DB tests assert rejected stale app-server `command.started` events release the app-server lease for immediate re-dispatch.
- Worker Durable Object tests assert rejected targeted app-server starts trigger pending command dispatch across available agent sockets.
- Worker DB tests assert app-server-only `command.started` events are rejected after the current Host Session attachment is gone.
- Worker DB tests assert app-server-only `command.started` events are rejected after the same connector reattaches a different Host Session to the command scope.
- Worker DB tests assert app-server-only `command.started` events are accepted only when the guarded command-state update still resolves the current target Host Session to the event `target_host_session_id`.
- Worker route tests assert app-server command creation returns `409 Conflict` when the attached Host Session changes before the command insert.
- Worker DB tests assert pending command dispatch uses SQLite-compatible task-first Host Session selection without an outer-reference `ORDER BY`.
- Worker route tests assert Host Session detach refreshes connector activity after failing a leased command.
- Worker route tests assert Host Session detach skips task, event, and connector-activity side effects when the guarded command failure update loses a race.
- Worker DB and Durable Object tests assert rejected stale app-server starts clear only attached-session inferred target connectors while releasing the app-server lease for immediate re-dispatch.
- Worker DB tests assert explicit command targets are preserved when stale app-server starts are rejected, preventing host drift after a user-selected target connector.
- Worker route tests assert guarded detach failure updates bind the stored app-server session id for `lease_target_host_session_id`, not the internal Host Session row id.
- Worker DB tests assert rejected stale app-server starts do not release the lease when the old app-server Host Session was detached and no executable replacement exists.
- Worker Durable Object tests assert rejected targeted app-server starts still release and re-dispatch when a replacement app-server Host Session is available.
- Worker DB tests assert attached-session inferred targets can release stale app-server starts to a replacement connector.
- Worker DB tests assert explicit app-server targets fail when their attachment moved to another connector instead of releasing to that connector.
- Worker DB tests assert expired app-server leases with a stored app-server target do not downgrade to the `codex_exec` dispatch branch.
- Worker DB tests assert attached-inferred stale app-server starts release to a replacement connector even when the replacement reports the same app-server session id.
- Worker route tests assert Host Session detach source-aware releases attached-inferred commands when a replacement app-server Host Session exists, without writing failed task/event side effects.
- Worker route tests assert Host Session detach does not release or fail same-session app-server leases owned by a replacement connector.
- Worker DB tests assert pending auto-target commands retarget to the current app-server attachment owner instead of staying blocked behind the originally selected connector.
- Worker DB tests assert pending auto-target commands do not retarget to non-app-server attachments.
- Migration tests assert existing non-null command targets are backfilled to `explicit` target-source semantics.
- Worker DB tests assert pending-command dispatch skips work when the guarded lease update loses the attachment race.
- Worker route and Durable Object tests assert detached attached-inferred command releases immediately dispatch to replacement app-server connectors while keeping the public detach response unchanged.
- Worker route and Durable Object tests assert detach-generated failure events broadcast to browser sockets through the internal DO endpoint without leaking internal fields in the public response.
- Worker route tests assert attached non-app-server command creation is rejected when the attachment changes before insert.
- Worker Durable Object tests assert rejected stale final command events still poll pending work for that connector.
- Worker DB tests assert pending dispatch skips commands whose stored app-server target differs from the current attachment.
- Rust tests for app-server session resolution, deep page scanning, `thread/resume`, `turn/start`, terminal turn handling, completion notifications, cancellation interrupts, and command-output omission.
- Rust tests assert app-server assistant-message delta accumulation respects the configured byte cap without splitting UTF-8 characters.
- Rust tests assert app-server command session resolution stops paging once the target session is found.
- Rust tests assert rejected command-event acknowledgements are recognised instead of treated as successful acks.
- Rust tests assert app-server `command.started` event payloads identify the target Host Session, without leaking that field onto non-started events.
- Rust tests cover the `turn/start` cancellation window before the connector has read the turn id.
- Full `pnpm test`, Rust workspace tests, build, journal validation, and PR readiness review before merge.

## Next Steps
- R2 artefact capture remains deferred.
- Budget aggregation beyond command lifecycle summaries remains a later slice.
