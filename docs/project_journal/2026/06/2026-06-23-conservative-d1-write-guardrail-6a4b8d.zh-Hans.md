---
id: 20260623-6a4b8d-zh-Hans
title: 保守 D1 写入护栏
status: active
created: 2026-06-23
updated: 2026-06-23
branch: wip/app-server-attach-resume
pr:
supersedes:
superseded_by:
---

[ [British English](2026-06-23-conservative-d1-write-guardrail-6a4b8d.md) | 简体中文 ]

# 保守 D1 写入护栏

## 摘要
- 合并前 review 发现：Cloudflare telemetry missing 时，本地 D1 rows-written guardrails 使用了最便宜的 steady persisted-event 成本，也就是 12 行。
- Chaop 在 dogfood 中常见的带 attached task command lifecycle 在 steady case 是 20 行 D1，因为它还会更新 command state、task state 和 connector activity；边界事件还可能更高。
- 本地 fallback guardrail 现在按每个 event 26 行 D1 预算，把默认 no-telemetry daily capacity 从 8,333 events 降到 3,846 events。
- Cloudflare telemetry 可用但低于 Chaop 本地 daily estimate 时，daily D1 rows-written guardrail 现在使用本地 estimate。
- Schema-model zero baselines 仍然会显示在详细 constraint list 中，但不再计入 sampled constraints 或 top-bar bottleneck。

## 说明
- 详细 D1 write model 仍然展示更便宜的 event components：steady realtime event 12 行，window-boundary event 14/16/18 行，backfill event 每个 6 行加 batched usage-window updates，steady attached command lifecycle 20 行，以及 no-telemetry guardrail budget 26 行。
- Cloudflare telemetry 可用时仍然优先使用实测值。保守 fallback 主要覆盖 telemetry 未配置、missing 或临时失败的时候。
- tracked Wrangler defaults 已更新到保守 event capacities，避免新的通用部署继承旧的乐观阈值。
- 部署指南示例也使用同一组保守 capacities，因为 deploy profile 中的值会覆盖 Worker runtime vars。
- Review follow-up 会在 D1 rows-written constraint state 中保留 four-hour soft budget，并按导入时间记录 Host Session backfill usage windows，同时在 thread history 里保留原始 event timestamp。

## 验证
- `pnpm --filter @chaop/worker test`
- `pnpm test`
- `pnpm build`
- 已增加 Cloudflare telemetry 低于本地 D1 write estimate 的覆盖。
- 已更新 schema-model zero baselines，不再把它们计为 sampled constraints。
- 已增加 four-hour soft-limit constraint state 和 import-time backfill budget windows 的覆盖。
