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
- Final independent review 发现并修复了 lease-before-dispatch detach window；detaching app-server Host Session 现在会同时失败依赖该 attachment 的 pending 和 leased-but-not-running Codex commands。
- Final frozen-diff review 发现仍有 detach/dispatch acknowledgement race；Worker command-event acknowledgement 现在会带 `accepted`，Rust connector 在 `command.started` 因 stale 被拒绝时会中止本地执行。
- Detached-command replacement matching 现在只让外层 replacement 限定在 command target connector，同时沿用 command leasing 的 connector-agnostic task-first existence check，所以 cross-connector task attachment 不会错误允许 thread fallback。
- Independent PR review 发现 detach ordering race；detach 现在会先清空 Host Session attachment，再按照保存的旧 attachment 失败依赖它的 commands，所以并发 command creation 不会再选中正在 detach 的 session。
- Independent PR review 发现 stale `command.started` race 仍可能在 cleanup 选中 leased command 后抢先成功。现在 app-server-only connector 的 start 会在接受 `command.started` 前重新验证当前 task/thread Host Session target。
- Detached-command cleanup 也会覆盖 `target_connector_id IS NULL` 的 legacy 或 delayed app-server commands，同时保留 command leasing 可选择的任意当前 app-server Host Session replacement。
- Independent PR review 发现还存在 create/detach 跨请求 race：command creation 可能先读到旧 app-server attachment，然后在 detach cleanup 扫描 commands 之后才 insert。现在 app-server Codex command creation 使用 guarded insert，只有按同一套 task-first/latest ordering 选出的当前 task/thread Host Session 仍解析到同一个 app-server target 时才会写入 command。
- Independent PR review 发现 reattach-after-dispatch race：同一个 connector 可能先收到指向某个 app-server Host Session 的 command，随后又把另一个 Host Session attach 到同一 task/thread，最后才发送 `command.started`。现在 app-server `command.started` event 会带 `target_host_session_id`，Worker acknowledgement 只有在该 session 仍匹配当前 task/thread target 时才会接受 start。
- 后续 independent review 发现 `command.started` Host Session identity check 与 command state update 之间仍有 TOCTOU window。现在 Worker 会把当前 Host Session target check 合并进同一条 guarded `UPDATE commands ... WHERE ... EXISTS (...)`，只有该 update 仍能解析到 event `target_host_session_id` 时才把 command 置为 `running`。
- Detached-command replacement matching 现在也要求 replacement connector 可执行、在线，并声明 `codex_app_server_exec`，所以 cleanup 不会被 command leasing 实际无法 dispatch 的 attached Host Session 错误压制。
- Independent review 发现外部注册的 connector 如果同时声明 `codex_exec` 和 `codex_app_server_exec`，仍可能跳过 `command.started` Host Session revalidation。现在 Worker 会在 command lease 时保存本次选中的 app-server Host Session id，并要求该 leased target 的 started event 回传同一个 target，之后 guarded state update 才能执行。
- 后续 review 发现这个修复里的 guarded update 仍需要比较 event target 与 lease-time target，而不只是比较当前 attachment。现在 guarded `command.started` update 会在同一条 SQL 中同时检查 `lease_target_host_session_id` 是否等于 event target。
- Independent review 发现没有 app-server lease target 的普通 Codex lease 仍可能接受带 target 的 `command.started` event，因为 guarded SQL 把 `NULL` lease target 当成 permissive。现在 guarded update 要求 lease-time app-server target 非空，且必须等于 event target。
- Independent review 发现 detach cleanup 可能失败由其他 connector 租走、且并不依赖被 detach app-server Host Session 的 nullable-target leased command。现在 leased cleanup 分支要求 lease-time Host Session target 匹配，或在 legacy null lease target 情况下要求 lease owner 就是被 detach 的 connector。
- 后续 independent review 发现 detach cleanup 的 replacement suppression 仍使用任意匹配且可 lease 的 Host Session，而不是 command leasing 实际会选择的 task-first/latest Host Session。现在 detached-command cleanup 会先使用同一套标量 Host Session target selection，再检查 app-server execution eligibility。
- 后续 independent review 发现 stale app-server `command.started` 被拒后，command 可能继续停在 leased，直到未来出现无关触发。现在 rejected targeted start 会把 app-server lease 释放回 pending，Durable Object 随即对所有可用 agent sockets 触发 pending command dispatch。
- 后续 frozen-diff review 发现 detach cleanup 仍从 task/thread scope 推断 pending command 是否依赖该 session，可能误失败在 Host Session attach 前创建的普通 pending `codex_exec` command。现在 app-server command creation 会持久化 intended Host Session id，detach cleanup 只会失败 stored app-server target 匹配被 detach session 的 pending command。
- Codex review-gate 在合并前发现剩余 hardening gaps：app-server assistant deltas 现在会按 `codex_output_max_bytes` 限制本地累计；detach cleanup 的 guarded failure update 会重新验证 replacement Host Session；leased detach cleanup 会刷新 connector activity count；pending-command Host Session selection 不再在 subquery `ORDER BY` 中使用 SQLite 不接受的 outer reference；cost guide 也改成可直接复制的两个独立 TOML mode snippets。
- 后续 independent review 发现 detach cleanup 的 `SELECT` 与 failure `UPDATE` 之间仍可能发生 command 被重新 lease 或 retarget 的 race。现在 guarded failure update 会在写入 task/event side effects 前重新验证 command workspace、type、target connector、scope、lease ownership，以及当前 replacement Host Session selection。
- 后续 frozen-diff review 发现 rejected stale app-server start 释放 lease fields 后，仍会保留 command creation 时写入的 stale implicit `target_connector_id`。现在释放该 stale app-server lease 时只会清空 attached-session 推导出的 target，所以立即 re-dispatch 可以按当前 attachment 重新选择 connector，同时显式指定 target 的 command 不会漂移到其他 connector。
- 后续 independent review 发现 guarded detach failure update 把 `lease_target_host_session_id` 与内部 `host_sessions.id` 比较，而 command 中保存的是 app-server session id。现在 guarded update 用 `hostSession.session_id` 做 lease-target matching，只在 replacement selection 排除被 detach row 时使用 `hostSession.id`。
- Codex review-gate 又发现一个 stale-start release race：rejected app-server `command.started` acknowledgement 现在只有在当前 task/thread target 能解析到可执行的 replacement app-server Host Session 时，才会 release 回 pending。若没有 replacement，command 会保持 app-server scope，交给 detach cleanup 失败处理，而不会变成 generic `codex_exec` command。
- 后续 frozen-diff review 发现 stale-start release 即使在 command target 来自 attached session 推导时，仍会把 replacement Host Session 限定在旧 connector 上。现在 rejected start 只有在 target 来源是 `attached` 推导时才允许跨 connector replacement；显式指定的 target 仍固定在用户请求的 connector 上。
- 后续 review 又发现两个残留的卡死或漂移路径：expired app-server lease 可能 fallback 到 `codex_exec`，显式 app-server target 在 attachment 被其他 connector 接管后也可能长期保持 leased。现在 pending dispatch 的 CLI 分支会排除非空 app-server lease target；显式 target 的 rejected app-server start 会直接把 command 标记为 failed，而不是漂移或继续 leased。
- Final PR readiness reviews 发现 cross-connector replacement 在 replacement app-server Host Session 复用同一个 app-server session id 时仍会失败，且 detach cleanup 仍可能把 attached-inferred commands 标记 failed，而不是交给有效 replacement 继续 dispatch。现在 stale-start release 只排除旧的 connector/session 组合；detach cleanup 会 source-aware 地先把 attachment-inferred commands release 回 pending，再执行 failure cleanup。
- Final independent review 发现 detach cleanup 仍可能 release 或 fail 一个已被 replacement connector 租走、但复用同一个 app-server session id 的 command。现在 detach cleanup 只有在 leased command owner 是被 detach 的 connector 时，才会执行 release 或 failure handling。

