---
id: 20260611-d6e9f3-zh-Hans
title: Task Thread Session Attach 切片
status: active
created: 2026-06-11
updated: 2026-06-13
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
- Host Sessions 现在有明确的 detach API 和 UI action。Detach 只会清空 host session 的 attachment pointers，并保留 task/thread 历史，所以可以完整测试 archive 和 restore，而不会删除已经创建的 task。

## 2026-06-12 Review 加固
- D1 `0003` migration 现在会在重建 `tasks` 时保留已有 `commands.task_id` 关联；直接 SQLite migration check 已确认 migration 后 command 仍指向原 task。
- D1 schema 和 `0005` 兼容 migration 现在允许独立的 `failed` task state，并且会为已经迁移过的部署保留 command/task 与 host-session/task 关联。
- Thread event sequence 现在通过原子 `UPDATE threads ... RETURNING last_seq` 分配，降低同一 thread 并发 event 撞号的风险。
- Durable Object 现在只会在同一 connector 的最后一个 socket 断开后才把 connector 标记为 offline，然后失败 leased/running commands、更新对应 task state，并向 Browser sockets 广播失败事件。
- Rust connector 在等待 event ACK 时会 defer 非 ACK WebSocket messages，因此排队的 `command.dispatch` 会在当前 command 完成后继续处理，不会被吞掉。
- Session inventory 的 rollout 扫描现在会先限制到最近日期目录和有上限的 rollout 文件集合，再读取 rollout metadata。
- Browser command creation 在非本地 insecure dev 环境必须有 D1 binding；写入前会校验 workspace/thread/task ids 的归属一致性，并且等到 `command.started` 后才把 task 移到 `running`。
- `command.failed` 现在会映射成 Task Board 可见的 `failed` task state，不再在 Worker、protocol grouping 或 UI 中折叠成 `done`。
- Connector bootstrap 现在会对同一 name/hostname 使用稳定 connector identity；有效的 offline connector token 可以重连并把自身标回 online；旧重复 connector rows 会通过 disconnect cleanup 路径 retire，并迁移 host-session attachments。
- Web bootstrap 成功重新加载后，现在会清理旧的全屏 `loadError`。
- Host session inventory reports 现在被当作有上限的 top-N updates，而不是完整 snapshots：Worker 不再因为 partial report 缺少某个 session 就删除旧 row；realtime Browser update 也不会清空同 connector 的本地 session list。这样可以保留最新 report 窗口之外已有的 attachments。
- Browser bootstrap merge 现在也遵循同样的 partial-inventory 契约，会保留 newer top-N payload 中缺失的当前 host sessions。Worker bootstrap list 会优先返回 attached host sessions，再返回未 attached 的近期 sessions，避免已绑定 task/thread 的 rows 被 200 条 payload 上限挤掉。
- Connector `codex_exec` 现在会把等待 Codex CLI 的部分放到后台 worker，同时 WebSocket loop 继续响应 pings、close frames 和 Host Sessions refresh；其它消息仍会 defer 到当前 command 完成后处理。
- Connector `codex_exec` 现在会把取消信号传给 Codex CLI worker，并在 socket close 或 read error 时 join 这个 worker，因此 stale child process 会被 kill，而不是在服务端已经把 command 标记失败后继续跑到 timeout。
- Continuous connector mode 现在会在 socket close 或非 timeout read error 后用短 backoff 重连；`--run-once` 仍保持处理一个 command 后返回的行为。
- Browser command request validation 现在会在写入 DB 前拒绝 thread、task 和 target connector 字段里的空字符串 optional ids。
- Session inventory 现在会从 `session_index.jsonl` 和 `history.jsonl` 读取有上限的近期 tail，不再每次扫描都把完整文件读入内存。默认周期扫描间隔现在是 60 秒；Host Sessions 的手动 refresh 仍会请求在线 connectors 立即重扫。

## 2026-06-13 本机 Thread 创建
- Chaop 现在有 Browser API，可以通过声明了 `app_server_threads` 的在线 connector 创建新的本机 Codex app-server thread。
- `WorkspaceDO` 现在在已有 agent WebSocket 上支持有界 request/response RPC：Worker 发送 `thread.create`，connector 回复 `thread.create_result`；创建失败时，API 会返回清晰的 timeout 或 connector 错误。
- Rust connector 现在会使用 `session_inventory.app_server_url` 调用 app-server `thread/start`，再用 `thread/name/set` 写入请求的 title，并把创建出的 session 作为轻量 host-session metadata 回传。
- Worker 的 D1 helper 会 upsert 创建出的 app-server session，并复用已有 attach 流程，所以新 session 会立即变成 task/thread 组合。
- Task Board 和 Thread Command Centre 现在提供聚焦的 `New local thread` 表单；创建成功后会直接打开真实 thread。
- 部署指南现在记录了本地 `codex app-server --experimental --listen ws://127.0.0.1:9876` 前提，以及私有 connector `app_server_url` 配置。

## 下一步
- 新建 thread 跑通后，再做旧 session history backfill，让 attach 的旧 sessions 可以显示有用的历史 output，同时默认不上传宽泛的本机 transcripts。
- History backfill 之后，再通过 connector 把 Chaop archive/unarchive 同步到本机 Codex app-server archive 状态。本机 history 文件保持只读。
- 在 app-server protocol path 可以干净覆盖 create、resume、archive 和 event/history reads 之前，Codex CLI adapter 继续作为当前可用的 execution fallback。
- R2 artefact capture 和 budget aggregation 排在这些核心控制闭环工作之后。
