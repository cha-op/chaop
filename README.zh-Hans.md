[ [British English](README.md) | 简体中文 ]

# Chaop 控制面

Chaop 是一个 Cloudflare-first 控制面原型，用于协调多台机器上的本地 Codex app-server 工作。

当前切片：

- Lit/Vite 浏览器 GUI，包含 Operations Map、Operations Task Board、Thread Command Centre 和 Budget Reliability Board 视图。
- Cloudflare Worker route skeleton，包含 Cloudflare Access JWT 校验、connector bootstrap token、Browser Origin 检查、Durable Object binding、D1 binding 和 R2 binding。
- 共享 TypeScript protocol package，用于 connector、thread、task、command 和 budget 数据。
- Rust placeholder connector crate，可以连接 Worker、接收 command dispatch，并发出 placeholder lifecycle events。
- 初始 D1 schema migration 集合：`migrations/d1/`。

这仍然是 placeholder 实现切片。它现在会把 placeholder command lifecycle 写入 D1，通过 Durable Object relay pending command，并用 Rust connector 跑完闭环。它还不会执行真实 Codex app-server 工作。

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

真实部署前，请先提供 `docs/deployment-guide.zh-Hans.md` 中列出的 Cloudflare account、zone、Access、域名、API token、service token 和 connector bootstrap 配置值。
