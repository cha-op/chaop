---
id: 20260614-c7e2a4
title: App-server Restart Flow
status: completed
created: 2026-06-14
updated: 2026-06-14
branch: wip/app-server-restart-flow
pr: https://github.com/cha-op/chaop/pull/15
supersedes: 20260614-a5d8c0
superseded_by:
---

[ British English | [简体中文](2026-06-14-app-server-restart-flow-c7e2a4.zh-Hans.md) ]

# App-server Restart Flow

## Summary
- PR6 adds the connector-side primitive for draining managed app-server restarts.
- Periodic restart and local upgrade-marker restart requests now withdraw app-server capabilities while active turns drain.
- The connector restarts the managed listener after active turns finish, or after the configured drain timeout if a turn is abandoned.

## Completed Work
- Added managed app-server config for `drain_timeout_seconds`, `scheduled_restart_interval_seconds`, and `upgrade_marker_file`.
- Added AppServerManager state for pending restarts, scheduled restart deadlines, and upgrade marker modification tracking.
- Added `draining` lifecycle transitions that return no app-server URL in runtime config, so `agent.ready` stops advertising app-server thread/archive/execution capabilities during drain.
- Added a bounded app-server runtime maintenance tick while app-server commands are running, so scheduled or marker-triggered restarts can enter drain and report capability changes during long turns without doing ordinary health-check restarts.
- Treat first creation of the configured upgrade marker file as a restart request when the file did not exist at connector startup.
- Restart attempts clear the pending drain request, reset the periodic schedule, stop the managed child, and reuse the existing health-check/start path.
- Updated deployment guide examples and operator guidance for scheduled restart and upgrade marker usage.

## Validation
- `cargo fmt --check`
- `cargo test -p chaop-agent`
- `pnpm test`
- `pnpm build`
- `git diff --check`
- Project journal validator
- Sensitive deployment value scan

## Next Steps
- PR7 should use these lifecycle primitives when adding multi-instance and placement foundations.
- Remote UI/API controls for scheduling a restart can build on the same manager semantics in a later slice without changing the drain behaviour.
