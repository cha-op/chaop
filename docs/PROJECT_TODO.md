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
- [done] PR0: Merge the tracked Web deploy script with full tests, three review lanes, and resolved GitHub conversations.
- [done] PR1: Clean up execution UX and capability wording so `codex_exec` is private fallback only.
- [done] PR2: Add connector-managed single app-server lifecycle.
- [todo] PR3: Add a cost-safe AppServerInstance state model with dedupe, debounce, batching, and rate limits.
- [todo] PR4: Add AppServerInstance state UI in Operations and Host Sessions surfaces.
- [todo] PR5: Make managed app-server execution the default command path.
- [todo] PR6: Add drain, scheduled restart, and upgrade flow.
- [todo] PR7: Add the multi-instance and thread placement foundation.
- [todo] PR8: Replace Budget Board placeholders with real bounded usage/cost metrics.
