[ [British English](README.md) | 简体中文 ]

# Chaop 控制面

Chaop 是一个 Cloudflare-first 控制面原型，用于协调多台机器上的本地 Codex app-server 工作。

当前切片：

- Lit/Vite 浏览器 GUI，包含 Operations Map、Operations Task Board、Thread Command Centre 和 Budget Reliability Board 视图。
- Cloudflare Worker route skeleton，包含 Cloudflare Access JWT 校验、connector bootstrap token、Browser Origin 检查、Durable Object binding、D1 binding 和 R2 binding。
- 共享 TypeScript protocol package，用于 connector、thread、task、command 和 budget 数据。
- Rust placeholder connector crate，用于本地 connector 配置和 command lifecycle 脚手架。
- 初始 D1 schema migration 集合：`migrations/d1/`。

这仍然是本地实现切片。它还不会把 command lifecycle 写入 D1，不会通过 Durable Object relay command，也不会通过 Rust connector 执行 command。

本地启动：

```bash
pnpm install --store-dir .pnpm-store
pnpm dev:worker
pnpm dev:web
```

已提交的 Worker 配置保持生产安全。本地 `dev:worker` 脚本会构建 protocol package、应用本地 D1 migrations，并注入 `CHAOP_DEV_ALLOW_INSECURE=true`；不要在生产环境使用这个设置。

中文文档入口：

- `docs/deployment-guide.zh-Hans.md`
- `docs/ux-visual-directions.zh-Hans.md`
- `docs/PROJECT_STATE.zh-Hans.md`
- `docs/PROJECT_TODO.zh-Hans.md`
- `docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.zh-Hans.md`

真实部署前，请先提供 `docs/deployment-guide.zh-Hans.md` 中列出的 Cloudflare account、zone、Access、域名、API token 和 connector bootstrap 配置值。
