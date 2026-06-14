---
id: 20260614-6e5f4a-zh-Hans
title: App-server Instance State
status: completed
created: 2026-06-14
updated: 2026-06-14
branch: wip/app-server-instance-state
pr: https://github.com/cha-op/chaop/pull/12
supersedes: 20260614-9c3b2d
superseded_by:
---

[ [British English](2026-06-14-app-server-instance-state-6e5f4a.md) | 简体中文 ]

# App-server Instance State

## 摘要
- PR3 增加独立的 AppServerInstance state channel，不把 app-server health 塞进 Host Session inventory。
- Worker 会把 connector-wide app-server instance state 持久化到 D1，并对未变化 summaries 做服务端去重和 debounce。
- Connector 会及时上报状态边缘，并用低频节奏发送未变化 summaries。
- Web bootstrap 和 realtime state 现在可以携带 app-server instances；可视化仍留给 PR4 的 Operations 和 Host Sessions UI。

## 实现
- 增加 `app_server_instances` D1 schema，记录 connector id、instance key、scope、endpoint type、state、active turn count、generation、summary 和 timestamps。
- 增加 `agent.app_server_instances` 与 `app_server_instances.updated` protocol payloads。
- 增加 Worker DB recording，包含 15 分钟 unchanged summary debounce、state-edge 立即写入、snapshot omission 标记 stopped，以及 connector offline 标记 stopped。
- 增加 Durable Object validation、ack、browser fanout，以及短窗口内存级 duplicate healthy report suppression。
- 增加 connector 侧 app-server instance snapshots、`app_server_instance_state` capability、ack/retry handling、五分钟 summaries，以及 app-server turn 前后的 active turn count 上报。
- 增加 Web state merge 支持，让 bootstrap 和 realtime app-server instance payloads 可进入前端 state，但不提前实现 PR4 UI。

## 成本护栏
- 本机 health probing 仍留在 connector 本地。
- 重复 healthy reports 如果在 DO 短窗口内重复，会在进入 D1 前被过滤。
- 即使 DO cache miss，D1 仍会对未变化 summaries 做 15 分钟 debounce，避免高频写入循环。
- Degraded、restarting、stopped 等状态边缘和 active turn count changes 会绕过 unchanged summary debounce。
- Bootstrap 保持只读，只返回已持久化的 instance state。

## 验证
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`
- `cargo test -p chaop-agent`
- `cargo fmt --check`

## 下一片
- PR4 会在 Operations 和 Host Sessions 相关界面展示 AppServerInstance state。
