---
id: 20260623-5b7a2c
title: Host Session Inventory Cost Control
status: completed
created: 2026-06-23
updated: 2026-06-23
branch: wip/app-server-attach-resume
pr:
supersedes:
superseded_by:
---

[ British English | [简体中文](2026-06-23-host-session-inventory-cost-control-5b7a2c.zh-Hans.md) ]

# Host Session Inventory Cost Control

## Summary
- Host Session inventory is now demand-driven by default. Connectors stay quiet while idle instead of periodically rescanning local Codex sessions.
- The Browser Host Sessions page keeps the manual refresh button and adds an opt-in one-minute auto-refresh toggle for users who are actively watching local sessions.
- The Workspace Durable Object deduplicates refresh requests per connector and uses a one-minute cooldown, so extra browser devices or tabs do not multiply connector inventory refreshes.
- Thread event realtime remains the high-frequency path; inventory is deliberately lower-frequency because it is broader, more expensive, and less urgent.

## Implementation Notes
- `POST /api/host-sessions/refresh` now returns dispatched, debounced, and cooldown counts so the Browser can show why a refresh did or did not fan out.
- `WorkspaceDO` chooses the newest ready socket per connector when requesting inventory, then marks that socket as pending Host Session refresh so command dispatch continues to wait for the requested local snapshot.
- The Rust connector no longer sends Host Session inventory after ordinary `agent.ready` updates or idle read ticks. Explicit `host_sessions.refresh` requests and user-action paths still send one report.
- The Browser avoids the previous three immediate bootstrap reloads after a refresh request. When the WebSocket is live it waits for the realtime Host Sessions update; when it is not live it performs one delayed bootstrap read as a fallback.

## Validation
- `pnpm --filter @chaop/protocol test`
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`
- `cargo test --workspace`
- `pnpm test`
- `pnpm build`
- Project journal validator.
- `git diff --check`
- Internal `codex-readonly` review found that connector-level pending inventory needed to gate all peer sockets for the same connector; the follow-up fix adds that guard and regression tests.
- Second internal `codex-readonly` review after the fix returned `LGTM`.

## Next Steps
- Watch D1 rows-written residuals after deployment with the connector briefly enabled.
- Keep exact D1 query-meta attribution as the next tool if Cloudflare counters still show unexplained write growth.
