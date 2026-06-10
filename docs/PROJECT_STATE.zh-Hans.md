[ [British English](PROJECT_STATE.md) | 简体中文 ]

# 项目状态

## 当前状态
- 本仓库现在已有托管在 Cloudflare 上的 Codex app-server 控制面的第一轮实现切片。
- 该切片包含共享协议类型、Worker 骨架、Lit GUI 骨架、Rust placeholder connector，以及初始 D1 migration 集合。
- 当前工作流状态记录在 `docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.md`。

## 恢复入口
- 设计来源：`docs/design-starter.zh-Hans.md`
- 成本治理来源：`docs/cost-aware.zh-Hans.md`
- 本地索引：可生成 `docs/project_journal/INDEX.md`，但不要提交。

## 全局阻塞项
- 在真实部署切片运行前，需要先提供 Cloudflare 账号、Access、域名和密钥配置。
