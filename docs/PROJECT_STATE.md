[ British English | [简体中文](PROJECT_STATE.zh-Hans.md) ]

# Project State

## Current State
- The repository now has a first implementation slice for a Cloudflare-hosted Codex app-server control plane.
- The slice includes shared protocol types, a Worker skeleton, a Lit GUI skeleton, a Rust placeholder connector, and the initial D1 migration set.
- Active workstream state lives in `docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.md`.

## Recovery Pointers
- Design source: `docs/design-starter.md`
- Cost-aware source: `docs/cost-aware.md`
- Local journal index: optional generated `docs/project_journal/INDEX.md`; do not commit it.

## Global Blockers
- Cloudflare account, Access, domain, and secret configuration must be supplied before a real deployment slice can run.
