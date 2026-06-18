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

## 当前状态
- 一个 steady realtime persisted event 按 12 D1 rows written 预算。
- 如果 burst、four-hour 或 daily usage windows 需要插入新 row，边界 events 分别是 14、16 或 18 rows。
- 带 attached task 的 command lifecycle event 在 steady case 下按 20 rows 预算。
- 同一分钟内的有界 backfill 按每个 imported event 6 rows，加上 active windows 已存在时固定 6 rows usage-window 开销来预算。

## 验证
- `pnpm test`
- `pnpm build`
- Project journal validator, `validate --repo .`
- `git diff --check`
- Helper-backed `codex-readonly` review：`LGTM`

## 下一步
- 使用 Mahane operations env 部署，并验证 Budget Board 显示新的 `8,333` daily event budget。
