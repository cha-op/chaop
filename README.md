# Chaop Control Plane [ British English | 简体中文 ]

## British English

Chaop is a Cloudflare-first control-plane prototype for coordinating local Codex app-server work across multiple machines.

Current slice:

- Lit/Vite browser GUI with Operations Map, Operations Task Board, Thread Command Centre, and Budget Reliability Board views.
- Cloudflare Worker route skeleton with Cloudflare Access JWT validation, connector bootstrap tokens, browser Origin checks, Durable Object binding, D1 binding, and R2 binding.
- Shared TypeScript protocol package for connector, thread, task, command, and budget data.
- Rust placeholder connector crate for local connector configuration and command lifecycle scaffolding.
- Initial D1 schema migration at `migrations/d1/0001_initial.sql`.

This is still a local implementation slice. It does not yet persist command lifecycle rows in D1, relay commands through the Durable Object, or execute commands through the Rust connector.

Start locally:

```bash
pnpm install --store-dir .pnpm-store
pnpm dev:worker
pnpm dev:web
```

The committed Worker config is production-safe. The local `dev:worker` script builds the protocol package, applies local D1 migrations, and injects `CHAOP_DEV_ALLOW_INSECURE=true`; do not use that setting in production.

Documentation entrypoints:

- `docs/deployment-guide.md`
- `docs/ux-visual-directions.md`
- `docs/PROJECT_STATE.md`
- `docs/PROJECT_TODO.md`
- `docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.md`

Before real deployment, provide the Cloudflare account, zone, Access, domain, API token, and connector bootstrap values listed in `docs/deployment-guide.md`.

## 简体中文

Chaop 是一个 Cloudflare-first 控制面原型，用于协调多台机器上的本地 Codex app-server 工作。

当前切片：

- Lit/Vite 浏览器 GUI，包含 Operations Map、Operations Task Board、Thread Command Centre 和 Budget Reliability Board 视图。
- Cloudflare Worker route skeleton，包含 Cloudflare Access JWT 校验、connector bootstrap token、Browser Origin 检查、Durable Object binding、D1 binding 和 R2 binding。
- 共享 TypeScript protocol package，用于 connector、thread、task、command 和 budget 数据。
- Rust placeholder connector crate，用于本地 connector 配置和 command lifecycle 脚手架。
- 初始 D1 schema migration：`migrations/d1/0001_initial.sql`。

这仍然是本地实现切片。它还不会把 command lifecycle 写入 D1，不会通过 Durable Object relay command，也不会通过 Rust connector 执行 command。

本地启动：

```bash
pnpm install --store-dir .pnpm-store
pnpm dev:worker
pnpm dev:web
```

已提交的 Worker 配置保持生产安全。本地 `dev:worker` 脚本会构建 protocol package、应用本地 D1 migrations，并注入 `CHAOP_DEV_ALLOW_INSECURE=true`；不要在生产环境使用这个设置。

文档入口：

- `docs/deployment-guide.md`
- `docs/ux-visual-directions.md`
- `docs/PROJECT_STATE.md`
- `docs/PROJECT_TODO.md`
- `docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.md`

真实部署前，请先提供 `docs/deployment-guide.md` 中列出的 Cloudflare account、zone、Access、域名、API token 和 connector bootstrap 配置值。
