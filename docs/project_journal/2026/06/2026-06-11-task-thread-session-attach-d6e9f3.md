---
id: 20260611-d6e9f3
title: Task Thread Session Attach Slice
status: active
created: 2026-06-11
updated: 2026-06-13
branch:
pr:
supersedes: []
superseded_by:
---

[ British English | [简体中文](2026-06-11-task-thread-session-attach-d6e9f3.zh-Hans.md) ]

# Task Thread Session Attach Slice

## Summary
- This slice makes one task map to one primary thread.
- Task Board now has an archive lane, and archived tasks can be restored.
- Host Sessions exposes connector-reported local Codex sessions and can attach an unattached session as a task/thread pair.
- Thread Command Centre now opens real threads from the thread list, Task Board cards, or attached host sessions.

## Decisions
- A task is a view over one thread for this slice; grouped-thread task views remain future work.
- Archive/unarchive updates the task and its primary thread together.
- Connector session inventory reports lightweight metadata only: session id, title, title source, cwd, and updated time.
- Title resolution prefers metadata or rollout title fields, then optional app-server `Thread.name`, then local history, then cwd/session-id fallback.

## Validation Targets
- Protocol and Worker tests for the new host session realtime envelope and required task thread ids.
- Rust tests for session title priority and local Codex metadata scanning.
- Web typecheck for Host Sessions, archive actions, and selected-thread command submission.
- Existing full build/test gate before commit.

## 2026-06-12 Attach Follow-Up
- Deployed Host Sessions rendered correctly, but attach returned 401 when the API Access destination did not cover the new `/api/host-sessions/*` write path.
- Worker 401 copy now explains missing Browser Access coverage or an expired Access session.
- The Web UI now surfaces server-provided action errors in a wrapping alert and shows the full host `session_id` in each Host Sessions row.
- Deployment guidance now recommends covering the Browser API with `/api/*` plus `/ws/browser`, while keeping connector bootstrap outside `/api/*`.
- Agent bootstrap moved to `/connector/bootstrap` so broad Browser Access coverage for `/api/*` does not wrap connector bootstrap. The old `/api/agent/bootstrap` alias was removed after Access was reconfigured.
- Host Sessions now hides archived task/thread attachments from the active attached list; they remain restorable from the Task Board archive view.
- Historical Host Session attachment still imports metadata/title only. Full transcript or rollout event backfill is deferred to a later slice.
- Codex exec diagnostics now distinguish a missing Codex executable from workspace `cwd` failures, and deployment docs recommend an absolute `execution.codex_command` for service-managed connectors.
- Thread Centre now merges bootstrap/polling payloads with local realtime state so older bootstrap snapshots do not drop already-received events. Empty attached threads show an empty timeline instead of placeholder lifecycle rows.
- Thread Centre now exposes the same archive/unarchive action as Task Board for the selected task/thread.
- Host Sessions now has a manual refresh button, `Last synced` timestamp, and age display. The refresh request asks online connectors to rescan immediately, then reloads the control-plane snapshot.
- The connector now periodically rescans local Codex sessions using `session_inventory.report_interval_seconds` and only sends the periodic inventory report when the serialized inventory changes. Worker and Web now treat each connector inventory as a connector-scoped snapshot so removed local sessions do not linger as attachable rows.
- Connector session inventory now creates lightweight entries from `history.jsonl` even when a session has no `session_index` or rollout metadata yet, using history `ts` as the session update time and the first prompt as the title.
- Host Sessions now has an explicit detach API and UI action. Detach clears the host session attachment pointers but preserves the task/thread history so archive and restore can be tested without deleting the created task.

