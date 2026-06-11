[ British English | [简体中文](README.zh-Hans.md) ]

# Chaop Control Plane

Chaop is a Cloudflare-first control-plane prototype for coordinating local Codex app-server work across multiple machines.

Current slice:

- Lit/Vite browser GUI with Operations Map, Operations Task Board, Thread Command Centre, and Budget Reliability Board views.
- Cloudflare Worker route skeleton with Cloudflare Access JWT validation, connector bootstrap tokens, browser Origin checks, Durable Object binding, D1 binding, and R2 binding.
- Shared TypeScript protocol package for connector, thread, task, command, and budget data.
- Rust connector crate that can connect to the Worker, receive command dispatches, run placeholder execution by default, and opt in to local `codex exec` execution through private configuration.
- Initial D1 schema migration set under `migrations/d1/`.

This slice now persists command lifecycle rows in D1, relays pending commands through the Durable Object, and closes the loop with the Rust connector. Local Codex CLI execution is opt-in per connector with `execution.mode = "codex_exec"`; experimental Codex app-server protocol integration and R2 artefact capture remain later slices.

Start locally:

```bash
pnpm install --store-dir .pnpm-store
pnpm dev:worker
pnpm dev:web
```

The committed Worker config is production-safe. The local `dev:worker` script builds the protocol package, applies local D1 migrations, and injects `CHAOP_DEV_ALLOW_INSECURE=true`; do not use that setting in production.

Documentation entrypoints use British English at the canonical paths. Simplified Chinese counterparts use the same basename with a `.zh-Hans.md` suffix.

- `docs/deployment-guide.md`
- `docs/cost-aware.md`
- `docs/ux-visual-directions.md`
- `docs/PROJECT_STATE.md`
- `docs/PROJECT_TODO.md`
- `docs/project_journal/2026/06/2026-06-11-thread-centre-realtime-c4d8a2.md`
- `docs/project_journal/2026/06/2026-06-10-codex-cli-execution-b7f2c1.md`
- `docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.md`

Before real deployment, provide the Cloudflare account, zone, Access, domain, API token, service-token, and connector bootstrap values listed in `docs/deployment-guide.md`.
