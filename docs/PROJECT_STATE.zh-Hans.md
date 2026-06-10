[ [British English](PROJECT_STATE.md) | 简体中文 ]

# 项目状态

## 当前状态
- 本仓库现在已有托管在 Cloudflare 上的 Codex app-server 控制面的第一轮实现切片。
- 该切片包含共享协议类型、Worker 控制闭环、Lit GUI 骨架、Rust placeholder connector，以及初始 D1 migration 集合。
- Placeholder command lifecycle 现在可以写入 D1，通过 Durable Object dispatch，并把 connector lifecycle events 返回到 GUI bootstrap payload。
- 当前工作流状态记录在 `docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.md`。

## 恢复入口
- 设计来源：`docs/design-starter.zh-Hans.md`
- 成本治理来源：`docs/cost-aware.zh-Hans.md`
- 本地索引：可生成 `docs/project_journal/INDEX.md`，但不要提交。

## 全局阻塞项
- 当前 connector 仍然只执行 placeholder；真实 Codex app-server execution 会放在后续切片。
- 部署实例值必须留在本仓库之外；tracked docs 保持通用模板，实例值保存在本地已忽略文件或私有部署仓库/subrepo。
