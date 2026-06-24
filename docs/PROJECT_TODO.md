[ British English | [简体中文](PROJECT_TODO.zh-Hans.md) ]

# Project TODO

- [done] Adopt all generated visual directions as complementary v1 views: Operations Map, Operations Task Board, Thread Command Centre, and Budget Reliability Board.
- [in_progress] Expand user-facing documentation with English canonical files and paired Simplified Chinese `*.zh-Hans.md` files.
- [done] Collect Cloudflare account, Access, domain, Wrangler, and connector bootstrap configuration for the first real deployment slice in a private deployment repository/subrepo or local ignored env file, not in tracked main-repo docs.
- [done] Harden the Cloudflare-first placeholder connector control loop from local skeleton to deploy-ready command dispatch, D1 persistence, Durable Object relay, and connector lifecycle reporting.
- [done] Run a deployed placeholder E2E smoke using private Cloudflare config, Access service-token auth, and the first local connector.
- [done] Add opt-in local Codex CLI command execution behind private connector configuration.
- [done] Add task archive, Host Sessions attach, and real Thread Centre thread selection.
- [done] Add GitHub Actions unit-test CI for the shared pnpm and Rust test gate.
- [done] Add an explicit "new Codex thread" flow that can create a local Codex/app-server thread from Chaop instead of only attaching existing local sessions.
- [done] Add old-session history backfill for attached Host Sessions without uploading broad local transcripts by default.
- [done] Sync Chaop archive/unarchive actions to local Codex app-server archive state through the connector, while keeping local history files read-only.
- [done] Add real Codex app-server protocol execution for Chaop threads attached to local app-server Host Sessions.
- [done] Attach historical rollout sessions that are absent from app-server `thread/list` by resolving the local rollout path and calling app-server `thread/resume`.
- [done] PR0: Merge the tracked Web deploy script with full tests, three review lanes, and resolved GitHub conversations.
- [done] PR1: Clean up execution UX and capability wording so `codex_exec` is private fallback only.
- [done] PR2: Add connector-managed single app-server lifecycle.
- [done] PR3: Add a cost-safe AppServerInstance state model with dedupe, debounce, batching, and rate limits.
- [done] PR4: Add AppServerInstance state UI in Operations and Host Sessions surfaces.
- [done] PR5: Make managed app-server execution the default command path.
- [done] PR6: Add drain, scheduled restart, and upgrade flow.
- [done] PR7: Add the multi-instance and thread placement foundation.
- [done] PR8: Replace Budget Board placeholders with real bounded usage/cost metrics.
- [done] Close and merge the app-server attach/resume PR after the full test gate, three review lanes, and resolved GitHub conversations.
- [done] PR A: Add a dogfood safety gate with visible cost posture, guarded write/refresh actions, and an emergency pause or stop path.
- [done] PR B: Add the Thread Centre chat MVP for managed app-server threads, prompt submission, live progress, and assistant final-answer rendering.
- [planned] PR C: Add human-in-the-loop approval/input handling for Codex app-server turns.
- [planned] PR D: Add the persistent connector dogfood runbook and operational scripts for start, stop, observation, and recovery.
- [planned] PR E: Harden dogfood E2E and cost telemetry gates, adding exact D1 write attribution only if unexplained write growth reappears.
