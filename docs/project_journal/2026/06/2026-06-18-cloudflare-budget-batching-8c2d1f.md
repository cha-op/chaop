---
id: 20260618-8c2d1f
title: Cloudflare Budget Batching
status: completed
created: 2026-06-18
updated: 2026-06-18
branch: wip/app-server-attach-resume
pr:
supersedes:
superseded_by:
---

[ British English | [简体中文](2026-06-18-cloudflare-budget-batching-8c2d1f.zh-Hans.md) ]

# Cloudflare Budget Batching

## Summary
- Budget windows now use Cloudflare Free plan quota estimates instead of very small development thresholds.
- Usage-window accounting aggregates events by window before writing to D1, so bounded backfills update each active window once per batch.

## Current State
- Default daily budget units are derived from the Cloudflare D1 free rows-written quota, using a conservative estimate of five D1 written rows per persisted Chaop event.
- Default four-hour hard budget is one sixth of the daily event budget, with the soft budget at roughly seventy-five per cent of that four-hour hard budget.
- Budget summary output recalculates `used_pct` and `budget_state` from the current environment settings when it reads D1 rows, so changed budgets take effect immediately for still-open windows.
- Budget window payloads expose `budget_units` and `estimated_d1_rows_written` for the Browser Budget Board.

## Validation
- `pnpm test`
- `pnpm build`
- Project journal validator, `validate --repo .`
- `git diff --check`

## Next Steps
- Deploy the updated Worker so the new Wrangler budget vars and recalculated usage-window output are active in production.