## 2026-06-12 Review Hardening
- The D1 `0003` migration now preserves existing `commands.task_id` links while rebuilding `tasks`, and a direct SQLite migration check confirmed the command still points at its task after migration.
- The D1 schema and `0005` compatibility migration now allow a distinct `failed` task state while preserving existing command/task and host-session/task links for already-migrated deployments.
- Thread event sequencing now uses an atomic `UPDATE threads ... RETURNING last_seq` allocation path, reducing same-thread concurrent event collisions.
- Durable Object agent socket close/error handling now only marks a connector offline after the last socket for that connector is gone, then fails leased/running commands, updates the attached task state, and broadcasts failure events to Browser sockets.
- The Rust connector now defers non-ACK WebSocket messages seen while waiting for an event ACK, so a queued `command.dispatch` is handled after the current command instead of being consumed.
- Session inventory rollout scanning is bounded to recent date directories and a capped rollout file set before reading rollout metadata.
- Browser command creation now requires a D1 binding outside local insecure dev, validates that workspace/thread/task ids belong together before insert, and waits for `command.started` before moving a task to `running`.
- `command.failed` now maps to a visible `failed` task state in Worker, protocol grouping, and Task Board rather than being folded into `done`.
- Connector bootstrap now uses a stable connector identity for the same name/hostname, lets a valid offline connector token reconnect and mark itself online, and retires older duplicate connector rows through the disconnect cleanup path while migrating host-session attachments.
- Successful bootstrap reloads now clear stale full-screen Web load errors.
- Host session inventory reports are now treated as bounded top-N updates rather than complete snapshots: Worker no longer deletes missing session rows from a partial report, and realtime Browser updates no longer clear the connector-local session list. This preserves existing attachments outside the latest report window.
- Browser bootstrap merging now follows the same partial-inventory contract and preserves current host sessions that are absent from a newer top-N payload. Worker bootstrap lists prioritise attached host sessions before unattached recent sessions, so attached task/thread rows are not displaced by the 200-row payload cap.
- Connector `codex_exec` now runs the Codex CLI wait in a background worker while the WebSocket loop keeps responding to pings, close frames, and Host Sessions refresh requests; other messages remain deferred until the command finishes.
- Connector `codex_exec` now passes a cancellation signal into the Codex CLI worker and joins the worker on socket close or read error, so a stale child process is killed instead of running until timeout after the server has already failed the command.
- Continuous connector mode now reconnects after socket close or non-timeout read errors with a small backoff, while `--run-once` still returns after one handled command.
- Browser command request validation now rejects empty optional ids for thread, task, and target connector fields before DB insert.
- Session inventory now reads bounded recent tails from `session_index.jsonl` and `history.jsonl` instead of loading the full files every scan. The default periodic scan interval is now 60 seconds, while manual Host Sessions refresh still asks online connectors to rescan immediately.

## 2026-06-13 Local Thread Creation
- Chaop now has a Browser API for creating a new local Codex app-server thread through an online connector that advertises `app_server_threads`.
- `WorkspaceDO` now supports a bounded request/response RPC over the existing agent WebSocket: Worker sends `thread.create`, the connector replies with `thread.create_result`, and the API returns a clear timeout or connector error when creation fails.
- The Rust connector now uses `session_inventory.app_server_url` to call app-server `thread/start`, applies a requested title with `thread/name/set`, and reports the created session back as lightweight host-session metadata.
- Review follow-up tightened the cwd boundary: new local threads start from the connector's private `workspace_root`, while Browser requests cannot supply an arbitrary cwd. App-server title updates are best-effort so a successful `thread/start` is still attached if `thread/name/set` fails. The created host session is also upserted with the request workspace so multi-workspace connectors cannot attach the new task/thread to a different workspace.
- Worker D1 helpers upsert the created app-server session and reuse the existing attach flow so the new session immediately becomes a task/thread pair.
- Task Board and Thread Command Centre now expose a focused `New local thread` form; successful creation opens the real thread.
- Deployment guidance now documents the local `codex app-server --experimental --listen ws://127.0.0.1:9876` prerequisite and the private connector `app_server_url` setting.

## Next Steps
- After new-thread creation works, add old-session history backfill so attached sessions can show useful previous output without uploading broad local transcripts by default.
- After history backfill, sync Chaop archive/unarchive to the local Codex app-server archive state through the connector. Keep local history files read-only.
- Keep the Codex CLI adapter as the current working execution fallback until the app-server protocol path can cover create, resume, archive, and event/history reads cleanly.
- Keep R2 artefact capture and budget aggregation behind this core control-loop closure work.
