---
id: 20260611-d6e9f3
title: Task Thread Session Attach Slice
status: active
created: 2026-06-11
updated: 2026-06-11
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

## Next Steps
- Run the full build gate and browser smoke once implementation review is clean.
- Deploy after D1 migration 0003 is applied to the remote database.
