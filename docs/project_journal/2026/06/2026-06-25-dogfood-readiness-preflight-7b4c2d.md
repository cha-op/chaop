---
id: 20260625-7b4c2d
title: Connector And Budget Preflight
status: completed
created: 2026-06-25
updated: 2026-06-25
branch: wip/dogfood-readiness-preflight
pr:
supersedes:
superseded_by:
---

[ British English | [简体中文](2026-06-25-dogfood-readiness-preflight-7b4c2d.zh-Hans.md) ]

# Connector And Budget Preflight

## Summary
- PR G adds a passive readiness preflight to the Budget Board so an operator can check cost posture, connector capability, app-server availability for the target workspace, and the next safe action before daily dogfood work starts.
- The preflight derives its decision entirely from the existing bootstrap payload: `safety`, `budget`, `connectors`, and `app_server_instances`.
- It does not add a Worker route, D1 write path, connector report, Host Session refresh, or background poll.
- Review follow-up scopes readiness to the thread that Thread Centre will actually open, preserves the selected thread target across view navigation, and falls back to the default workspace only when no thread is available, so another workspace cannot make the current dogfood path look ready.
- Externally managed app-server listeners still count as ready when the connector reports the app-server thread and execution capabilities; the preflight tests the execution path, not the service-manager ownership model.

## Scope
- Add a tested Web state helper that returns a compact `ready`, `attention`, or `blocked` preflight decision.
- Render the preflight at the top of Budget Board with four focused checks: cost posture, connector, app-server, and inventory sync.
- Keep the action path as hash navigation to the existing Budget Board, Host Sessions, or Thread Centre views.

## Cost Notes
- Passive preflight reads only data already loaded by bootstrap or realtime updates.
- Broad Host Session inventory remains explicit and opt-in.
- Multiple Browser clients do not increase connector reporting frequency through this preflight.

## Validation Evidence
- `pnpm --filter @chaop/web test` passed with readiness helper coverage.
- `pnpm test` passed.
- `pnpm build` passed.
- Local Playwright visual smoke passed for desktop, narrow desktop, breakpoint-edge, and mobile Budget Board rendering, with no horizontal overflow.
- API and Web deployments were refreshed after the initial change; Web was refreshed again after review fixes.
- `pnpm smoke:deployed` passed after the final Web refresh: direct API health/bootstrap/usage checks returned 200, browser bootstrap returned 200, Budget Board state was `normal`, source was `cloudflare_analytics`, and the bottleneck was D1 rows read / day at 11%.
