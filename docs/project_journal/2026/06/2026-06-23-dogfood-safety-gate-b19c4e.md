---
id: 20260623-b19c4e
title: Dogfood Safety Gate
status: active
created: 2026-06-23
updated: 2026-06-23
branch: wip/dogfood-safety-gate
pr: 19
supersedes:
superseded_by:
---

[ British English | [简体中文](2026-06-23-dogfood-safety-gate-b19c4e.zh-Hans.md) ]

# Dogfood Safety Gate

## Summary
- PR A starts from the updated `master` after the app-server attach/resume PR was merged.
- The goal is to keep dogfood usage cost-safe before adding the richer Thread Centre chat flow.
- The slice should expose the current safety posture prominently, guard costly write and refresh actions on the server, and provide an emergency pause or stop path that works even when multiple browsers are open.

## Implementation Plan
- Add a protocol/API safety posture that derives from the current Budget Summary and any emergency pause flag.
- Gate expensive browser-triggered operations such as command creation, local thread creation, Host Session refresh, and app-server attach/backfill when posture is unsafe.
- Add a Browser control for emergency pause/resume and make disabled actions explain the active limit instead of failing silently.
- Keep broad Host Session inventory opt-in and debounce-preserving.
- Update tests, bilingual docs, and deployed E2E smoke expectations before opening the PR.

## Validation Plan
- Run focused worker/web tests while developing.
- Run the full local gate before commit: pnpm tests, Rust tests, journal validation, build, formatting, and diff checks.
- Redeploy API and Web after code changes, then run the deployed E2E smoke.
- Run three review lanes before merge and resolve every GitHub conversation.

## Progress
- Implemented the protocol safety posture, Worker guard, emergency pause/resume API, and Browser safety strip.
- Guarded command creation, local thread creation, Host Session refresh, app-server attach, task archive/unarchive, and budget bootstrap from the server side.
- Added tests for conservative posture, emergency pause/resume, blocked command creation, blocked Host Session refresh, migration coverage, null telemetry handling, and Browser safety helper behaviour.
- Fixed the first review finding by including connector and active task budget states in the dogfood safety posture and server-side guard decisions.
- Preserved structured safety payloads in Browser API errors so a server-side safety block immediately updates the local UI posture.
- Fixed a second review finding by making unreadable emergency-pause state fail closed instead of allowing guarded writes.
- Added the `agent_event` guard so running connector WebSocket events are rejected before D1 event persistence when dogfood safety is paused or hard-limited.
- Refined `agent_event` handling so noisy non-terminal events are blocked during pause or hard limit, while terminal `command.finished` / `command.failed` events can still close the command and clear socket activity.
- Guarded automatic `agent.ready` Host Session refresh dispatches with the same `host_session_refresh` safety action, and skipped pending command dispatch in the same ready cycle when the refresh is blocked.
- Switched server-side safety posture from persisted telemetry samples to short-cached live Cloudflare telemetry best-effort, without persisting telemetry from guarded action paths.
- Narrowed safety copy from broad "dogfood writes" wording to "guarded dogfood actions" so cleanup paths that remain intentionally available are not misrepresented.

## Local Validation
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`
- `pnpm test`
- `pnpm build`
- `cargo fmt --check`
- `python3 /Users/joey/.codex/personal-sync/overlays/private/releases/5f1ab3fa5d9f7d534507216a2d6f765694f9b710/personal_codex/skills/project-journal/scripts/project_journal.py validate --repo .`
- `git diff --check`

## Next Steps
- Commit and push the review fix.
- Refresh the API/Web deployment, run deployed E2E smoke, then rerun the three review lanes and resolve every GitHub conversation before merge.
