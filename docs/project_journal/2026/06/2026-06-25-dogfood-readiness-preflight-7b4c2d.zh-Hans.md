---
id: 20260625-7b4c2d-zh-Hans
title: Connector 和 Budget 预检
status: completed
created: 2026-06-25
updated: 2026-06-25
branch: wip/dogfood-readiness-preflight
pr:
supersedes:
superseded_by:
---

[ [British English](2026-06-25-dogfood-readiness-preflight-7b4c2d.md) | 简体中文 ]

# Connector 和 Budget 预检

## 摘要
- PR G 在 Budget Board 顶部增加一个被动 readiness preflight，让 operator 在开始日常 dogfood 前可以先检查 cost posture、connector capability、managed app-server availability，以及下一步安全操作。
- 这个 preflight 完全从现有 bootstrap payload 推导：`safety`、`budget`、`connectors` 和 `app_server_instances`。
- 它不新增 Worker route、D1 write path、connector report、Host Session refresh，也不新增后台 poll。

## 范围
- 增加一个有测试覆盖的 Web state helper，返回简洁的 `ready`、`attention` 或 `blocked` preflight decision。
- 在 Budget Board 顶部渲染 preflight，聚焦四个检查项：cost posture、connector、app-server 和 inventory sync。
- 操作入口保持为现有 Budget Board、Host Sessions 或 Thread Centre 视图的 hash navigation。

## 成本说明
- 被动 preflight 只读取 bootstrap 或 realtime updates 已经加载的数据。
- Broad Host Session inventory 继续保持显式 opt-in。
- 多个 Browser clients 不会因为这个 preflight 增加 connector report 频率。

## 验证证据
- `pnpm --filter @chaop/web test` 已通过，覆盖 readiness helper。
- `pnpm test` 已通过。
- `pnpm build` 已通过。
- 本地 Playwright 视觉 smoke 已通过，桌面和移动端 Budget Board 渲染正常，没有横向溢出。
- 修改后已刷新 API 和 Web 部署。
- `pnpm smoke:deployed` 已通过：direct API health/bootstrap/usage 检查均返回 200，browser bootstrap 返回 200，Budget Board 状态为 `normal`，source 为 `cloudflare_analytics`，bottleneck 为 D1 rows read / day，使用率 10.7%。
