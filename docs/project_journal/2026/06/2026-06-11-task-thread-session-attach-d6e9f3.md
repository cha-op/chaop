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
- Agent bootstrap moved to `/connector/bootstrap` so broad Browser Access coverage for `/api/*` does not wrap connector bootstrap. The old `/api/agent/bootstrap` alias was removed after Access was reconfigured.
- Host Sessions now hides archived task/thread attachments from the active attached list; they remain restorable from the Task Board archive view.
- Historical Host Session attachment still imports metadata/title only. Full transcript or rollout event backfill is deferred to a later slice.
- Codex exec diagnostics now distinguish a missing Codex executable from workspace `cwd` failures, and deployment docs recommend an absolute `execution.codex_command` for service-managed connectors.
- Thread Centre now merges bootstrap/polling payloads with local realtime state so older bootstrap snapshots do not drop already-received events. Empty attached threads show an empty timeline instead of placeholder lifecycle rows.
- Thread Centre now exposes the same archive/unarchive action as Task Board for the selected task/thread.
- Host Sessions now has a manual refresh button, `Last synced` timestamp, and age display. The refresh request asks online connectors to rescan immediately, then reloads the control-plane snapshot.
- The connector now periodically rescans local Codex sessions using `session_inventory.report_interval_seconds` and only sends the periodic inventory report when the serialized inventory changes. Worker and Web now treat each connector inventory as a connector-scoped snapshot so removed local sessions do not linger as attachable rows.

## Next Steps
- Add an explicit new Codex thread flow so Chaop can create a local Codex/app-server thread instead of only attaching existing sessions.
