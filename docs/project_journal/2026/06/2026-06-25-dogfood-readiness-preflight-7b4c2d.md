---
id: 20260625-7b4c2d
title: Connector And Budget Preflight
status: completed
created: 2026-06-25
updated: 2026-07-01
branch: wip/dogfood-readiness-preflight
pr: 25
supersedes:
superseded_by:
---

[ British English | [简体中文](2026-06-25-dogfood-readiness-preflight-7b4c2d.zh-Hans.md) ]

# Connector And Budget Preflight

## Summary
- PR G adds a passive readiness preflight to the Budget Board so an operator can check cost posture, connector capability, app-server availability for the target workspace, and the next safe action before daily dogfood work starts.
- The preflight derives its decision entirely from the existing bootstrap payload: `safety`, `budget`, `connectors`, and `app_server_instances`.
- It does not add a Worker route, D1 write path, connector report, Host Session refresh, or background poll.
- Review follow-up scopes readiness to the thread that Thread Centre will actually open, preserves the selected thread target across view navigation, and falls back to the default workspace only when no explicit thread target is supplied, so another workspace cannot make the current dogfood path look ready.
- A selected attached thread now accepts health only from the connector that owns its app-server Host Session; a selected existing thread without an app-server attachment is blocked and routed to Host Sessions instead of borrowing workspace-level capacity and falling through to placeholder execution.
- If that owning connector is missing, unlinked, offline, or lacks app-server execution capability, the connector check reports the exact owner failure instead of diagnosing another connector in the workspace.
- Thread-scoped app-server instances now require an exact target-thread match before they can satisfy the readiness check, so a dedicated instance for another thread in the same workspace cannot create a false ready state.
- Externally managed app-server listeners still count as ready when the connector reports the app-server thread and execution capabilities; the preflight tests the execution path, not the service-manager ownership model.
- Final review follow-up routes missing sampled budget constraints to Budget Board instead of marking the path ready, treats any idle healthy app-server instance as sufficient even when another instance is busy, and allows selected existing attached app-server threads to run on exec-only connectors.
- The Thread Centre empty state now exposes the local app-server thread creation form, and local thread connector selection is aligned end-to-end: Web readiness, the create form, and Worker auto-selection all require create-and-exec capability on the same workspace connector.
- Worker auto-selection prioritises connectors with a healthy idle connector- or workspace-scoped app-server instance before falling back to recency, so a different unhealthy connector cannot consume a workspace-level ready decision.

## Scope
- Add a tested Web state helper that returns a compact `ready`, `attention`, or `blocked` preflight decision.
- Render the preflight at the top of Budget Board with four focused checks: cost posture, connector, app-server, and inventory sync.
- Keep the action path as hash navigation to the existing Budget Board, Host Sessions, or Thread Centre views.

## Cost Notes
- Passive preflight reads only data already loaded by bootstrap or realtime updates.
- Broad Host Session inventory remains explicit and opt-in.
- Multiple Browser clients do not increase connector reporting frequency through this preflight.
- Missing live or persisted budget samples are intentionally shown as requiring attention, so first-run operators must bootstrap or inspect Budget Board before relying on readiness.

## Validation Evidence
- `pnpm --filter @chaop/web test` passed with 77 tests covering exact matching for thread-scoped app-server instances, missing sampled budgets, mixed busy/idle app-server instances, selected existing attached app-server threads, attachment-owner isolation and diagnostics across multiple connectors, explicit Budget Board URL targets, and blocking for selected unattached threads.
- `pnpm test` passed after merging the latest `master`: 48 script, 3 protocol, 77 Web, 294 Worker, and 203 Rust tests.
- `pnpm build` passed.
- Local Playwright visual smoke passed for desktop, narrow desktop, breakpoint-edge, and mobile Budget Board rendering, with no horizontal overflow.
