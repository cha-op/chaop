---
id: 20260613-e4a7c9-zh-Hans
title: App-server 执行切片
status: completed
created: 2026-06-13
updated: 2026-06-13
branch: wip/app-server-command-execution
pr: https://github.com/cha-op/chaop/pull/5
supersedes:
  - 20260610-b7f2c1
superseded_by:
---

[ [British English](2026-06-13-app-server-execution-e4a7c9.md) | 简体中文 ]

# App-server 执行切片

## 摘要
- 本切片为 Chaop commands 增加真实 Codex app-server execution path。
- 该路径通过私有 connector 配置显式开启：`execution.mode = "app_server"` 加 `session_inventory.app_server_url`。
- CLI adapter 仍保留为 `execution.mode = "codex_exec"`，用于 fallback 和对照。

## 决策
- App-server command 只运行在已经 attach 到本机 app-server Host Session 的 Chaop thread 或 task 上。
- 保持现有 `codex` command type 兼容；Worker 现在会在 `command.dispatch` 中带上已 attach 的本机 session target。
- 执行前先把保存的 app-server `sessionId` 解析成当前 app-server `Thread.id`，再调用 `thread/resume` 和 `turn/start`。
- 只从 app-server turn 返回简短 Chaop lifecycle events 和最终 assistant message 摘要，不上传本机 command output、transcript 或 artefact data。

## 实现记录
- Protocol 增加 `CommandTargetHostSession` 和可选 `CommandDispatch.target_host_session`。
- Worker command lease 会关联已 attach 的 `host_sessions`，因此 Durable Object 可以把本机 session target dispatch 给 connector。
- Command creation 现在会优先选择所选 thread/task 已 attach Host Session 的 owning connector，而不是 workspace 里任意最近在线的 connector。
- 已 attach 的 app-server commands 要求 owning connector 声明 `codex_app_server_exec`；Worker creation/leasing 和 Rust connector 都会拒绝 fallback 到普通 `codex_exec`。
- Connector config 增加 `execution.mode = "app_server"`；只有同时配置 `session_inventory.app_server_url` 时才会声明 `codex_app_server_exec`，且不会同时声明只适用于 CLI 的 `codex_exec` capability。
- Rust connector 会把 app-server command 放到后台 worker 中运行，主 control WebSocket 仍继续响应 ping、关闭和 background control messages。
- App-server execution path 同时处理同步终态 `turn/start` response 和异步 `turn/completed` notification。
- App-server `thread/resume` 和 `turn/start` 会使用已 attach session 的 cwd；只有当 attached cwd 缺失或不是绝对路径时，才 fallback 到 connector `workspace_root`。
- Command session 解析会在 command timeout 预算内扫描 app-server `thread/list` 分页，不再复用 archive sync 的分页预算。
- 如果 connector 被取消或 command 超时，且已经知道 turn id，或还能从 `turn/start` response 里恢复 turn id，会 best-effort 发送 app-server `turn/interrupt`。
- App-server `commandExecution` output 默认不会转换成 Chaop command events。
- PR readiness review 发现并修复了一个 dispatch 一致性问题：command creation 选择最新 attached Host Session，但 command lease 可能 join 到旧的重复 attachment row；现在 lease 使用同一套 task-first、latest-updated Host Session 选择规则。
- PR readiness review 也让 command lease 与 command creation 在 task command 上保持一致：当 thread 已 attach 但 task attachment 缺失时，lease 会在确认不存在 task-attached Host Session 后 fallback 到 thread attachment。
- Offline frozen-diff review 发现并修复了 pending command 与 detach 的 race；detaching 一个 app-server Host Session 时，如果 pending 或 expired-leased Codex command 已经找不到任何可替代 app-server attachment，会直接标记 failed，而不是永久停在 pending。
- Final PR readiness review 进一步收紧了 detach cleanup：只有同一个 target connector 拥有的 replacement app-server Host Session 才能保留 pending command。
- Final offline review 发现 app-server command startup 在找到 session match 后仍继续翻页；现在 command resolver 会在找到目标 app-server session 后立即返回。

## 验证目标
- Worker tests 覆盖 command dispatch 的 target host-session mapping。
- Worker tests 断言 command lease 只 join 最新的 task-first attached Host Session。
- Worker tests 断言 command lease 保留 task-first、thread-fallback 的 attachment selection SQL。
- Worker route tests 覆盖 app-server Host Session detach 会让依赖该 attachment 的 pending Codex command 失败。
- Worker route tests 断言 detached-command replacement matching 会限定在 command target connector 内。
- Rust tests 覆盖 app-server session 解析、深分页扫描、`thread/resume`、`turn/start`、终态 turn 处理、completion notification、取消 interrupt 和 command output 省略。
- Rust tests 断言 app-server command session resolution 找到目标 session 后会停止翻页。
- Rust tests 覆盖 connector 还没读取 turn id 时的 `turn/start` 取消窗口。
- 合并前跑完整 `pnpm test`、Rust workspace tests、build、journal validation 和 PR readiness review。

## 后续事项
- R2 artefact capture 仍留到后续切片。
- Command lifecycle summary 之外的 budget aggregation 仍是后续工作。
