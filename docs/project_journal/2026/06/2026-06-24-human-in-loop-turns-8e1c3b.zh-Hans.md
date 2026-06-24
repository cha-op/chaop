---
id: 20260624-8e1c3b-zh-Hans
title: Human-In-The-Loop Turns
status: active
created: 2026-06-24
updated: 2026-06-24
branch: wip/human-in-loop-turns
pr: 21
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

## Review follow-up
- 最后一轮 review 发现 permission approval 需要先向 operator 展示 requested `network` 和 `fileSystem` 明细，才能安全批准 turn 或 session scope。
- Review 也发现 dogfood safety pause 不能对隐藏的 approval/input request event 做 fake accept；现在 control plane 拒绝必要 interaction event 时，connector 会让对应 turn 可见地失败。
- App-server input auto-resolution 现在会发出 `input.received` resolution event，这样 Browser clients 能清掉过期的 pending input controls，迟到提交也会被现有 resolution guard 拒绝。
- 后续 review 发现 connector race：final app-server events 可能先于已排队的 interaction events 返回。现在 connector 会先 drain pending interaction events，再返回最终 turn events。
- Sample HITL 数据现在使用泛化 workspace 路径，不再使用 deployment-instance 或本机路径。

## 成本说明
- 每次 human-in-the-loop pause 最多增加两条 event row：一条 request，一条 response。
- Resolution claim 按 command 和 interaction 共同限定，避免不同 turn 复用 app-server request ID 时让后续 response 被错误拦住。
- WebSocket delivery 继续作为首选 realtime path；现有 10 秒 fallback polling 不变。
- 新增的 `turn_interaction` safety action 让 hard limit 和 pause controls 可以在 operator response 产生 D1 写入前拦截。
