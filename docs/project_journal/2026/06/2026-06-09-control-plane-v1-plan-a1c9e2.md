---
id: 20260609-a1c9e2
title: Control Plane V1 Planning Slice
status: active
created: 2026-06-09
updated: 2026-06-10
branch:
pr:
supersedes: []
superseded_by:
---

[ British English | [简体中文](2026-06-09-control-plane-v1-plan-a1c9e2.zh-Hans.md) ]

# Control Plane V1 Planning Slice

## Summary
- V1 will start with a Cloudflare-first end-to-end control loop: Browser GUI, Worker, Durable Object, D1, R2 bindings, and a Rust placeholder connector.
- The first UX slice prioritises dashboard status, agents/workspaces, thread detail, command submission, event streaming, and cost-state visibility.
- The implementation must follow the project journal workflow. Ordinary workstream state belongs in this journal; repo-wide pointers belong in `docs/PROJECT_STATE.md`; cross-workstream backlog belongs in `docs/PROJECT_TODO.md`.

## Current Decisions
- UX slice: Control Loop.
- Visual process: use the generated directions as complementary product views instead of choosing only one.
- Deployment model: Cloudflare-first.
- Browser auth: Cloudflare Access.
- Agent auth: bootstrap secret issues per-connector tokens; D1 stores token hashes.
- Agent endpoint: Worker token checks for `/api/agent/bootstrap` and `/ws/agent`; Browser paths remain behind Cloudflare Access.
- Domain shape: split GUI and API domains.
- Resource provisioning: prefer Wrangler-driven automation and code-controlled configuration.
- Initial inventory: connector registration records connector identity first; host and workspace records are deferred to the inventory slice.
- Command execution depth: Rust placeholder connector, not real Codex app-server yet.
- Cost UX depth: status badges plus compact daily and 4-hour usage summary.
- UX focus rule: each view has one primary job; shared signals stay compact and secondary unless they are the core job of that view.
- Approval, artifacts, and full log upload: protocol and UI entry points only in the first slice; real flows are deferred.

## Documentation Requirement
- User-facing documentation uses English canonical files at the default paths.
- Paired Simplified Chinese documents use the same basename with a `.zh-Hans.md` suffix.
- The language switch belongs near the top of each paired document as `[ British English | 简体中文 ]` links; it must not be part of the title.
- English is written in British English. Simplified Chinese documents use Chinese characters for Chinese readers, not romanised text.
- The documentation set should include usage guide, quick start, FAQ, troubleshooting, deployment guide, architecture, cost model, and any operational runbooks added later.

## Next Steps
- Replace placeholder connector execution with real Codex app-server integration in a later slice.