## 验证目标
- Worker tests 覆盖 command dispatch 的 target host-session mapping。
- Worker tests 断言 command lease 只 join 最新的 task-first attached Host Session。
- Worker tests 断言 command lease 保留 task-first、thread-fallback 的 attachment selection SQL。
- Worker route tests 覆盖 app-server Host Session detach 会让依赖该 attachment 的 pending Codex command 失败。
- Worker route tests 断言 detached-command replacement matching 会限定在 command target connector 内。
- Worker route tests 断言 detached-command replacement matching 要求 executable online app-server connector capability，并使用与 command leasing 相同的 task-first blocking rule。
- Worker route tests 断言 detached-command cleanup 会立即覆盖 leased commands，而不是等 lease expiry。
- Worker route tests 断言 Host Session detach 会先清空 attachment，然后才执行 command cleanup query。
- Worker Durable Object tests 断言 stale agent command events 会收到带 `accepted: false` 的 `server.ack`。
- Worker tests 断言 app-server-leased `command.started` event 如果缺少 leased target session id 会被拒绝，同时没有 app-server lease target 的普通 Codex start 仍会被接受。
- Worker tests 断言 app-server-leased `command.started` event 即使 event target 匹配当前 attachment，只要它不同于 lease-time target，也会被拒绝。
- Worker tests 断言普通 Codex lease 即使当前 attachment 匹配 event target，也会拒绝带 app-server target 的 `command.started` event。
- Worker route tests 断言 Host Session detach 不会失败由其他 connector 租走的 nullable-target leased command。
- Worker route tests 断言 detach cleanup 的 replacement suppression 使用与 command leasing 相同的标量 task-first/latest Host Session target selection。
- Worker route tests 断言 app-server command creation 会持久化 intended Host Session target id，且 detach cleanup 只匹配带有该显式 target 的 pending command。
- Worker DB tests 断言 rejected stale app-server `command.started` events 会释放 app-server lease，以便立即 re-dispatch。
- Worker Durable Object tests 断言 rejected targeted app-server starts 会对所有可用 agent sockets 触发 pending command dispatch。
- Worker DB tests 断言当前 Host Session attachment 消失后，app-server-only `command.started` events 会被拒绝。
- Worker DB tests 断言同一个 connector 把另一个 Host Session reattach 到 command scope 后，app-server-only `command.started` events 会被拒绝。
- Worker DB tests 断言 app-server-only `command.started` events 只有在 guarded command-state update 仍能把当前 target Host Session 解析到 event `target_host_session_id` 时才会被接受。
- Worker route tests 断言当 attached Host Session 在 command insert 前变化时，app-server command creation 会返回 `409 Conflict`。
- Worker DB tests 断言 pending command dispatch 使用 SQLite-compatible task-first Host Session selection，不再依赖 outer-reference `ORDER BY`。
- Worker route tests 断言 Host Session detach 在失败 leased command 后会刷新 connector activity。
- Worker route tests 断言当 guarded command failure update 在 race 中失效时，Host Session detach 不会继续写 task、event 或 connector activity side effects。
- Worker DB 与 Durable Object tests 断言 rejected stale app-server start 在释放 app-server lease 以便立即 re-dispatch 时，只会清空 attached-session 推导出的 stale target connector。
- Worker DB tests 断言 stale app-server start 被拒后仍会保留显式 command target，避免用户指定的 target connector 漂移到其他 host。
- Worker route tests 断言 guarded detach failure update 会为 `lease_target_host_session_id` 绑定已存的 app-server session id，而不是内部 Host Session row id。
- Worker DB tests 断言 rejected stale app-server start 在旧 app-server Host Session 已 detach 且没有可执行 replacement 时，不会释放 lease。
- Worker Durable Object tests 断言当 replacement app-server Host Session 可用时，rejected targeted app-server start 仍会 release 并重新 dispatch。
- Worker DB tests 断言 attached-session 推导出的 target 可以把 stale app-server start release 到 replacement connector。
- Worker DB tests 断言显式指定的 app-server target 如果 attachment 已移动到另一个 connector，会失败 command，而不是 release 到那个 connector。
- Worker DB tests 断言带有已保存 app-server target 的 expired app-server lease 不会降级到 `codex_exec` dispatch branch。
- Worker DB tests 断言 attached-inferred stale app-server start 即使 replacement 回报相同 app-server session id，也会 release 到 replacement connector。
- Worker route tests 断言当 replacement app-server Host Session 存在时，Host Session detach 会 source-aware 地 release attached-inferred commands，而不会写 failed task/event side effects。
- Worker route tests 断言 Host Session detach 不会 release 或 fail 由 replacement connector 拥有的同 app-server session id lease。
- Rust tests 覆盖 app-server session 解析、深分页扫描、`thread/resume`、`turn/start`、终态 turn 处理、completion notification、取消 interrupt 和 command output 省略。
- Rust tests 断言 app-server assistant-message delta 本地累计会遵守配置的 byte cap，且不会截断出非法 UTF-8。
- Rust tests 断言 app-server command session resolution 找到目标 session 后会停止翻页。
- Rust tests 断言 rejected command-event acknowledgements 会被识别，不会被当作 successful ack。
- Rust tests 断言 app-server `command.started` event payload 会标识目标 Host Session，且不会把该字段带到非 started events 上。
- Rust tests 覆盖 connector 还没读取 turn id 时的 `turn/start` 取消窗口。
- 合并前跑完整 `pnpm test`、Rust workspace tests、build、journal validation 和 PR readiness review。

## 后续事项
- R2 artefact capture 仍留到后续切片。
- Command lifecycle summary 之外的 budget aggregation 仍是后续工作。
