---
id: 20260625-5e8a12
title: Dogfood E2E Cost Gates
status: completed
created: 2026-06-25
updated: 2026-06-25
branch: wip/dogfood-e2e-cost-gates
pr:
supersedes: []
superseded_by:
---

[ British English | [简体中文](2026-06-25-dogfood-e2e-cost-gates-5e8a12.zh-Hans.md) ]

# Dogfood E2E Cost Gates

## Summary
- PR E turns the deployed smoke workflow from a temporary runner into a tracked low-cost script.
- The runner verifies Access-authenticated API, bootstrap, usage summary, GUI assets, browser rendering, and Budget Board posture without calling product write-path endpoints. `/api/usage-summary` can still refresh and cache a bounded Cloudflare telemetry sample.
- Budget gate checks now fail by default when Cloudflare telemetry or measured current-day D1 rows-written activity is missing.

## Current State
- `scripts/deployed-smoke.mjs` is the operator entrypoint behind `pnpm smoke:deployed`.
- The browser path uses Cloudflare Access cookie exchange instead of injecting service-token headers into cross-origin browser requests.
- The budget gate treats `hard_limited`, `throttled`, missing sampled hard constraints, missing telemetry, missing D1 rows-written activity, and high bottleneck/D1-write usage as failures.
- `--allow-missing-telemetry` is available only for known telemetry outages or non-dogfood environments.

## Next Steps
- Keep exact D1 write attribution deferred until telemetry shows unexplained write growth again.
- Continue using the deployed smoke after API/Web deploys and after connector cost-control changes.

## Evidence
- Local Node tests cover argument parsing, asset and cookie parsing, and budget gate pass/fail behaviour.
- Full local and deployed validation should be recorded in the PR readiness report before merge.
