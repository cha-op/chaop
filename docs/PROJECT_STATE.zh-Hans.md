[ [British English](PROJECT_STATE.md) | 简体中文 ]

# 项目状态

## 当前状态
- 本仓库现在已有托管在 Cloudflare 上的 Codex 控制面的第一轮实现切片。
- 该切片包含共享协议类型、Worker 控制闭环、Lit GUI 骨架、Rust connector，以及初始 D1 migration 集合。
- Command lifecycle 现在可以写入 D1，通过 Durable Object dispatch，并把 connector lifecycle events 返回到 GUI bootstrap payload。
- Thread Command Centre 优先使用 WebSocket realtime updates；browser socket 不可用时 fallback 到 10 秒轮询。
- Task 现在必须有一个 primary thread，本机 Codex sessions 可以从 Host Sessions attach 成 task/thread pair。
- Rust connector 默认执行 placeholder，也可以通过私有 `execution.mode = "codex_exec"` 配置显式开启本机 Codex CLI execution。
- Rust connector 会上报轻量本机 Codex session inventory，可以可选使用 app-server `Thread.name` 做 title enrichment，并且在配置 `session_inventory.app_server_url` 后可以创建新的本机 app-server thread。
- 已 attach Host Sessions 现在会向 connector 请求单一 session 的有界 history backfill，导入简短 rollout/history 摘要，而不是上传宽泛 transcript。
- 当前工作流状态记录在 `docs/project_journal/2026/06/2026-06-11-task-thread-session-attach-d6e9f3.zh-Hans.md`。

## 恢复入口
- 设计来源：`docs/design-starter.zh-Hans.md`
- 计划来源：`docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.zh-Hans.md`
- Codex CLI 执行来源：`docs/project_journal/2026/06/2026-06-10-codex-cli-execution-b7f2c1.zh-Hans.md`
- Task/thread/session attach 来源：`docs/project_journal/2026/06/2026-06-11-task-thread-session-attach-d6e9f3.zh-Hans.md`
- 成本治理来源：`docs/cost-aware.zh-Hans.md`
- 本地索引：可生成 `docs/project_journal/INDEX.md`，但不要提交。

## 全局阻塞项
- Codex app-server execution、archive 同步和 R2 artefact capture 仍然放在后续切片。
- 部署实例值必须留在本仓库之外；tracked docs 保持通用模板，实例值保存在本地已忽略文件或私有部署仓库/subrepo。
