---
id: 20260619-6e9f3a-zh-Hans
title: Cloudflare Telemetry Budget Bootstrap
status: completed
created: 2026-06-19
updated: 2026-06-19
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

## 实现说明
- `POST /api/budget/bootstrap` 需要 Browser auth 和 origin check，只写当前 `daily`、`four_hour` 和 `burst` usage windows。
- Cloudflare telemetry 是 best-effort，并且使用短 timeout；GraphQL 失败时相关 constraints 会保持 `missing`，不会让 Browser 读取失败。
- 只有 `CF_TELEMETRY_DO_NAMESPACE_NAME` 把 metric 限定到 Chaop namespace 时，Durable Object periodic incoming WebSocket messages 才会折算进 request equivalents。
- Budget Board 的 compact posture 继续使用 sampled hard constraints 中 remaining ratio 最低的一项。
- 面向用户的部署文档和成本文档已经说明可选 Cloudflare token 权限，并继续遵守不记录部署实例值的要求。

## 验证
- `pnpm --filter @chaop/worker typecheck`
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`
- `pnpm test`
- `pnpm build`
- `git diff --check`

## 下一步
- 写入只读 `CF_TELEMETRY_API_TOKEN` secret 后部署 API Worker。
- 部署后如果控制面暂时很安静、当前 D1 windows 仍然 missing，可以在 Budget Board 点击 `Bootstrap` 一次。
