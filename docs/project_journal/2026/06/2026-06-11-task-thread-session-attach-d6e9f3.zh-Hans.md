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
- Agent bootstrap 会迁到 `/connector/bootstrap`，这样 `/api/*` 的 Browser Access 覆盖不会包住 connector bootstrap。`/api/agent/bootstrap` 只保留为迁移期 legacy alias。

## 下一步
- Cloudflare Access destination 覆盖 `/api/*`、`/ws/browser` 和 GUI hostname 后，重新测试 attach。
