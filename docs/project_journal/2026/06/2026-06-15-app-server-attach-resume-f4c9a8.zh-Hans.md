---
id: 20260615-f4c9a8-zh-Hans
title: App-server 附加与恢复
status: completed
created: 2026-06-15
updated: 2026-06-23
branch: wip/app-server-attach-resume
pr: 18
supersedes:
superseded_by:
---

[ [British English](2026-06-15-app-server-attach-resume-f4c9a8.md) | 简体中文 ]

# App-server 附加与恢复

## 摘要
- 当所选 connector 支持 managed app-server execution 时，attach 一个未被使用的本机 Codex session 现在会先通过 app-server resume。
- attach path 不再把 app-server-capable session 留在 D1-only 状态，从而导致 Thread Centre 只能回到 placeholder command。

## 当前状态
- Worker 会在 attach 前读取 Host Session。如果它还不是 live-attached，并且 connector 声明了 `host_session_app_server_ensure`，Worker 会先请求 Workspace Durable Object 通过 app-server ensure 这个 session；即使存储行已经标记 `app_server_present` 也会重新 ensure。
- Durable Object 会把 `host_session.app_server_ensure` 发给目标 connector，并等待 `host_session.app_server_ensure_result`。
- Rust connector 会在 idle 和 active-turn background control paths 都处理这个请求，必要时先从 active 或 archived `thread/list` rows 解析真实 app-server `thread.id`，对 archived 命中先 unarchive，再调用 app-server `thread/resume` 并带上 `excludeTurns: true`，然后返回 `app_server_present` 的 Host Session；这个过程不会启动 turn。
- Worker 会先通过正常 inventory upsert path 写入返回的 Host Session，再创建 Chaop task/thread attachment，因此 Thread Centre 可以立即提供 managed app-server command path。
- 不支持专用 ensure capability 的 connector 会继续保持既有的 D1-only attach 行为，即使它支持较旧的 app-server command execution。
- Review follow-up 增加了 `host_session_app_server_ensure` 这个专用 capability，因此先部署 Worker、后重启旧 connector 时，attach 不会因为未知 control envelope 变成 15 秒 timeout。
- Review follow-up 也让显式 Host Session attach 在 app-server `thread/list` 解析耗尽有界 page budget 时直接失败，而不是 fallback 到本机 session id 并把它猜作 app-server `threadId`。
- 2026-06-16 的 regression follow-up 将 initialize、unarchive 和 resume 统一收敛到同一个本机 app-server deadline 内，把本机 read timeout 映射成清晰的 app-server method timeout，并且在 `thread/list` 找不到匹配 thread 时不再把本机 session id 猜作 `threadId`。
- 当历史 rollout/session id 不在 app-server `thread/list` 中时，connector 现在会从 Codex history 解析本机 rollout 文件路径，并用这个 path 调用 app-server `thread/resume`，而不是猜测 `threadId`。
- Managed app-server command execution 在 active `thread/list` miss 后也会使用同一个 rollout path fallback，然后用 app-server resume 返回的真实 `thread.id` 启动 turn。
- Review follow-up 会让后续 app-server `turn/start` 使用 rollout-path resume 解析出的 cwd 或 app-server resume 返回的 cwd，而不是回到可能已经 stale 的 attached cwd。
- Archive/unarchive sync 在 source 和 target `thread/list` 都 miss 后也会使用 rollout path resume，然后对 resume 返回的真实 app-server `thread.id` 执行 archive/unarchive。
- Review follow-up 会拒绝 session id 不匹配的 app-server ensure response，path-based attach 和 command resume 会使用 rollout 里的 cwd，并且 page-budgeted `thread/list` miss 后会继续尝试 rollout resume。
- Review follow-up 也会在返回 ensured Host Session 前校验 app-server `thread/resume` response 的 session id，避免 stale 或异常 app-server response 把错误的本机 session attach 进来。
- Review follow-up 还会在 active inventory 把 `app_server_present` 降级后，继续保留 app-server lineage session 的 archive/unarchive sync，因此已归档的 app-server thread 可以通过 connector 重新 unarchive 回本机。
- unarchive sync 成功后，如果 active-only inventory 曾经把 attached Host Session 的 D1 `app_server_present` 标记降级，会把它恢复为 true，因此下一条 managed app-server command 会被接受。
- Review follow-up 会在 `agent.ready` 后、pending command dispatch 前请求一次带 debounce 的 Host Sessions refresh，因此新创建的本机 sessions 不需要恢复高频 connector inventory polling 也能变得可见。
- 当 D1 当前没有 usage windows 时，Budget summary 会把核心百分比保持为 `missing`，避免用误导性的 0 baseline 表示未知用量。

## 验证
- `pnpm --filter @chaop/worker test`
- `cargo test -p chaop-agent`
- `cargo test -p chaop-agent session_inventory -- --nocapture`
- `cargo test -p chaop-agent ensure_host_session_rejects_mismatched_resume_session_id -- --test-threads=1`
- `cargo test -p chaop-agent app_server_command_resumes_unlisted_session_from_rollout_path -- --test-threads=1`
- `pnpm --dir apps/web test`
- `pnpm --dir apps/worker test -- routes.test.ts`
- `pnpm test`
- `pnpm build`
- `git diff --check`

## 下一步
- 部署更新后的 Worker，并用重新构建的 agent 重启本机 connector，然后做 live E2E 验证。
