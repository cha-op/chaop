[ British English | [简体中文](PROJECT_STATE.zh-Hans.md) ]

# Project State

## Current State
- The repository now has a first implementation slice for a Cloudflare-hosted Codex control plane.
- The slice includes shared protocol types, a Worker control loop, a Lit GUI skeleton, a Rust connector, and the initial D1 migration set.
- Command lifecycle rows can now persist in D1, dispatch through the Durable Object, and return connector lifecycle events to the GUI bootstrap payload.
- Thread Command Centre prefers WebSocket realtime updates and falls back to 10-second polling when the browser socket is unavailable.
- Tasks now have one required primary thread, and local Codex sessions can be attached as task/thread pairs from Host Sessions.
- The Rust connector defaults to placeholder execution and can opt in to local Codex CLI execution with private `execution.mode = "codex_exec"` configuration, or attached-thread Codex app-server execution with private `execution.mode = "app_server"` plus `session_inventory.app_server_url`.
- The Rust connector reports lightweight local Codex session inventory, can optionally use app-server `Thread.name` values for title enrichment, and can create new local app-server threads when `session_inventory.app_server_url` is configured.
- Attached Host Sessions now request a bounded single-session history backfill from the connector, importing short rollout/history summaries without broad transcript upload.
- Archive/unarchive actions for attached Host Session tasks update Chaop's D1 task/thread state first, then try to synchronise resolvable Codex app-server threads through connector `thread/archive` and `thread/unarchive`; sync failures are reported as warnings, and non-app-server sessions remain D1-only.
- Active workstream state lives in `docs/project_journal/2026/06/2026-06-13-app-server-execution-e4a7c9.md`.

## Recovery Pointers
- Design source: `docs/design-starter.md`
- Planning source: `docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.md`
- Codex CLI execution source: `docs/project_journal/2026/06/2026-06-10-codex-cli-execution-b7f2c1.md`
- Task/thread/session attach source: `docs/project_journal/2026/06/2026-06-11-task-thread-session-attach-d6e9f3.md`
- App-server execution source: `docs/project_journal/2026/06/2026-06-13-app-server-execution-e4a7c9.md`
- Cost-aware source: `docs/cost-aware.md`
- Local journal index: optional generated `docs/project_journal/INDEX.md`; do not commit it.

## Global Blockers
- R2 artefact capture is still deferred to a later slice.
- Deployment-instance values must stay outside this repository; keep tracked docs generic and store instance values in an ignored local file or private deployment repository/subrepo.
