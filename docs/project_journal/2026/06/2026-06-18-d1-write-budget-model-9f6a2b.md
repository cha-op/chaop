---
id: 20260618-9f6a2b
title: D1 Write Budget Model
status: completed
created: 2026-06-18
updated: 2026-06-18
branch: wip/app-server-attach-resume
pr:
supersedes:
superseded_by:
---

[ British English | [简体中文](2026-06-18-d1-write-budget-model-9f6a2b.zh-Hans.md) ]

# D1 Write Budget Model

## Summary
- Replace the coarse five-row D1 event estimate with a schema-derived rows-written budget model.
- Expose the model in Budget Summary payloads so the Browser Budget Board can show the budget source.
- Add a checked-in API deployment script that reads private env files and preserves the Access JWT verification bindings.

## Current State
- A steady realtime persisted event is budgeted at 12 D1 rows written.
- Boundary events cost 14, 16, or 18 rows when the burst, four-hour, or daily usage windows need new rows.
- A command lifecycle event with an attached task is budgeted at 20 rows in the steady case.
- Same-minute bounded backfill is budgeted as 6 rows per imported event plus 6 fixed usage-window rows after active windows exist.

## Validation
- `pnpm test`
- `pnpm build`
- `node --check scripts/deploy-api.mjs`
- `pnpm deploy:api` with the private Mahane env files
- Live smoke: `/api/usage-summary` returns `d1_write_model.budgeted_rows_written_per_event = 12` and `daily_budget_units = 8333`
- Live smoke: Browser GUI serves `assets/index-DIUBOg07.js`
- Project journal validator, `validate --repo .`
- `git diff --check`
- Helper-backed `codex-readonly` review: `LGTM`
- Helper-backed `codex-review` follow-up found a missing API build step in `deploy:api`; fixed by building `@chaop/worker` before migrations and deploy.

## Next Steps
- Open a PR for the branch once the deployment script follow-up commit is pushed.
