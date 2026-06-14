[ [British English](PROJECT_STATE.md) | 简体中文 ]

# 项目状态

## 当前状态
- 本仓库现在已有托管在 Cloudflare 上的 Codex 控制面的第一轮实现切片。
- 该切片包含共享协议类型、Worker 控制闭环、Lit GUI 骨架、Rust connector，以及初始 D1 migration 集合。
- Command lifecycle 现在可以写入 D1，通过 Durable Object dispatch，并把 connector lifecycle events 返回到 GUI bootstrap payload。
- Thread Command Centre 优先使用 WebSocket realtime updates；browser socket 不可用时 fallback 到 10 秒轮询。
- Task 现在必须有一个 primary thread，本机 Codex sessions 可以从 Host Sessions attach 成 task/thread pair。
- Rust connector 默认执行 placeholder，也可以通过私有 `execution.mode = "codex_exec"` 配置显式开启本机 Codex CLI execution，或通过私有 `execution.mode = "app_server"` 加 `session_inventory.app_server_url` 对已 attach thread 执行 Codex app-server command。
- Thread Command Centre 现在把显示用 execution modes 和 protocol command types 分开：managed app-server execution 会作为产品路径显示，Codex CLI fallback 默认隐藏，除非 Web build 显式开启。
- Thread Command Centre 现在会在所选 thread 有已 attach 的 app-server Host Session 时，把隐式 command submission 默认切到 managed app-server execution；Worker 也会为该目标推断 `execution_mode = "app_server"`，并拒绝可能意外落到 `codex_exec` 的裸 `codex` 请求。
- Rust connector 会上报轻量本机 Codex session inventory，可以可选使用 app-server `Thread.name` 做 title enrichment，并且在配置 `session_inventory.app_server_url` 后可以创建新的本机 app-server thread。
- Rust connector 现在可以管理一个专用的本机 Codex app-server listener，在声明 app-server capabilities 前先做健康检查，并通过 `agent.ready` 刷新 connector capabilities。
- Operations Map 和 Host Sessions 现在会展示 AppServerInstance state，包括 connector identity、endpoint type、active turns、changed/seen age，以及不健康 lifecycle states。
- 已 attach Host Sessions 现在会向 connector 请求单一 session 的有界 history backfill，导入简短 rollout/history 摘要，而不是上传宽泛 transcript。
- 已 attach Host Session tasks 的 archive/unarchive 操作现在会先更新 Chaop 的 D1 task/thread 状态，再尝试通过 connector 把可解析的 Codex app-server thread 同步到 `thread/archive` 和 `thread/unarchive` 状态；同步失败会作为 warning 回传，非 app-server sessions 仍然只改 D1。
- 下一轮交付工作流是九个 PR 的 app-server lifecycle roadmap，从 PR0 的 Web deploy script 开始，再把 execution UX 逐步迁移到 managed app-server operation。
- 当前工作流状态记录在 `docs/project_journal/2026/06/2026-06-14-app-server-lifecycle-roadmap-9c3b2d.zh-Hans.md`。

## 恢复入口
- 设计来源：`docs/design-starter.zh-Hans.md`
- 计划来源：`docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.zh-Hans.md`
- Codex CLI 执行来源：`docs/project_journal/2026/06/2026-06-10-codex-cli-execution-b7f2c1.zh-Hans.md`
- Task/thread/session attach 来源：`docs/project_journal/2026/06/2026-06-11-task-thread-session-attach-d6e9f3.zh-Hans.md`
- App-server execution 来源：`docs/project_journal/2026/06/2026-06-13-app-server-execution-e4a7c9.zh-Hans.md`
- App-server lifecycle roadmap 来源：`docs/project_journal/2026/06/2026-06-14-app-server-lifecycle-roadmap-9c3b2d.zh-Hans.md`
- Execution UX cleanup 来源：`docs/project_journal/2026/06/2026-06-14-execution-ux-capabilities-2b7d4e.zh-Hans.md`
- Connector-managed app-server 来源：`docs/project_journal/2026/06/2026-06-14-connector-managed-app-server-7a8e1f.zh-Hans.md`
- AppServerInstance UI 来源：`docs/project_journal/2026/06/2026-06-14-app-server-instance-ui-4b6d91.zh-Hans.md`
- 默认 app-server command path 来源：`docs/project_journal/2026/06/2026-06-14-default-app-server-command-path-a5d8c0.zh-Hans.md`
- 成本治理来源：`docs/cost-aware.zh-Hans.md`
- 本地索引：可生成 `docs/project_journal/INDEX.md`，但不要提交。

## 全局阻塞项
- R2 artefact capture 仍然放在后续切片。
- 部署实例值必须留在本仓库之外；tracked docs 保持通用模板，实例值保存在本地已忽略文件或私有部署仓库/subrepo。