## 2026-06-09 Handoff
- Generated three visual directions: `Operations Map`, `Thread Command Centre`, and `Budget Reliability Board`.
- Added a deployment guide with Cloudflare, Wrangler, Access, domain, budget, and connector bootstrap configuration instructions.
- Added a visual direction summary.
- Revised the UX decision so all visual directions become first-class views.
- Added `Operations Task Board` as a task-focused Operations sub-view with user-defined categories and swimlanes for `Running`, `Idle`, `Waiting for approval`, `Waiting for input`, `Throttled`, and `Done`.
- Added the view-focus rule: one view, one primary job, with cross-cutting signals kept secondary.
- Implemented the first local skeleton: pnpm/Vite/Lit web app, Cloudflare Worker route skeleton, WorkspaceDO skeleton, shared protocol package, D1 migration, and Rust placeholder connector.
- Local validation passed for `pnpm test`, `pnpm build`, `cargo fmt --check`, SQLite parsing of `migrations/d1/0001_initial.sql`, Wrangler deploy dry-run, Wrangler D1 local migration discovery, project journal validation, setup-ci node tests, Chromium headless screenshots for Operations Map and Operations Task Board, and a local Worker `POST /api/commands` smoke check through dev auth plus Origin guard.
- Review fixes applied: Cloudflare Access JWT validation now verifies JWT signature/audience/normalised issuer via Access JWKS; production agent bootstrap issues random connector tokens and stores only SHA-256 token hashes in D1; development-only agent tokens are signed and only accepted when insecure dev mode is enabled; malformed agent tokens return stable 401; Lit renders into light DOM so global CSS applies; production bootstrap failures no longer silently show sample data; the Worker config explicitly points Wrangler at `migrations/d1`; and the D1 migration now has first-pass FK/CHECK constraints.
- Follow-up review fixes applied: production web fetches now use `VITE_CHAOP_API_BASE_URL` for split GUI/API domains; Worker JSON responses include allowlisted credentialed CORS headers; deployment guide Access variable names now match Worker runtime names; and Worker routes reject malformed JSON or missing required request fields with 400.
- Final review fixes applied: browser API and browser WebSocket routes now reject disallowed origins before side effects; connector IDs include a random suffix to prevent same-name metadata/token takeover; `migrations/d1/*.sql` is explicitly re-included against the user's global `*.sql` ignore rule; the local Worker dev script injects insecure dev auth without triggering Wrangler's skills prompt; and README/source-note docs now clarify the current slice status and documentation entrypoints.
- Final re-check fixes applied: app-level dev scripts now build `@chaop/protocol` before starting Vite or Wrangler; Worker dev applies local D1 migrations and injects a local-only bootstrap secret; and local insecure agent bootstrap returns the current local Worker WebSocket URL instead of the sample production API domain.
- Wide review follow-up fixes applied on 2026-06-10: connector token lookup gets a D1 `token_hash` index through migration `0002`; web command submission uses a simple `text/plain` JSON body to avoid Cloudflare Access preflight in the current slice; the web placeholder command no longer hardcodes a connector target; Worker command creation validates supplied connector targets against workspace membership, `can_execute`, and offline status when D1 is bound; and the Command Centre displays accepted/failed command feedback.
- Deployment-instance values must not be tracked in this repository. Keep the main docs generic, rewrite branch history to remove any committed instance values, and record concrete deployment values in a private deployment repository/subrepo or local ignored env file.
- 2026-06-10 control-loop implementation update: Browser bootstrap can load persisted command/event state from D1; `POST /api/commands` writes a placeholder command and accepted event; `WorkspaceDO` dispatches pending commands to the matching agent WebSocket; agent lifecycle events update command/task state and append thread events; and the web Thread Command Centre shows the accepted command and returned timeline.
- 2026-06-10 connector update: `chaop-agent --connect --run-once` reads the local connector token, connects to the Worker WebSocket, handles `command.dispatch`, and emits the placeholder `started`, `output`, and `finished` event stream.
- 2026-06-10 auth update: Cloudflare Access service-token JWTs without email claims are accepted as synthetic service identities for operator smoke tests, while email-bearing Access JWTs still map to normal user identities.
- Local validation passed for `pnpm --filter @chaop/worker test`, `pnpm typecheck`, `cargo fmt --check`, `cargo test --workspace`, and `pnpm test`.
- Deployed placeholder E2E smoke passed on 2026-06-10 using private Cloudflare configuration, Access service-token auth, and the first local connector. The resulting command reached `succeeded` and the bootstrap timeline included `command.accepted`, `command.started`, `command.output`, and `command.finished`.
- Internal review follow-up fixes applied: connector dispatch leases one pending command at a time for `--run-once` safety; untargeted command leasing now checks workspace connector membership and execution permission; repeat bootstrap marks older same-name/same-host connectors offline; and bootstrap summaries hide offline stale connectors.
- Second internal review follow-up fixes applied: long-lived connectors no longer inherit the acknowledgement read timeout while idle; expired leases can be reclaimed; and lease updates now check whether the row was actually claimed before dispatching, preventing duplicate execution from concurrent sockets.
- Post-fix deployed smoke passed again, and an idle long-lived connector stayed connected beyond the previous 10-second timeout window.

## Evidence
- Source documents: `docs/design-starter.md`, `docs/cost-aware.md`.
- Deployment guide: `docs/deployment-guide.md`.
- Visual direction summary: `docs/ux-visual-directions.md`.
- Implementation entrypoints: `apps/web`, `apps/worker`, `packages/protocol`, `crates/agent`, `migrations/d1/0001_initial.sql`.
- Planning outcome recorded on 2026-06-09.
