---
id: 20260619-6e9f3a-zh-Hans
title: Cloudflare Telemetry Budget Bootstrap
status: completed
created: 2026-06-19
updated: 2026-06-22
branch: wip/app-server-attach-resume
pr:
supersedes:
superseded_by:
---

[ [British English](2026-06-19-cloudflare-telemetry-budget-bootstrap-6e9f3a.md) | 简体中文 ]

# Cloudflare Telemetry Budget Bootstrap

## 摘要
- Budget Board 现在可以把当前 D1 usage windows 初始化成 zero-count samples，避免安静部署里 D1 rows-written 一直显示 missing。
- API Worker 可以选择性读取当前 UTC 日的 Cloudflare GraphQL Analytics，用于 Worker requests、Durable Object request-equivalent usage、D1 rows read 和 D1 rows written。
- Runtime telemetry 使用单独的 `CF_TELEMETRY_API_TOKEN` Worker secret；非 secret selector vars 由 API deploy script 生成。
- 后续 telemetry debugging 发现 Cloudflare GraphQL Analytics 不支持 GraphQL directives，而且线上查询常见耗时约两秒；Worker 查询现在不再使用 directives，默认 timeout 调整为五秒。
- D1 row-write telemetry 显示当前日写入偏高主要来自 Host Session inventory churn，不是 command events。Worker 现在会跳过未变化的 Host Session inventory upserts，并且只广播变化行。

## 实现说明
- `POST /api/budget/bootstrap` 需要 Browser auth 和 origin check，只写当前 `daily`、`four_hour` 和 `burst` usage windows。
- Cloudflare telemetry 是 best-effort，并且使用短 timeout；GraphQL 失败时相关 constraints 会保持 `missing`，不会让 Browser 读取失败。
- 只有 `CF_TELEMETRY_DO_NAMESPACE_NAME` 把 metric 限定到 Chaop namespace 时，Durable Object periodic incoming WebSocket messages 才会折算进 request equivalents。
- Budget Board 的 compact posture 继续使用 sampled hard constraints 中 remaining ratio 最低的一项。
- 面向用户的部署文档和成本文档已经说明可选 Cloudflare token 权限，并继续遵守不记录部署实例值的要求。
- Missing constraint details 现在会把显示的数值标成 limit，避免 UI 看起来像那些数值是当前用量。

## 验证
- `pnpm --filter @chaop/worker typecheck`
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`
- `pnpm test`
- `pnpm build`
- Project journal validator。
- `git diff --check`
- 使用与 Worker 查询相同字段集的 live Cloudflare GraphQL smoke test。

## 证据
- 原始 live telemetry query 失败信息为 `directives not supported`。
- 修正后的 live query 能返回当前日 API Worker requests、D1 rows read/written 和 Durable Object invocations。
- 远端 D1 行数显示只有 295 条 `events` rows 和 157 个 usage-window event counts，但有 1,177 条 `host_sessions` rows，因此重复 Host Session inventory upserts 是最强的 write amplification 来源。

## 下一步
- 从已验证的 commit 部署 API 和 Web Workers。
- 部署后观察 Budget Board。Cloudflare 当前日 counters 可能会在下一个 UTC 日之前继续偏高，因为 Analytics 返回的是当天累计值，不是只统计修复后的窗口。
- 后续保留一个 backlog：让 cost posture detailed view 更清楚地区分 Cloudflare telemetry actual usage 和配置上限，并解释 D1 write drivers。
