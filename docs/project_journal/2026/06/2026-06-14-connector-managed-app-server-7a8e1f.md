---
id: 20260614-7a8e1f
title: Connector-managed App-server
status: completed
created: 2026-06-14
updated: 2026-06-14
branch: wip/connector-managed-app-server
pr: https://github.com/cha-op/chaop/pull/11
supersedes: 20260614-9c3b2d
superseded_by:
---

[ British English | [简体中文](2026-06-14-connector-managed-app-server-7a8e1f.zh-Hans.md) ]

# Connector-managed App-server

## Summary
- PR2 lets the Rust connector manage one dedicated local Codex app-server listener when configured.
- Managed mode starts `codex app-server` with the configured profile/model, app-server-specific extra args, and listener URL when no healthy listener is available.
- The connector health-checks the listener before exposing app-server capabilities.
- Runtime capabilities now refresh through `agent.ready`, so unhealthy managed app-server paths stop being selected for new app-server work.
- Durable AppServerInstance state, write dedupe, batching, debounce, and global rate limits remain reserved for the later AppServerInstance slice.

## Implementation
- Added `session_inventory.managed_app_server` config with `enabled`, `listen_url`, `startup_timeout_seconds`, and `restart_backoff_seconds`.
- Added an app-server manager that checks local protocol health, starts the configured listener, and retries after the configured backoff when startup or child health fails.
- Added a runtime connector config path so bootstrap, `agent.ready`, Host Session inventory, thread creation, archive sync, and app-server command execution use the same effective app-server URL.
- Added `agent.ready` capability payloads and Worker-side connector capability refresh.
- Added review-fix coverage for ready-gated Worker dispatch, authenticated reconnect handshakes, unavailable app-server command cleanup, managed child shutdown on graceful process termination, `CODEX_HOME` inheritance, and Codex profile/model plus app-server-specific extra args forwarding.
- Managed app-server restart backoff is measured after a failed startup attempt completes, avoiding immediate retry loops after long startup timeouts.
- Managed app-server children now run in a dedicated process group so connector shutdown can terminate the owned app-server tree instead of only the direct child.
- Stale cleanup now releases attached app-server commands back to pending auto dispatch when a replacement app-server attachment exists, and fails them only when no replacement can execute.
- Scoped stale cleanup now immediately dispatches those released attached commands to replacement connector sockets in the same pass, instead of leaving them pending until a later unrelated global dispatch.
- Stale cleanup also covers commands that were already released to `auto` but still carry a concrete app-server lease target, so a replacement app-server that disappears before leasing fails the command instead of leaving it pending indefinitely.
- Host Session inventory reports now track sent and acknowledged payloads separately, retry unchanged unacknowledged reports, and consume `agent.host_sessions` acknowledgements even while a command is running.
- Managed app-server listener URLs are restricted to loopback hosts, so a bad `listen_url` cannot expose the app-server protocol to a LAN interface.
- Connector realtime updates include connector `updated_at` and broadcast both capability changes and ready-socket loss, so stale bootstrap responses cannot re-enable unavailable app-server controls.
- Agent token authentication no longer marks a connector dispatch-ready; only `agent.ready` can restore `online` execution state.
- Bootstrap connector reconciliation now treats bootstrap as a complete snapshot while keeping realtime `connectors.updated` as a partial merge path, so polling can remove connectors whose offline realtime event was missed.
- Host-session backfill and app-server archive sync now require `online` connector state, matching command dispatch eligibility.
- Command dispatch now records socket-local command IDs and sends pending work to one latest ready socket per connector, so a replacement socket closing cannot fail work that was dispatched to a surviving peer.
- Connector bootstrap now registers the connector as `degraded` until `agent.ready`; bootstrap and token authentication no longer make a connector dispatch-ready.
- Managed app-server cleanup now terminates process-group descendants when the direct child has already exited.
- Dispatch now records socket-local command ownership before `send()`, so a send failure followed by socket close can still scoped-fail the leased command instead of leaving it stuck until lease expiry.
- Web realtime connector updates now trigger a bootstrap refresh when they introduce a previously unknown connector id, so workspace connector links are populated before local-thread controls rely on that connector.
- Dispatch send failures now release the just-leased command, mark the failed socket unavailable for dispatch, and retry through another ready peer when one exists; `/api/commands` remains accepted instead of surfacing a best-effort dispatch send failure as a 500.
- Rejected stale command events that release or finish a lease now clear socket-local command ownership before re-dispatch, so an old socket close cannot fail a command that has moved to a replacement socket.
- Updated deployment and cost docs in English and Simplified Chinese.

## Validation
- `cargo test -p chaop-agent`
- `pnpm --filter @chaop/worker test`
- `pnpm test`
- `pnpm build`
- `cargo fmt --check`
- `git diff --check`
- `python3 <project-journal-skill>/scripts/project_journal.py validate --repo .`
- Sensitive deployment value scan returned no matches.

## Next Slice
- PR3 will add the cost-safe AppServerInstance state model, including reporting, batching, debounce, and rate limits.
