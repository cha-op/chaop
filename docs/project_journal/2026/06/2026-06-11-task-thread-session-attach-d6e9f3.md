---
id: 20260611-d6e9f3
title: Task Thread Session Attach Slice
status: active
created: 2026-06-11
updated: 2026-06-12
branch:
pr:
supersedes: []
superseded_by:
---

[ British English | [简体中文](2026-06-11-task-thread-session-attach-d6e9f3.zh-Hans.md) ]

# Task Thread Session Attach Slice

## Summary
- This slice makes one task map to one primary thread.
- Task Board now has an archive lane, and archived tasks can be restored.
- Host Sessions exposes connector-reported local Codex sessions and can attach an unattached session as a task/thread pair.
- Thread Command Centre now opens real threads from the thread list, Task Board cards, or attached host sessions.

## Decisions
- A task is a view over one thread for this slice; grouped-thread task views remain future work.
- Archive/unarchive updates the task and its primary thread together.
- Connector session inventory reports lightweight metadata only: session id, title, title source, cwd, and updated time.
- Title resolution prefers metadata or rollout title fields, then optional app-server `Thread.name`, then local history, then cwd/session-id fallback.

## Validation Targets
- Protocol and Worker tests for the new host session realtime envelope and required task thread ids.
- Rust tests for session title priority and local Codex metadata scanning.
- Web typecheck for Host Sessions, archive actions, and selected-thread command submission.
- Existing full build/test gate before commit.

## 2026-06-12 Attach Follow-Up
- Deployed Host Sessions rendered correctly, but attach returned 401 when the API Access destination did not cover the new `/api/host-sessions/*` write path.
- Worker 401 copy now explains missing Browser Access coverage or an expired Access session.
- The Web UI now surfaces server-provided action errors in a wrapping alert and shows the full host `session_id` in each Host Sessions row.
- Deployment guidance now recommends covering the Browser API with `/api/*` plus `/ws/browser`, while keeping connector bootstrap outside `/api/*`.
- Agent bootstrap is moving to `/connector/bootstrap` so broad Browser Access coverage for `/api/*` does not wrap connector bootstrap. `/api/agent/bootstrap` remains a legacy migration alias only.

## Next Steps
- Re-test attach after the Cloudflare Access destination covers `/api/*`, `/ws/browser`, and the GUI hostname.
