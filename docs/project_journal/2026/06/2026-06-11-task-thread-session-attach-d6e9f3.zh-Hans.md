---
id: 20260611-d6e9f3-zh-Hans
title: Task Thread Session Attach 切片
status: active
created: 2026-06-11
updated: 2026-06-12
branch:
pr:
supersedes: []
superseded_by:
---

[ [British English](2026-06-11-task-thread-session-attach-d6e9f3.md) | 简体中文 ]

# Task Thread Session Attach 切片

## 摘要
- 这个切片把一个 task 收敛成一个 primary thread。
- Task Board 现在有 archive 视图，已归档 task 可以恢复。
- Host Sessions 会显示 connector 上报的本机 Codex sessions，并可以把未 attach 的 session attach 成一组 task/thread。
- Thread Command Centre 现在会从真实 thread list、Task Board card 或已 attach host session 进入。

## 决策
- 本切片里，task 是一个 thread 的视图；一组关联 threads 的 task 视图留给后续。
- Archive/unarchive 会同时更新 task 和它的 primary thread。
- Connector session inventory 只上报轻量 metadata：session id、title、title source、cwd 和更新时间。
- Title 解析优先使用 metadata 或 rollout title 字段，其次使用可选 app-server `Thread.name`，再其次使用本地 history，最后 fallback 到 cwd/session id。

## 验证目标
- Protocol 和 Worker tests 覆盖新的 host session realtime envelope，以及 task 必须有 thread id 的语义。
- Rust tests 覆盖 session title 优先级和本机 Codex metadata 扫描。
- Web typecheck 覆盖 Host Sessions、archive actions 和 selected-thread command submission。
- Commit 前跑现有 full build/test gate。

## 2026-06-12 Attach 后续
- 已部署的 Host Sessions 渲染正常，但当 API Access destination 没覆盖新的 `/api/host-sessions/*` 写路径时，attach 会返回 401。
- Worker 的 401 文案现在会说明可能缺少 Browser Access 覆盖，或 Access session 已过期。
- Web UI 现在会在可换行 alert 里显示服务端返回的 action error，并在每个 Host Sessions row 里显示完整 host `session_id`。
- 部署指南现在推荐用 `/api/*` 加 `/ws/browser` 覆盖 Browser API，同时把 connector bootstrap 放到 `/api/*` 之外。
- Agent bootstrap 已迁到 `/connector/bootstrap`，这样 `/api/*` 的 Browser Access 覆盖不会包住 connector bootstrap。Access 配好后，旧 `/api/agent/bootstrap` alias 已删除。
- Host Sessions 现在会把已归档 task/thread 的 attachment 从 active attached list 中隐藏；它们仍可从 Task Board archive 视图恢复。
- 历史 Host Session attachment 目前仍只导入 metadata/title。完整 transcript 或 rollout event backfill 留到后续切片。
- Codex exec 诊断现在会把缺少 Codex executable 和 workspace `cwd` 失败区分开；部署文档也建议 service-managed connector 使用绝对 `execution.codex_command`。
- Thread Centre 现在会把 bootstrap/polling payload 与本地 realtime state 合并，避免较旧 bootstrap snapshot 覆盖已经收到的 events。空 attached thread 会显示空 timeline，不再显示 placeholder lifecycle rows。
- Thread Centre 现在也提供和 Task Board 一致的 archive/unarchive 操作，用于当前选中的 task/thread。
- Host Sessions 现在有手动 refresh 按钮、`Last synced` timestamp 和 age 显示。Refresh 请求会让在线 connectors 立即重扫，然后重新读取 control-plane snapshot。
- Connector 现在会按 `session_inventory.report_interval_seconds` 周期性重扫本机 Codex sessions，并且周期路径只有在序列化后的 inventory 发生变化时才会上报。Worker 和 Web 现在会把每次 connector inventory 当成该 connector 范围内的 snapshot，避免已移除的本机 sessions 继续作为可 attach rows 残留。
- Connector session inventory 现在也会从 `history.jsonl` 创建轻量 entries，即使 session 还没有 `session_index` 或 rollout metadata；它会用 history `ts` 作为 session 更新时间，并用第一条 prompt 作为 title。

## 下一步
- 增加明确的新建 Codex thread 流程，让 Chaop 可以创建本机 Codex/app-server thread，而不只是 attach 已存在的 sessions。
