---
id: 20260615-f4c9a8-zh-Hans
title: App-server Attach Resume
status: completed
created: 2026-06-15
updated: 2026-06-16
branch: wip/app-server-attach-resume
pr: 18
supersedes:
superseded_by:
---

[ [British English](2026-06-15-app-server-attach-resume-f4c9a8.md) | 简体中文 ]

# App-server Attach Resume

## 摘要
- 当所选 connector 支持 managed app-server execution 时，attach 一个未被使用的本机 Codex session 现在会先通过 app-server resume。
- attach path 不再把 app-server-capable session 留在 D1-only 状态，从而导致 Thread Centre 只能回到 placeholder command。

## 当前状态
- Worker 会在 attach 前读取 Host Session。如果它还不是 app-server-backed，并且 connector 声明了 `host_session_app_server_ensure`，Worker 会先请求 Workspace Durable Object 通过 app-server ensure 这个 session。
- Durable Object 会把 `host_session.app_server_ensure` 发给目标 connector，并等待 `host_session.app_server_ensure_result`。
- Rust connector 会在 idle 和 active-turn background control paths 都处理这个请求，必要时先从 active 或 archived `thread/list` rows 解析真实 app-server `thread.id`，对 archived 命中先 unarchive，再调用 app-server `thread/resume` 并带上 `excludeTurns: true`，然后返回 `app_server_present` 的 Host Session；这个过程不会启动 turn。
- Worker 会先通过正常 inventory upsert path 写入返回的 Host Session，再创建 Chaop task/thread attachment，因此 Thread Centre 可以立即提供 managed app-server command path。
- 不支持专用 ensure capability 的 connector 会继续保持既有的 D1-only attach 行为，即使它支持较旧的 app-server command execution。
- Review follow-up 增加了 `host_session_app_server_ensure` 这个专用 capability，因此先部署 Worker、后重启旧 connector 时，attach 不会因为未知 control envelope 变成 15 秒 timeout。
- Review follow-up 也让显式 Host Session attach 在 app-server `thread/list` 解析耗尽有界 page budget 时直接失败，而不是 fallback 到本机 session id 并把它猜作 app-server `threadId`。
- 2026-06-16 的 regression follow-up 将 initialize、unarchive 和 resume 统一收敛到同一个本机 app-server deadline 内，把本机 read timeout 映射成清晰的 app-server method timeout，并且在 `thread/list` 找不到匹配 thread 时不再把本机 session id 猜作 `threadId`。
- 当 D1 已绑定但当前没有 usage windows 时，Budget summary 现在会返回 0 baseline，因此空闲部署里的 Cost posture 不会再把三个核心百分比全部显示为 missing。
- 限制：如果历史 rollout/session id 不在 app-server `thread/list` 中，在 Codex app-server protocol 提供正式的 resume-by-session-id 路径之前，Chaop 不会把它提升成 app-server-backed attachment。

## 验证
- `pnpm --filter @chaop/worker test`
- `cargo test -p chaop-agent`
- `cargo test -p chaop-agent session_inventory -- --nocapture`
- `pnpm --dir apps/web test`
- `pnpm --dir apps/worker test -- routes.test.ts`
- `pnpm test`
- `pnpm build`
- `git diff --check`

## 下一步
- 部署更新后的 Worker，并用重新构建的 agent 重启本机 connector，然后做 live E2E 验证。
