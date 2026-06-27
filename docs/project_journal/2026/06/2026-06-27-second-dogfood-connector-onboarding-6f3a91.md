---
id: 20260627-6f3a91
title: Second Dogfood Connector Onboarding
status: active
created: 2026-06-27
updated: 2026-06-27
branch: master
pr:
supersedes: []
superseded_by:
---

[ British English | [简体中文](2026-06-27-second-dogfood-connector-onboarding-6f3a91.zh-Hans.md) ]

# Second Dogfood Connector Onboarding

## Summary
- A second host is being onboarded against the existing Cloudflare control plane so Chaop can be used to continue developing Chaop.
- Its connector identity and private token, spool, upgrade-marker, and process-state paths are isolated from the temporarily unavailable first host.
- Deployment-instance names, domains, account identifiers, secrets, and local paths remain only in the private ops repository and ignored local state.

## Current State
- The local Node 24, repository-pinned pnpm, Rust, and Codex app-server prerequisites are available.
- The release connector build and configuration doctor passed.
- Connector bootstrap succeeded with a newly rotated Worker bootstrap secret, and the connector token is stored with user-only permissions.
- The connector and its managed app-server remain healthy in a pollable foreground session; the app-server listener is loopback-only and the connector holds an established Worker TLS/WebSocket connection without authentication or reconnect errors.
- The ordinary background wrapper was not used as final evidence because this Codex command runner cleans up detached child processes when a command session ends. This is a local session-ownership constraint, not evidence of a connector authentication failure.
- The headless LaunchDaemon is installed and active in the system domain, while the connector and managed app-server run as the ordinary host user. A controlled termination verified `KeepAlive`, graceful app-server cleanup, a clean connector exit, and restoration of the loopback listener and Worker TLS/WebSocket connection with new processes.
- An Access-authenticated manual Browser pass confirmed that the connector and managed app-server are visible and healthy. Local thread creation and a bounded managed turn were exercised. The tracked service-token smoke then passed direct health, bootstrap, usage-summary, same-origin asset, and real Chromium checks without failed browser responses.
- The first inventory produced a sharp D1 rows-written burst, then the measured daily total increased only from 1,242 to 1,277 while the bounded product flow completed. Code inspection showed that the connector can import up to 200 Host Sessions on first contact; the table and index writes explain the one-time burst, while unchanged later reports skip Host Session row updates.
- Read-only production D1 aggregation confirmed 217 Host Sessions discovered today for the new connector and no current-day inventory changes for the legacy connector. At roughly five D1 row mutations per Host Session insert, those rows explain about 1,085 of the measured 1,277 daily writes. The database contains 1,545 historical Host Sessions, showing that the top-N report limit is not a retention cap.
- Dogfood exposed an empty-thread recovery race: an immediate complete inventory could clear a newly attached session's app-server presence before the app-server state database exposed the thread, leaving only placeholder execution after navigating away and back. The local fix makes post-create and post-ensure inventory reports incremental while keeping normal complete inventory available for later cleanup. The first internal review rejected an earlier Worker grace-period implementation because its snapshot and timestamp semantics were unsound; that implementation was removed. The replacement fix is not deployed yet.

## Next Steps
- Deploy the empty-thread inventory race fix, create a thread without sending a turn, navigate away and back, and confirm app-server execution remains selected.
- Observe an idle 15-minute D1 delta after the initial import slope ages out; investigate further only if rows continue rising materially above the bounded telemetry-sample writes.
- Add retention or cleanup for stale unattached Host Sessions so rolling top-N inventory does not grow D1 indefinitely.
- Remove placeholder execution from the product flow in a later focused change once managed app-server recovery is deployed and verified.
- Keep using the documented LaunchDaemon operations for rebuild/config restarts and deliberate unloads.

## Evidence
- Private ops deployment status and connector profile.
- `chaop-agent` release build and connector doctor.
- Successful connector bootstrap response with no token value recorded here.
- Local process, loopback listener, and established Worker connection checks.
- Access-authenticated manual dogfood observations and current-day D1 rows-written telemetry.
- Read-only local app-server inventory probe for the exercised thread.
- Tracked low-cost deployed smoke with Budget Board state `normal` and measured current-day D1 rows written unchanged at 1,277.
- Read-only Wrangler D1 aggregate queries; each reported `rows_written: 0` and no connector or session identifiers were emitted.
- `pnpm test` after the review fix (48 protocol, 3 script, 61 web, 294 Worker, and 166 Rust tests passed).
- `pnpm build`.
