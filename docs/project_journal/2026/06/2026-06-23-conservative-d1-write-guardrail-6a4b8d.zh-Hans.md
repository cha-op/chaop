---
id: 20260623-6a4b8d-zh-Hans
title: Conservative D1 Write Guardrail
status: active
created: 2026-06-23
updated: 2026-06-23
branch: wip/app-server-attach-resume
pr:
supersedes:
superseded_by:
---

[ [British English](2026-06-23-conservative-d1-write-guardrail-6a4b8d.md) | 简体中文 ]

# Conservative D1 Write Guardrail

## 摘要
- 合并前 review 发现：Cloudflare telemetry missing 时，本地 D1 rows-written guardrails 使用了最便宜的 steady persisted-event 成本，也就是 12 行。
- Chaop 在 dogfood 中常见的带 attached task command lifecycle 在 steady case 是 20 行 D1，因为它还会更新 command state、task state 和 connector activity。
- 本地 fallback guardrail 现在按每个 event 20 行 D1 预算，把默认 no-telemetry daily capacity 从 8,333 events 降到 5,000 events。

## 说明
- 详细 D1 write model 仍然展示更便宜的 event components：steady realtime event 12 行，window-boundary event 14/16/18 行，backfill event 每个 6 行加 batched usage-window updates，以及 attached command lifecycle 20 行。
- Cloudflare telemetry 可用时仍然优先使用实测值。保守 fallback 主要覆盖 telemetry 未配置、missing 或临时失败的时候。
- tracked Wrangler defaults 已更新到保守 event capacities，避免新的通用部署继承旧的乐观阈值。

## 验证
- `pnpm --filter @chaop/worker test`
- `pnpm test`
- `pnpm build`
