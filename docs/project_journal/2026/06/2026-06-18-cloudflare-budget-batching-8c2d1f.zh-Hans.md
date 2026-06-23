---
id: 20260618-8c2d1f-zh-Hans
title: Cloudflare Budget Batching
status: completed
created: 2026-06-18
updated: 2026-06-18
branch: wip/app-server-attach-resume
pr:
supersedes:
superseded_by:
---

[ [British English](2026-06-18-cloudflare-budget-batching-8c2d1f.md) | 简体中文 ]

# Cloudflare Budget Batching

## 摘要
- Budget windows 现在使用基于 Cloudflare Free plan 额度的估算值，不再使用过小的开发期阈值。
- Usage-window 记账会先按 window 聚合 events 再写入 D1，因此有界 backfill 每批只会让每个 active window 更新一次。

## 当前状态
- 已被后续细节取代：原先的 five-row D1 write estimate 已由 `2026-06-18-d1-write-budget-model-9f6a2b.md` 中的 schema-derived model 取代。
- 默认 four-hour hard budget 是 daily event budget 的六分之一，soft budget 约为这个 four-hour hard budget 的百分之七十五。
- Budget summary 在读取 D1 rows 时，会根据当前环境配置重新计算 `used_pct` 和 `budget_state`，因此修改预算后仍未结束的 windows 会立即使用新阈值。
- Budget window payload 会向 Browser Budget Board 暴露 `budget_units` 和 `estimated_d1_rows_written`。

## 验证
- `pnpm test`
- `pnpm build`
- Project journal validator, `validate --repo .`
- `git diff --check`

## 下一步
- 部署更新后的 Worker，让新的 Wrangler budget vars 和重新计算后的 usage-window output 在生产环境生效。
