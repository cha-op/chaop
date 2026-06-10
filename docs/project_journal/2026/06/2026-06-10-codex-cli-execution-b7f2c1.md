---
id: 20260610-b7f2c1
title: Codex CLI Execution Slice
status: active
created: 2026-06-10
updated: 2026-06-10
branch:
pr:
supersedes: []
superseded_by:
---

[ British English | [简体中文](2026-06-10-codex-cli-execution-b7f2c1.zh-Hans.md) ]

# Codex CLI Execution Slice

## Summary
- This slice adds opt-in real local command execution through `codex exec`.
- The main repository remains safe by default: connector execution mode defaults to `placeholder`.
- Deployment-instance enablement belongs in the private ops repository or another ignored/private config store.

## Decisions
- Use `codex exec --json --ephemeral --sandbox read-only -C <workspace> -` as the first real execution adapter, with the prompt passed over stdin.
- Keep the experimental Codex app-server protocol as a later slice.
- Return lifecycle events, the final assistant message summary, and token usage summary to Cloudflare; do not upload full stdout/stderr or artefacts yet.
- Let the Thread Command Centre choose between `placeholder` and `codex` command types.
- Treat OpenAI/Codex usage as a cost surface and document budget-alert setup alongside Cloudflare costs.

## Implementation Notes
- `CreateCommandRequest` now accepts an optional command `type`.
- Worker command creation preserves `placeholder` or `codex` type and rejects unknown types.
- The Rust connector advertises `codex_exec` capability only when private config enables it.
- A `codex` command fails clearly when received by a connector that has not enabled `codex_exec`.
- The Worker only targets `codex` commands at connectors that advertise `codex_exec`.
- The connector caps Codex runtime and stdout/stderr buffering before returning result events.
- The web app exposes a compact execution-mode segmented control in Thread Command Centre.

## Validation Targets
- Unit tests for Worker command type validation.
- Rust tests for connector execution gating and Codex JSONL parsing.
- Typecheck and build for all packages.
- Deployed smoke for placeholder and one bounded Codex command after private connector config is updated.

## Evidence
- Protocol: `packages/protocol/src/index.ts`.
- Worker: `apps/worker/src/routes.ts`, `apps/worker/src/db.ts`.
- Web: `apps/web/src/app-root.ts`, `apps/web/src/api.ts`.
- Connector: `crates/agent/src/config.rs`, `crates/agent/src/connector.rs`, `crates/agent/src/executor.rs`.
- Cost model: `docs/cost-aware.md`.
