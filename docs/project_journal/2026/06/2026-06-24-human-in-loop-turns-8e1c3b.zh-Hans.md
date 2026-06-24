---
id: 20260624-8e1c3b-zh-Hans
title: Human-In-The-Loop Turns
status: active
created: 2026-06-24
updated: 2026-06-24
branch: wip/human-in-loop-turns
pr:
supersedes:
superseded_by:
---

[ [British English](2026-06-24-human-in-loop-turns-8e1c3b.md) | 简体中文 ]

# Human-In-The-Loop Turns

## 摘要
- PR C 接在已经合入的 Thread Centre chat MVP 后面，继续让 dogfood safety gate 保护每个会产生写入的 operator action。
- 产品目标是：managed Codex app-server turn 需要 approval 或用户输入时，可以在对应的 Thread Centre turn 里暂停并展示待处理操作；operator 响应后，app-server turn 能继续运行。
- 这一片保持成本有边界：一个 pending interaction 只落一条结构化 thread event，一次 response 只落一条结构化 resolution event。不增加轮询表，也不增加宽泛 connector sync。

## 计划范围
- 扩展 shared protocol，加入结构化 `turn_interaction` request 和 resolution payload。
- 在 D1 中为 events 持久化可选 payload JSON，让 approval/input request 刷新后仍然可见，也能从另一台浏览器响应。
- 增加 browser API，用 `turn_interaction` dogfood safety action 保护单个 pending interaction 的 resolve 操作。
- 通过 connector 把 Codex app-server 的 approval 和 input JSON-RPC request 转发给 Chaop，再把浏览器响应回写给 app-server。
- 在相关 Thread Centre turn 内直接渲染 approval 和 input controls。

## 验证计划
- 跑聚焦的 Web 和 Worker 测试，覆盖 turn aggregation、payload persistence、safety posture 和 interaction resolution。
- 跑聚焦的 Rust connector 测试，覆盖 command approval 和 request-user-input app-server flows。
- PR review 前跑完整本地 test/build gate。
- 最终代码修改后刷新 API 和 Web 部署，然后运行 deployed E2E smoke，并检查 budget/safety posture。

## 成本说明
- 每次 human-in-the-loop pause 最多增加两条 event row：一条 request，一条 response。
- WebSocket delivery 继续作为首选 realtime path；现有 10 秒 fallback polling 不变。
- 新增的 `turn_interaction` safety action 让 hard limit 和 pause controls 可以在 operator response 产生 D1 写入前拦截。
