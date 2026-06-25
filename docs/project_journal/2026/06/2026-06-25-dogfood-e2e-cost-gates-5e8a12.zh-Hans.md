---
id: 20260625-5e8a12-zh-Hans
title: Dogfood E2E Cost Gates
status: completed
created: 2026-06-25
updated: 2026-06-25
branch: wip/dogfood-e2e-cost-gates
pr:
supersedes: []
superseded_by:
---

[ [British English](2026-06-25-dogfood-e2e-cost-gates-5e8a12.md) | 简体中文 ]

# Dogfood E2E Cost Gates

## 摘要
- PR E 把 deployed smoke workflow 从临时 runner 固化为已跟踪的低成本脚本。
- runner 会验证通过 Access authentication 的 API、bootstrap、usage summary、GUI assets、browser rendering 和 Budget Board posture，不调用产品写路径 endpoints。`/api/usage-summary` 仍可能刷新并缓存一条有界 Cloudflare telemetry sample。
- Budget gate 默认会在 Cloudflare telemetry 或当前日 D1 rows-written 实测 activity 缺失时失败。

## 当前状态
- `scripts/deployed-smoke.mjs` 是 `pnpm smoke:deployed` 背后的 operator entrypoint。
- 浏览器路径使用 Cloudflare Access cookie exchange，而不是把 service-token headers 注入跨域 browser requests。
- 浏览器路径会在 Cloudflare 返回 Access binding cookies 时和 `CF_Authorization` 一起保留。
- direct service-token fetches 会禁用自动重定向，避免同源 asset check 把 Access headers 泄露给 off-origin redirect target。
- direct API、asset、Access cookie-exchange 和 browser bootstrap fetches 都有 smoke-level timeout，避免部署检查卡住。
- asset checks 会校验 JavaScript/CSS content types，避免 Cloudflare Assets 的 SPA fallback HTML 让缺失 asset 误判通过。
- asset summaries 和 asset failure messages 会隐藏部署 origin，只报告路径。
- deployed smoke runner 会在 `/api/usage-summary` 后立即评估 budget gate，gate 失败时会在 GUI asset 或 browser checks 前停止。
- budget gate 会把 `hard_limited`、`throttled`、sampled hard constraints 缺失、telemetry 缺失、D1 rows-written activity 缺失，以及 bottleneck/D1 write usage 过高视为失败。
- `--allow-missing-telemetry` 只用于已知 telemetry outage 或非 dogfood 环境。

## 下一步
- 精确 D1 write attribution 继续延后，直到 telemetry 再次显示无法解释的写入增长。
- API/Web deploy 或 connector cost-control 变更后，继续使用 deployed smoke。

## 证据
- 本地 Node tests 覆盖 argument parsing、asset 和 cookie parsing，以及 budget gate 的 pass/fail 行为。
- 完整本地和 deployed validation 应在 merge 前记录到 PR readiness report。
