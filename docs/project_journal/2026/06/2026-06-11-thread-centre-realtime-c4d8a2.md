---
id: 20260611-c4d8a2
title: Thread Centre Realtime Slice
status: completed
created: 2026-06-11
updated: 2026-06-11
branch:
pr:
supersedes: []
superseded_by:
---

[ British English | [简体中文](2026-06-11-thread-centre-realtime-c4d8a2.zh-Hans.md) ]

# Thread Centre Realtime Slice

## Summary
- This implementation task was migrated back from side chat into the main thread because it touches non-trivial product and backend behaviour.
- Thread Command Centre now prefers browser WebSocket updates and falls back to 10-second polling after disconnects or connection failures.
- Thread events are displayed newest-first so operators do not need to scroll to the bottom after submitting a command.

## Decisions
- Browser realtime uses `/ws/browser`; Vite keeps the local `/ws` proxy, and production derives `wss://.../ws/browser` from `VITE_CHAOP_API_BASE_URL`.
- `WorkspaceDO` broadcasts persisted agent lifecycle events to connected browser sockets as `thread.event` envelopes.
- Fallback polling uses a 10-second interval. The previous 0s / 1s / 2.5s post-submit polling burst is removed.
- `GET /api/bootstrap` no longer unconditionally writes the browser user row, reducing D1 write amplification during polling fallback.

## Implementation Notes
- The web app merges realtime thread events into local bootstrap state and updates command, task, and thread summary state from lifecycle events.
- The top bar exposes connection posture as `Connecting`, `Live`, or `Polling 10s`.
- Worker tests cover read-only bootstrap and browser realtime envelope shape.

## Validation Targets
- Worker tests for no-write bootstrap and DO browser event payloads.
- Web typecheck for realtime state and WebSocket URL handling.
- Existing full build/test gate.
- Browser verification of Thread Command Centre layout and event ordering.

## Validation
- `pnpm build`
- `pnpm test`
- `git diff --check`
- `project_journal.py validate --repo /Users/joey/Program/Codex-workspace/cha-op/chaop`
- Headless Chromium/CDP verification loaded `http://127.0.0.1:5173/#thread-centre` against local Worker dev and observed `Live`.

## Evidence
- Web: `apps/web/src/app-root.ts`, `apps/web/src/api.ts`, `apps/web/src/styles.css`.
- Worker: `apps/worker/src/workspace-do.ts`, `apps/worker/src/db.ts`, `apps/worker/src/routes.test.ts`, `apps/worker/src/workspace-do.test.ts`.
