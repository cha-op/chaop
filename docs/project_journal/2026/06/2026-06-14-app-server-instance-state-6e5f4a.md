---
id: 20260614-6e5f4a
title: App-server Instance State
status: completed
created: 2026-06-14
updated: 2026-06-14
branch: wip/app-server-instance-state
pr:
supersedes: 20260614-9c3b2d
superseded_by:
---

[ British English | [简体中文](2026-06-14-app-server-instance-state-6e5f4a.zh-Hans.md) ]

# App-server Instance State

## Summary
- PR3 adds a dedicated AppServerInstance state channel instead of overloading Host Session inventory.
- The Worker persists connector-wide app-server instance state in D1 with server-side dedupe and debounce for unchanged healthy reports.
- The connector reports state edges promptly and sends unchanged healthy summaries at a low cadence.
- Web bootstrap and realtime state can now carry app-server instances, but visible Operations and Host Sessions UI remains reserved for PR4.

## Implementation
- Added `app_server_instances` D1 schema for connector id, instance key, scope, endpoint type, state, active turn count, generation, summaries, and timestamps.
- Added protocol payloads for `agent.app_server_instances` and `app_server_instances.updated`.
- Added Worker DB recording with a 15 minute unchanged healthy debounce, immediate state-edge writes, snapshot omission stop handling, and offline connector stop handling.
- Added Durable Object validation, ack, browser fanout, and short-window in-memory duplicate healthy report suppression.
- Added connector-side app-server instance snapshots, `app_server_instance_state` capability, ack/retry handling, five minute healthy summaries, and active turn count reporting around app-server turns.
- Added web state merge support for bootstrap and realtime app-server instance payloads without adding PR4 UI.

## Cost Guardrails
- Local health probing remains local to the connector.
- Duplicate healthy reports are filtered in the Durable Object before D1 when they repeat within the short in-memory window.
- D1 still enforces a 15 minute debounce for unchanged healthy summaries, so a missed DO cache does not become a high-frequency write loop.
- State edges such as degraded, restarting, stopped, and active turn count changes bypass the healthy debounce.
- Bootstrap remains read-only and only includes persisted instance state.

## Validation
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`
- `cargo test -p chaop-agent`
- `cargo fmt --check`

## Next Slice
- PR4 will render AppServerInstance state in Operations and Host Sessions surfaces.
