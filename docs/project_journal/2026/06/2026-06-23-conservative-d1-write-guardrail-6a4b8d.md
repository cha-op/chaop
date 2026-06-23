---
id: 20260623-6a4b8d
title: Conservative D1 Write Guardrail
status: active
created: 2026-06-23
updated: 2026-06-23
branch: wip/app-server-attach-resume
pr:
supersedes:
superseded_by:
---

[ British English | [简体中文](2026-06-23-conservative-d1-write-guardrail-6a4b8d.zh-Hans.md) ]

# Conservative D1 Write Guardrail

## Summary
- A pre-merge review found that local D1 rows-written guardrails used the cheapest steady persisted-event cost, 12 rows, when Cloudflare telemetry was missing.
- Chaop's common dogfood command lifecycle with an attached task costs 20 D1 rows in the steady case because it also updates command state, task state, and connector activity.
- The local fallback guardrail now budgets 20 D1 rows per event, reducing the default no-telemetry daily capacity from 8,333 events to 5,000 events.

## Notes
- The detailed D1 write model still exposes cheaper event components: 12 rows for a steady realtime event, 14/16/18 rows for window-boundary events, 6 rows per backfill event plus batched usage-window updates, and 20 rows for an attached command lifecycle.
- Cloudflare telemetry remains preferred when available. The conservative fallback matters when telemetry is unconfigured, missing, or temporarily failing.
- Tracked Wrangler defaults were updated to the conservative event capacities so new generic deployments do not inherit the older optimistic thresholds.

## Validation
- `pnpm --filter @chaop/worker test`
- `pnpm test`
- `pnpm build`
