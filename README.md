[ British English | [简体中文](README.zh-Hans.md) ]

# Chaop Control Plane

Chaop is a Cloudflare-first control-plane prototype for coordinating local Codex app-server work across multiple machines.

Current slice:

- Lit/Vite browser GUI with Operations Map, Operations Task Board, Thread Command Centre, and Budget Reliability Board views.
- Cloudflare Worker route skeleton with Cloudflare Access JWT validation, connector bootstrap tokens, browser Origin checks, Durable Object binding, D1 binding, and R2 binding.
- Shared TypeScript protocol package for connector, thread, task, command, and budget data.
- Rust placeholder connector crate that can connect to the Worker, receive a command dispatch, and emit placeholder lifecycle events.
- Initial D1 schema migration set under `migrations/d1/`.

This is still a placeholder implementation slice. It now persists placeholder command lifecycle rows in D1, relays pending commands through the Durable Object, and closes the loop with the Rust connector. It does not yet execute real Codex app-server work.

Start locally:

```bash
pnpm install --store-dir .pnpm-store
pnpm dev:worker
pnpm dev:web
```

The committed Worker config is production-safe. The local `dev:worker` script builds the protocol package, applies local D1 migrations, and injects `CHAOP_DEV_ALLOW_INSECURE=true`; do not use that setting in production.

Documentation entrypoints use British English at the canonical paths. Simplified Chinese counterparts use the same basename with a `.zh-Hans.md` suffix.

- `docs/deployment-guide.md`
- `docs/ux-visual-directions.md`
- `docs/PROJECT_STATE.md`
- `docs/PROJECT_TODO.md`
- `docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.md`

Before real deployment, provide the Cloudflare account, zone, Access, domain, API token, service-token, and connector bootstrap values listed in `docs/deployment-guide.md`.
