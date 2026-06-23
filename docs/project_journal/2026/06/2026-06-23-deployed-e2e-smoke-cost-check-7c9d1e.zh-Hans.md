---
id: 20260623-7c9d1e-zh-Hans
title: Deployed E2E Smoke And Cost Check
status: completed
created: 2026-06-23
updated: 2026-06-23
branch: wip/app-server-attach-resume
pr:
supersedes:
superseded_by:
---

[ [British English](2026-06-23-deployed-e2e-smoke-cost-check-7c9d1e.md) | 简体中文 ]

# Deployed E2E Smoke And Cost Check

## 摘要
- 已把 deployed E2E smoke 流程记录到 `docs/e2e-smoke.zh-Hans.md`，并维护对应英文文档。
- 增加 repo-local `chaop-deployed-e2e-smoke` skill，因为这个流程依赖 Chaop 专用的 Cloudflare Access cookie exchange、Budget Board telemetry 和私有 ops env 约定。
- 已通过新的 Access service-token smoke path 验证已部署的 API 和 Web Workers。
- 在 host-session inventory cost-control 部署后，重新检查了线上 Budget Summary。

## 当前状态
- API smoke 已通过：`/api/health`、`/api/bootstrap` 和 `/api/usage-summary` 都通过 Cloudflare Access service-token auth 返回 `200` JSON。
- Static Web smoke 已通过：GUI index 和它引用的 JavaScript/CSS assets 都返回 `200`，且 body 非空。
- Browser smoke 在改用 Access cookie exchange 后通过。直接在浏览器 extra headers 里注入 service-token headers 会触发 CORS preflight failure，且请求会在 Worker 添加 CORS headers 前被拦下。
- Live Budget Summary 现在返回 `source: cloudflare_analytics` 和 `state: normal`。
- Live constraints 不再是 missing：D1 rows-written/day、Worker requests/day、Durable Object requests/day 和 D1 rows-read/day 都是 `normal`。
- 采样检查时，当前 UTC 日实测 D1 rows written 是 769；D1 rows-written/day constraint 约 0.8%，D1 rows-read/day 约 1.2%。

## 成本缩减判断
- 已部署的 budget data 已恢复健康，不再停留在之前的 over-limit state。
- API、asset、browser 和 budget smoke 都走被动读取，不需要创建 command、刷新 Host Session inventory，也不需要写入 budget bootstrap rows。
- 这确认了当前部署的 cost posture 和只读 smoke path。它不能单独证明 connector inventory reduction 在 active connector load 下也生效；如果写入增长再次出现，还需要短时间打开 connector 做 observation window。

## 下一步
- 后续 deployed smoke 使用 repo-local skill。
- 如果要验证 inventory write reduction under load，短时间运行一个 connector，避免自动 Host Sessions refresh，并在一次显式 inventory refresh 前后比较 D1 rows-written slope。
