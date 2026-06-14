---
id: 20260614-2b7d4e
title: Execution UX And Capability Cleanup
status: completed
created: 2026-06-14
updated: 2026-06-14
branch: wip/execution-ux-capabilities
pr:
supersedes: 20260614-9c3b2d
superseded_by:
---

[ British English | [简体中文](2026-06-14-execution-ux-capabilities-2b7d4e.zh-Hans.md) ]

# Execution UX And Capability Cleanup

## Summary
- PR1 separates Browser execution display modes from the existing protocol command type.
- Thread Command Centre now shows `Placeholder` and `App-server` modes by default. The `CLI fallback` control is hidden unless the Web build explicitly sets `VITE_CHAOP_SHOW_CODEX_CLI_FALLBACK=true`.
- `codex` remains the protocol command type used by both app-server execution and the private CLI fallback, so this PR does not change Worker dispatch semantics.
- New local thread unavailable states now say a managed app-server connector is missing, instead of implying any `codex_exec` connector can satisfy that path.
- Rust connector fallback events now call the path `Codex CLI fallback`, so private fallback output is clearly distinct from managed app-server operation.
- Documentation now records app-server execution as the intended product path and `codex_exec` as a private fallback/comparison path.

## Implementation
- Added Web state helpers for command display modes, managed app-server availability, CLI fallback availability, and display-mode-to-protocol-type mapping.
- Updated Thread Command Centre to render the app-server command control only for an attached app-server Host Session whose connector advertises `codex_app_server_exec`.
- Added and persisted an `execution_mode` hint so hidden CLI fallback commands cannot be routed, leased, released, or failed through an attached app-server Host Session, and explicit app-server requests cannot fall back to `codex_exec`.
- Updated Web and Worker sample data to advertise `codex_app_server_exec` and mark the attached sample Host Session as app-server present.
- Updated Worker local-thread target errors and docs to use managed app-server wording.
- Updated Rust connector/executor user-facing fallback summaries and tests from `Codex exec` to `Codex CLI fallback`.

## Validation
- `project_journal.py validate --repo <repo>`
- `git diff --check`
- `cargo fmt --check`
- `pnpm --filter @chaop/web typecheck`
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`
- Review follow-up regression coverage: CLI fallback on an attached app-server thread routes to a workspace `codex_exec` connector, pending dispatch does not attach an app-server Host Session target to that command, detach does not release or fail leased CLI fallback commands, invalid execution-mode/type combinations are rejected, and explicit app-server execution requires an attached app-server Host Session.
- `cargo test --workspace`
- `pnpm test`
- `pnpm build`

## Next Slice
- PR2 will add connector-managed single app-server lifecycle: start/check/restart the dedicated listener and advertise app-server capabilities only while it is healthy enough to serve them.
