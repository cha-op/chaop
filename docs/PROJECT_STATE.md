# Project State [ British English | 简体中文 ]

## Current State [ British English ]
- The repository now has a first implementation slice for a Cloudflare-hosted Codex app-server control plane.
- The slice includes shared protocol types, a Worker skeleton, a Lit GUI skeleton, a Rust placeholder connector, and the initial D1 migration.
- Active workstream state lives in `docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.md`.

## 当前状态 [ 简体中文 ]
- 本仓库现在已有托管在 Cloudflare 上的 Codex app-server 控制面的第一轮实现切片。
- 该切片包含共享协议类型、Worker 骨架、Lit GUI 骨架、Rust placeholder connector，以及初始 D1 migration。
- 当前工作流状态记录在 `docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.md`。

## Recovery Pointers [ British English ]
- Design source: `docs/design-starter.md`
- Cost-aware source: `docs/cost-aware.md`
- Local journal index: optional generated `docs/project_journal/INDEX.md`; do not commit it.

## 恢复入口 [ 简体中文 ]
- 设计来源：`docs/design-starter.md`
- 成本治理来源：`docs/cost-aware.md`
- 本地索引：可生成 `docs/project_journal/INDEX.md`，但不要提交。

## Global Blockers [ British English ]
- Cloudflare account, Access, domain, and secret configuration must be supplied before a real deployment slice can run.

## 全局阻塞项 [ 简体中文 ]
- 在真实部署切片运行前，需要先提供 Cloudflare 账号、Access、域名和密钥配置。
