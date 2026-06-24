---
id: 20260623-b19c4e
title: Dogfood Safety Gate
status: active
created: 2026-06-23
updated: 2026-06-24
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
- Kept `/api/safety-posture` as the explicit short-cached live Cloudflare telemetry refresh, and persisted that sample into the low-frequency telemetry bucket for later write guards.
- Narrowed safety copy from broad "dogfood writes" wording to "guarded dogfood actions" so cleanup paths that remain intentionally available are not misrepresented.
- Split conservative Host Session refresh blocking from focused pending command dispatch so a conservative posture does not strand already accepted work.
- Re-checked `command_create` safety before every pending command lease/dispatch, so terminal command cleanup cannot start another pending command while dogfood safety is paused, hard-limited, or throttled.
- Dropped non-terminal connector progress events during pause, throttle, or hard limit without D1 writes, while still acknowledging them so connectors can send the terminal cleanup event.
- Treated malformed emergency-pause setting rows as fail-closed, matching unreadable pause state behaviour.
- Removed machine-local validation paths from the tracked journal entries.
- Kept the standalone safety-posture endpoint aligned with sample bootstrap data when local dev mode runs without a D1 binding.
- Normalised legacy bootstrap payloads without `safety`, so a staggered Web/API deployment does not blank the Browser shell.
- Moved guarded write-path safety checks to persisted telemetry samples instead of live Cloudflare GraphQL calls, while keeping `/api/safety-posture` as the explicit live refresh path.
- Guarded Host Session detach with the safety gate because detaching can clear attachments, fail commands, and dispatch released work.
- Rechecked `command_create` safety after stale app-server target cleanup before dispatching pending commands on both direct `agent.ready` and internal dispatch paths.
- Kept no-D1 sample-mode safety read-only: sample refresh is blocked by sample safety, while pause/resume requires a real D1 binding.
- Stopped Host Session auto-refresh immediately after a server safety block returns updated safety posture.
- Fixed the same-bucket Cloudflare telemetry persistence path so cumulative counters update the existing bucket row, keeping later write guards aligned with the latest explicit safety or budget refresh.
- Tightened guarded write telemetry reads to use the current UTC day's persisted maximum cumulative counters per metric, so a later lower Cloudflare sample cannot relax an earlier hard limit.
- Made production Host Session refresh fail closed when the D1 binding is unavailable, while keeping sample-mode refresh governed by sample safety.
- Merged live safety refresh telemetry with the persisted current-day maximum before returning `/api/safety-posture`, keeping Browser controls aligned with guarded write decisions.
- Dropped in-flight `agent.host_sessions` reports when `host_session_refresh` safety blocks broad inventory writes, while still releasing conservative pending command dispatch after clearing the refresh marker.
- Added `app_server_instances_report` safety coverage so emergency pause, throttling, and hard limits also block connector status-report persistence.
- Derived bootstrap safety from the same Budget Summary constraints and state used by the Budget Board, so live telemetry cannot make the initial budget and safety postures disagree.
- Kept terminal command events as the cleanup path under safety blocks, and prevented that cleanup from dispatching new work while `command_create` is blocked.
- Merged current-day persisted maximum Cloudflare telemetry into Budget Summary calculations, keeping `/api/bootstrap` and `/api/usage-summary` aligned with guarded write decisions when a later live sample is lower.
- Reused the short-cached live Cloudflare telemetry sample in guarded write checks, so an explicit live safety refresh can still block writes in the same Worker isolate even when telemetry sample persistence fails.
- Guarded app-server stopped status writes during connector WebSocket close, preventing disconnect cleanup from bypassing the `app_server_instances_report` safety action.
- Extended the live telemetry fallback cache across sample-bucket boundaries for the same UTC day and telemetry selector, and merged it by per-metric high-water marks so a later lower live sample cannot drop hard-limit protection.
- Guarded duplicate-connector retirement app-server stopped writes with the same `app_server_instances_report` safety action, while leaving command/offline cleanup available.
- Preserved `command.started` event recording during safety pauses and hard limits, so an already-dispatched command moves out of expiring lease state while noisy progress output can still be dropped.
- Triggered a best-effort global pending-command dispatch after safety resume, so queued work does not wait for an unrelated connector event after an operator clears the pause.
- Kept live telemetry daily high-water fallback until the UTC day boundary, so a persisted-sample failure cannot relax a same-day hard limit after the short bucket TTL expires.

## Local Validation
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`
- `pnpm --filter @chaop/worker test -- --test-name-pattern "dogfood safety pause|command started|safety pause and resume"`
- `pnpm --filter @chaop/worker test -- --test-name-pattern "cached live hard limit"`
- `pnpm test`
- `pnpm build`
- `cargo fmt --check`
- `project-journal validate --repo .`
- `git diff --check`

## Next Steps
- Rerun the three review lanes and resolve every GitHub conversation before merge.
