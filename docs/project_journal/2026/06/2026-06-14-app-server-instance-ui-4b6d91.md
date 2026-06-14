---
id: 20260614-4b6d91
title: AppServerInstance UI
status: completed
created: 2026-06-14
updated: 2026-06-14
branch: wip/app-server-instance-ui
pr:
supersedes: 20260614-6e5f4a
superseded_by:
---

[ British English | [简体中文](2026-06-14-app-server-instance-ui-4b6d91.zh-Hans.md) ]

# AppServerInstance UI

## Summary
- PR4 makes the cost-safe AppServerInstance model visible in the Browser without adding high-frequency charts or log streams.
- Operations Map now focuses its side panel on app-server instances instead of generic thread leads.
- Host Sessions now shows the relevant connector app-server state beside reported sessions and keeps a compact app-server instance list in the side panel.

## Completed Work
- Added Web display helpers for connector-scoped AppServerInstance filtering, priority sorting, primary-instance selection, and state labels.
- Added instance cards with connector identity, endpoint type, scope, active turn count, generation, changed age, seen age, instance key, and summary/error text.
- Added Host Sessions row chips so unattached and attached sessions expose the connector's primary app-server health at scan time.
- Extended fallback sample data to exercise healthy, degraded, and restarting states.
- Tightened Fleet health row layout after visual smoke showed the realtime chip could overflow in the narrower Operations Map primary panel.

## Validation
- `pnpm --filter @chaop/web test`
- Playwright CLI screenshot smoke for Operations Map and Host Sessions against local Vite fallback data.
- `pnpm test`
- `pnpm build`
- `cargo fmt --check`
- `git diff --check`

## Next Steps
- PR5 should make managed app-server execution the default command path while keeping `codex_exec` behind an explicit private/developer flag.
- PR5 should not add lifecycle restart/drain controls yet; those remain PR6.
