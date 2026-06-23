---
id: 20260615-f4c9a8
title: App-server Attach Resume
status: completed
created: 2026-06-15
updated: 2026-06-23
branch: wip/app-server-attach-resume
pr: 18
supersedes:
superseded_by:
---

[ British English | [简体中文](2026-06-15-app-server-attach-resume-f4c9a8.zh-Hans.md) ]

# App-server Attach Resume

## Summary
- Attaching an unused local Codex session is now an app-server resume operation when the selected connector supports managed app-server execution.
- The attach path no longer leaves app-server-capable sessions in a D1-only state that forces Thread Centre back to placeholder commands.

## Current State
- The Worker loads the Host Session before attach. If it is not already live-attached and its connector advertises `host_session_app_server_ensure`, it asks the Workspace Durable Object to ensure the session through app-server first, even when the stored row already says `app_server_present`.
- The Durable Object sends `host_session.app_server_ensure` to the target connector and waits for `host_session.app_server_ensure_result`.
- The Rust connector handles the request in both idle and active-turn background control paths, resolves the real app-server `thread.id` from active or archived `thread/list` rows when needed, unarchives archived matches, calls app-server `thread/resume` with `excludeTurns: true`, and returns an `app_server_present` Host Session without starting a turn.
- The Worker records the returned Host Session through the normal inventory upsert path before creating the Chaop task/thread attachment, so Thread Centre can immediately offer the managed app-server command path.
- Connectors without the dedicated ensure capability keep the existing D1-only attach behaviour, even if they support older app-server command execution.
- Review follow-up added `host_session_app_server_ensure` as a dedicated capability so deploying the Worker before restarting older connectors does not turn attach into a 15 second timeout on an unknown control envelope.
- Review follow-up also made explicit Host Session attach fail when app-server `thread/list` resolution exhausts the bounded page budget, instead of falling back to the local session id as a guessed app-server `threadId`.
- Regression follow-up on 2026-06-16 bounds initialize, unarchive, and resume through one local app-server deadline, maps local read timeouts to a clear app-server method timeout, and stops guessing `threadId` from the local session id when `thread/list` has no matching thread.
- When a historical rollout/session id is absent from app-server `thread/list`, the connector now resolves the local rollout file path from Codex history and calls app-server `thread/resume` with that path instead of guessing a `threadId`.
- Managed app-server command execution uses the same rollout path fallback after an active `thread/list` miss, then starts the turn on the real `thread.id` returned by app-server resume.
- Archive/unarchive sync now uses rollout path resume after source and target `thread/list` misses, then mutates the real app-server `thread.id` returned by resume.
- Review follow-up rejects app-server ensure responses for a different session id, uses rollout cwd for path-based attach and command resumes, and falls back to rollout resume after page-budgeted `thread/list` misses.
- Review follow-up also validates the app-server `thread/resume` response session id before returning an ensured Host Session, so a stale or unexpected app-server response cannot attach the wrong local session.
- Review follow-up also keeps archive/unarchive sync available for app-server lineage sessions after active inventory demotes `app_server_present`, so an archived app-server thread can be unarchived back through the connector.
- Successful unarchive sync restores the attached Host Session's D1 `app_server_present` marker when active-only inventory had previously demoted it, so the next managed app-server command is accepted.
- Review follow-up requests a debounced Host Sessions refresh after `agent.ready` before pending command dispatch, so newly created local sessions become visible without restoring high-frequency connector inventory polling.
- Budget summary keeps headline percentages as `missing` when D1 has no current usage windows, instead of reporting a misleading zero baseline.

## Validation
- `pnpm --filter @chaop/worker test`
- `cargo test -p chaop-agent`
- `cargo test -p chaop-agent session_inventory -- --nocapture`
- `cargo test -p chaop-agent ensure_host_session_rejects_mismatched_resume_session_id -- --test-threads=1`
- `pnpm --dir apps/web test`
- `pnpm --dir apps/worker test -- routes.test.ts`
- `pnpm test`
- `pnpm build`
- `git diff --check`

## Next Steps
- Deploy the updated Worker and restart the local connector with the rebuilt agent before live E2E validation.
