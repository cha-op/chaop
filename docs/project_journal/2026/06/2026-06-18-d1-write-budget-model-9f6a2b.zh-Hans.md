---
id: 20260618-9f6a2b-zh-Hans
title: D1 Write Budget Model
status: completed
created: 2026-06-18
updated: 2026-06-18
branch: wip/app-server-attach-resume
pr:
supersedes:
superseded_by:
---

[ [British English](2026-06-18-d1-write-budget-model-9f6a2b.md) | 简体中文 ]

# D1 Write Budget Model

## 摘要
- 把原先粗略的 five-row D1 event estimate 改成从当前 schema 推导的 rows-written budget model。
- Budget Summary payload 会暴露这个 model，因此 Browser Budget Board 可以显示预算来源。
- 增加已提交的 API 部署脚本，读取私有 env 文件，并保留 Access JWT verification bindings。
- 把 Budget Summary 展开成 per-limit constraints，让缩略 posture 和 throttle decisions 可以使用 sampled hard constraints 中 remaining ratio 最低的一项。

## 当前状态
- 一个 steady realtime persisted event 按 12 D1 rows written 预算。
- 如果 burst、four-hour 或 daily usage windows 需要插入新 row，边界 events 分别是 14、16 或 18 rows。
- 带 attached task 的 command lifecycle event 在 steady case 下按 20 rows 预算。
- 同一分钟内的有界 backfill 按每个 imported event 6 rows，加上 active windows 已存在时固定 6 rows usage-window 开销来预算。
- `constraints` 现在会暴露 sampled D1 rows-written constraints，以及 missing 状态的 Cloudflare request/read constraints；`bottleneck_constraint` 是 sampled hard constraints 里 remaining ratio 最低的一项。

## 验证
- `pnpm test`
- `pnpm build`
- `node --check scripts/deploy-api.mjs`
- 使用 Mahane 私有 env 文件执行 `pnpm deploy:api`
- 线上 smoke：`/api/usage-summary` 返回 `d1_write_model.budgeted_rows_written_per_event = 12` 和 `daily_budget_units = 8333`
- 线上 smoke：Browser GUI 返回 `assets/index-DIUBOg07.js`
- Project journal validator, `validate --repo .`
- `git diff --check`
- Helper-backed `codex-readonly` review：`LGTM`
- Helper-backed `codex-review` follow-up 发现 `deploy:api` 缺少 API build step；已通过在 migration 和 deploy 前构建 `@chaop/worker` 修复。
- Helper-backed `codex-readonly` follow-up 发现新前端连接旧 payload 且没有 `constraints` 时，Budget Board 可能渲染空的 budget bars；已通过合成 legacy daily/four-hour/burst constraints 修复，并重新复查为 `LGTM`。
- Helper-backed `codex-readonly` follow-up 发现 compact budget chip 对 legacy state 和 aggregate state 有回归；已通过在 fallback constraints 中保留 legacy summary state，并让 chip severity 使用全局 `budget.state` 修复，随后重新复查为 `LGTM`。

## 下一步
- 推送部署脚本 follow-up commit 后，为当前分支开 PR。
