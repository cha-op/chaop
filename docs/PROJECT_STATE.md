[ British English | [简体中文](PROJECT_STATE.zh-Hans.md) ]

# Project State

## Current State
- The repository now has a first implementation slice for a Cloudflare-hosted Codex control plane.
- The slice includes shared protocol types, a Worker control loop, a Lit GUI skeleton, a Rust connector, and the initial D1 migration set.
- Command lifecycle rows can now persist in D1, dispatch through the Durable Object, and return connector lifecycle events to the GUI bootstrap payload.
- Thread Command Centre prefers WebSocket realtime updates and falls back to 10-second polling when the browser socket is unavailable.
- Tasks now have one required primary thread, and local Codex sessions can be attached as task/thread pairs from Host Sessions.
- The Rust connector defaults to placeholder execution and can opt in to local Codex CLI execution with private `execution.mode = "codex_exec"` configuration, or attached-thread Codex app-server execution with private `execution.mode = "app_server"` plus `session_inventory.app_server_url`.
- Thread Command Centre now separates display execution modes from protocol command types: managed app-server execution is shown as the product path, while the Codex CLI fallback is hidden unless the Web build explicitly enables it.
- Thread Command Centre now defaults implicit command submissions to managed app-server execution when the selected thread has an attached app-server Host Session; the Worker also infers `execution_mode = "app_server"` for that target and rejects bare `codex` requests that would otherwise fall through to `codex_exec`.
- The Rust connector reports lightweight local Codex session inventory on demand, can optionally use app-server `Thread.name` values for title enrichment, and can create new local app-server threads when `session_inventory.app_server_url` is configured.
- The Rust connector can now manage one dedicated local Codex app-server listener, health-check it before advertising app-server capabilities, and refresh connector capabilities through `agent.ready`.
- Managed connector app-server mode now supports draining restarts for periodic maintenance and local upgrade-marker triggers: the connector reports `draining`, withdraws app-server capabilities while active turns finish, then restarts and re-advertises after a healthy app-server probe.
- Operations Map and Host Sessions now surface AppServerInstance state, including connector identity, placement, endpoint type, active turns, changed/seen age, and unhealthy lifecycle states.
- Budget Board now reads bounded D1 usage windows and grouped budget-state signals when the database is bound, with source metadata and freshness displayed in the Browser.
- Attached Host Sessions now request a bounded single-session history backfill from the connector, importing short rollout/history summaries without broad transcript upload.
- Archive/unarchive actions for attached Host Session tasks update Chaop's D1 task/thread state first, then try to synchronise resolvable Codex app-server threads through connector `thread/archive` and `thread/unarchive`; sync failures are reported as warnings, and non-app-server sessions remain D1-only.
- Attaching an unused local Codex session through a connector with `host_session_app_server_ensure` now resumes it through app-server before creating the Chaop task/thread attachment, so Thread Centre can use the managed app-server command path immediately.
- The nine-PR app-server lifecycle roadmap is implemented through the Budget Board real-metrics slice.
- Deployed E2E smoke now has a documented Access-cookie browser path and a repo-local skill for repeatable low-cost API, Web, browser, and Budget Board validation.
- Completed workstream state lives in `docs/project_journal/2026/06/2026-06-14-app-server-lifecycle-roadmap-9c3b2d.md`.

## Recovery Pointers
- Design source: `docs/design-starter.md`
- Planning source: `docs/project_journal/2026/06/2026-06-09-control-plane-v1-plan-a1c9e2.md`
- Codex CLI execution source: `docs/project_journal/2026/06/2026-06-10-codex-cli-execution-b7f2c1.md`
- Task/thread/session attach source: `docs/project_journal/2026/06/2026-06-11-task-thread-session-attach-d6e9f3.md`
- App-server execution source: `docs/project_journal/2026/06/2026-06-13-app-server-execution-e4a7c9.md`
- App-server lifecycle roadmap source: `docs/project_journal/2026/06/2026-06-14-app-server-lifecycle-roadmap-9c3b2d.md`
- Execution UX cleanup source: `docs/project_journal/2026/06/2026-06-14-execution-ux-capabilities-2b7d4e.md`
- Connector-managed app-server source: `docs/project_journal/2026/06/2026-06-14-connector-managed-app-server-7a8e1f.md`
- AppServerInstance UI source: `docs/project_journal/2026/06/2026-06-14-app-server-instance-ui-4b6d91.md`
- Default app-server command path source: `docs/project_journal/2026/06/2026-06-14-default-app-server-command-path-a5d8c0.md`
- App-server restart flow source: `docs/project_journal/2026/06/2026-06-14-app-server-restart-flow-c7e2a4.md`
- App-server attach resume source: `docs/project_journal/2026/06/2026-06-15-app-server-attach-resume-f4c9a8.md`
- Cost-aware source: `docs/cost-aware.md`
- Deployed E2E smoke source: `docs/e2e-smoke.md`
- Deployed E2E smoke and cost check journal: `docs/project_journal/2026/06/2026-06-23-deployed-e2e-smoke-cost-check-7c9d1e.md`
- Local journal index: optional generated `docs/project_journal/INDEX.md`; do not commit it.

## Global Blockers
- R2 artefact capture is still deferred to a later slice.
- Deployment-instance values must stay outside this repository; keep tracked docs generic and store instance values in an ignored local file or private deployment repository/subrepo.
