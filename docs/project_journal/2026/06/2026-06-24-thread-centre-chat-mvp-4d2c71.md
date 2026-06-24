---
id: 20260624-4d2c71
title: Thread Centre Chat MVP
status: completed
created: 2026-06-24
updated: 2026-06-24
branch: wip/thread-centre-chat-mvp
pr:
supersedes:
superseded_by:
---

[ British English | [简体中文](2026-06-24-thread-centre-chat-mvp-4d2c71.zh-Hans.md) ]

# Thread Centre Chat MVP

## Summary
- PR B follows the merged dogfood safety gate and keeps cost protection unchanged.
- The product goal is to make one managed Codex app-server thread usable from the Browser: choose or create a thread, send a prompt, watch live turn progress, and read the latest assistant answer without scanning raw events.
- The implementation should stay narrow. Prefer a front-end turn aggregation over new persistence unless the existing event stream cannot represent the chat view.

## Completed Scope
- Kept managed app-server execution as the default visible path for attached app-server threads.
- Added a focused Thread Centre turn stream built from commands and thread events.
- Shows the submitted prompt when the command summary is available, live progress/status from command events, the latest assistant answer from `Codex:` output events, and clear failure text from failed events.
- Keeps the raw event list as a compact diagnostic fallback below the turn stream.
- Updated sample data and tests so local development demonstrates a completed app-server turn.

## Validation
- `pnpm --filter @chaop/web test`
- `pnpm test`
- `pnpm build`
- `cargo fmt --check`
- `project_journal.py validate --repo .`
- `git diff --check`
- Local Chromium headless smoke against `#thread-centre`; the turn stream, assistant answer, and compact raw events rendered correctly with no visible overlap.
- API and Web deployments were refreshed after the change.
- Deployed E2E smoke passed through Access-authenticated direct and browser paths; Budget/Safety posture remained `normal`.

## Next Steps
- PR C should add human-in-the-loop approval and input-needed actions for Codex app-server turns.
- Keep deeper app-server transcript hydration out of this PR unless a future slice adds a bounded protocol field for full assistant messages.
