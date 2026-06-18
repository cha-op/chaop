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

## Current State
- A steady realtime persisted event is budgeted at 12 D1 rows written.
- Boundary events cost 14, 16, or 18 rows when the burst, four-hour, or daily usage windows need new rows.
- A command lifecycle event with an attached task is budgeted at 20 rows in the steady case.
- Same-minute bounded backfill is budgeted as 6 rows per imported event plus 6 fixed usage-window rows after active windows exist.

## Validation
- `pnpm test`
- `pnpm build`
- Project journal validator, `validate --repo .`
- `git diff --check`
- Helper-backed `codex-readonly` review: `LGTM`

## Next Steps
- Deploy with the Mahane operations env and verify Budget Board reports the new `8,333` daily event budget.
