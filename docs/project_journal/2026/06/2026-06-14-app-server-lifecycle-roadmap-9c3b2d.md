---
id: 20260614-9c3b2d
title: App-server Lifecycle Roadmap
status: completed
created: 2026-06-14
updated: 2026-06-15
branch: wip/budget-board-real-metrics
pr: https://github.com/cha-op/chaop/pull/17
supersedes: 20260613-e4a7c9
superseded_by:
---

[ British English | [简体中文](2026-06-14-app-server-lifecycle-roadmap-9c3b2d.zh-Hans.md) ]

# App-server Lifecycle Roadmap

## Summary
- Chaop will move from the current opt-in `codex_exec` connector fallback toward connector-managed Codex app-server execution as the primary command path.
- Tasks remain a thread-first view: every task has one primary thread, and later slices may attach related threads to the same task.
- App-server lifecycle reporting must be cost-aware by design: local health checks may be frequent, but remote state writes must be deduplicated, batched, debounced, and rate-limited.
- Delivery will be split into nine PRs. Each PR must pass the complete test suite, three review lanes, and a resolved-conversation check before merge.

## PR Sequence

### PR0: Web Deploy Script
- Merge the tracked `pnpm deploy:web` entrypoint for the Browser GUI static Worker.
- Keep deployment-instance values outside the repository.
- Disable `workers.dev` and preview URLs in the generated Web Worker deploy config.

### PR1: Execution UX And Capability Cleanup
- Stop presenting `codex_exec` as the normal product path.
- Distinguish placeholder execution, managed Codex app-server execution, and the hidden/developer Codex CLI fallback in protocol and UI copy.
- Improve unavailable-state messages for new local threads and command execution when no managed app-server connector is online.
- Update docs so `codex_exec` is documented as a private fallback only.

### PR2: Connector-managed Single App-server Lifecycle
- Let the connector manage one dedicated Codex app-server listener when configured.
- Auto-start the listener when absent, health-check it, and restart it when it exits unexpectedly.
- Advertise `app_server_threads`, `app_server_archive`, and `codex_app_server_exec` only while the managed app-server is healthy enough to serve them.

### PR3: Cost-safe AppServerInstance State Model
- Add a durable state model for app-server instances without turning health checks into high-frequency D1 writes.
- Report unchanged healthy state through deduplicated and debounced summaries.
- Persist state edges such as healthy, degraded, draining, restarting, and stopped promptly.
- Keep bootstrap read-only and avoid write amplification from polling.

### PR4: AppServerInstance UI
- Show app-server instance state in Operations and Host Sessions surfaces.
- Include connector identity, endpoint type, active turn count, draining/restarting state, last changed time, and last seen age.
- Avoid high-frequency charts or log streams in the first UI slice.

### PR5: Default Command Path To App-server
- Route normal Codex commands through the managed app-server path.
- Prevent automatic fallback to `codex_exec` unless an explicit private/developer flag enables it.
- Cover new local thread creation, command execution, archive/unarchive sync, restart, and inventory in E2E validation.

### PR6: Drain, Scheduled Restart, And Upgrade
- Add a draining state for scheduled restart or upgrade.
- Wait for no active command, turn, or in-flight operation before restarting where possible.
- Restart the managed app-server and then re-inventory/re-attach affected threads.

### PR7: Multi-instance And Thread Placement Foundation
- Extend the registry to support connector-wide, workspace/project-scoped, and thread-dedicated app-server instances.
- Keep connector-wide placement as the default.
- Make thread-dedicated placement an opt-in canary path for later rolling-upgrade experiments.

Implementation checkpoint:
- `AppServerInstanceSummary` and `AgentAppServerInstance` now carry optional `workspace_id` and `thread_id` placement targets.
- D1 stores placement targets on `app_server_instances`, includes placement in the persisted identity and dedupe fingerprints, and exposes placement through bootstrap and realtime updates.
- Agent app-server reports validate scope-specific placement: connector-wide reports remain targetless by default, workspace reports require `workspace_id`, and thread reports require `thread_id`.
- Operations/Host Sessions app-server cards now show placement labels, while connector-wide remains the default managed path.

### PR8: Budget Board Real Metrics
- Replace the Budget Board placeholder data with real usage/cost signals from Chaop-controlled sources.
- Keep metric collection bounded, sampled, and cache-friendly.
- Add budget-alert setup guidance without committing deployment-instance values.

Implementation checkpoint:
- Browser bootstrap and `/api/usage-summary` now use the same D1-backed `BudgetSummary` path when the database binding is available.
- Persisted thread events now maintain bounded `daily`, `four_hour`, and `burst` `usage_windows` rows from the event persistence paths, including bounded history backfill inserts, so normal production traffic produces the sampled windows the Budget Board reads.
- The Worker samples only current still-open `daily`, `four_hour`, and `burst` `usage_windows` rows, backed by `idx_usage_windows_type_end`, plus grouped budget-state counts for online connectors and unarchived tasks.
- Budget Board now shows source metadata, generated time, sampled usage windows, window freshness, delayed/compacted event counts, and local spool bytes without adding high-frequency polling; live WebSocket sessions use a 60-second budget-only refresh path.
- Review hardening keeps bootstrap from issuing duplicate connector/task budget-state aggregate queries, labels legacy unknown metric sources explicitly, preserves over-budget percentages above 100% in the API while clamping only the UI meter control, reports missing or expired usage windows as missing samples instead of `0%`, sorts duplicate window-end samples by `updated_at` plus `id`, and prevents older backfill events from moving usage-window freshness backwards.
- Cost and deployment docs now clarify that Budget Board is a bounded Chaop posture view and does not replace Cloudflare or OpenAI billing alerts.

## Required Merge Gate Per PR
- Run the complete local test/build suite and relevant focused checks.
- Pass GitHub CI.
- Complete three review lanes: local/manual review, helper-backed independent Codex review, and PR-level GitHub Codex review when available.
- Verify all GitHub review conversations are resolved before merge.
- Merge only after the PR branch is current enough for the chosen merge strategy, then update the local target branch and create the next PR branch from that updated base.

## Cost Guardrails For Lifecycle Reporting
- Local app-server health probes can be frequent, but remote writes must be state-change or summary driven.
- Identical healthy reports over a short window should produce at most one or two persisted writes.
- WebSocket broadcasts must not imply D1 writes.
- Browser fallback polling remains 10 seconds by default.
- State edges and operator-visible failures should bypass ordinary healthy-state debounce where needed.

## Deferred Decisions
- Whether to make one app-server per active thread a default remains deferred until the connector-wide lifecycle is reliable.
- `codex_exec` should remain available only as an explicit private fallback until the managed app-server path proves complete.
