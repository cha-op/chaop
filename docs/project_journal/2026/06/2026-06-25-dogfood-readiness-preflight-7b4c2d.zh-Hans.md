---
id: 20260625-7b4c2d-zh-Hans
title: Connector 和 Budget 预检
status: completed
created: 2026-06-25
updated: 2026-07-01
branch: wip/dogfood-readiness-preflight
pr: 25
supersedes:
superseded_by:
---

[ [British English](2026-06-25-dogfood-readiness-preflight-7b4c2d.md) | 简体中文 ]

# Connector 和 Budget 预检

## 摘要
- PR G 在 Budget Board 顶部增加一个被动 readiness preflight，让 operator 在开始日常 dogfood 前可以先检查 cost posture、connector capability、目标 workspace 的 app-server availability，以及下一步安全操作。
- 这个 preflight 完全从现有 bootstrap payload 推导：`safety`、`budget`、`connectors` 和 `app_server_instances`。
- 它不新增 Worker route、D1 write path、connector report、Host Session refresh，也不新增后台 poll。
- Review follow-up 现在会把 readiness 限定到 Thread Centre 实际会打开的 thread，并且在跨视图导航时保留所选 thread 目标；只有没有显式 thread target 时才回退到默认 workspace，因此其它 workspace ready 不会让当前 dogfood path 被误判为 ready。
- 已选择且已 attach 的 thread 现在只接受拥有其 app-server Host Session 的 connector 所报告的 health；如果选择的现有 thread 尚未 attach app-server，则 readiness 会 blocked 并导向 Host Sessions，不会借用 workspace-level capacity 后落入 placeholder execution。
- Thread-scoped app-server instance 现在必须精确匹配目标 thread 才能满足 readiness check，因此同一 workspace 中另一条 thread 的 dedicated instance 不会造成 false ready。
- 如果 connector 明确报告 app-server thread 和 execution capabilities，外部 service manager 管理的 app-server listener 仍然可以算作 ready；preflight 检查的是 execution path，不是 service-manager ownership model。
- 最终 review follow-up 会把缺少真实预算采样的状态导向 Budget Board，而不是显示 ready；只要存在一个健康且空闲的 app-server instance，即使另一个 instance 正忙也可以算 ready；对于已经 attach 的现有 app-server thread，也允许只具备 execution capability 的 connector 继续运行。
- Thread Centre 空状态现在直接显示本机 app-server thread 创建表单；本机 thread 的 connector 选择已端到端对齐：Web readiness、创建表单和 Worker 自动选择都要求同一 workspace connector 同时具备 create 和 exec capability。
- Worker 自动选择会优先采用拥有健康且空闲的 connector-scoped 或匹配 workspace-scoped app-server instance 的 connector，然后才按更新时间回退，因此另一个不健康 connector 不会消费 workspace-level ready decision。

## 范围
- 增加一个有测试覆盖的 Web state helper，返回简洁的 `ready`、`attention` 或 `blocked` preflight decision。
- 在 Budget Board 顶部渲染 preflight，聚焦四个检查项：cost posture、connector、app-server 和 inventory sync。
- 操作入口保持为现有 Budget Board、Host Sessions 或 Thread Centre 视图的 hash navigation。

## 成本说明
- 被动 preflight 只读取 bootstrap 或 realtime updates 已经加载的数据。
- Broad Host Session inventory 继续保持显式 opt-in。
- 多个 Browser clients 不会因为这个 preflight 增加 connector report 频率。
- 缺少 live 或 persisted budget samples 时会明确显示需要关注，因此首次使用的 operator 需要先 bootstrap 或检查 Budget Board，再依赖 readiness。

## 验证证据
- `pnpm --filter @chaop/web test` 已通过 75 个 tests，覆盖 thread-scoped app-server instance 精确匹配、缺少真实预算采样、busy/idle app-server 混合状态、已选现有 attached app-server thread、多个 connectors 之间的 attachment-owner isolation，以及已选但未 attach thread 必须 blocked 的回归场景。
- 合入最新 `master` 后，`pnpm test` 已通过：48 个 script、3 个 protocol、75 个 Web、294 个 Worker 和 203 个 Rust tests。
- `pnpm build` 已通过。
- 本地 Playwright 视觉 smoke 已通过，桌面、窄桌面、断点边缘和移动端 Budget Board 渲染正常，没有横向溢出。
