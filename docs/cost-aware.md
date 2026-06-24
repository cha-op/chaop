[ British English | [简体中文](cost-aware.zh-Hans.md) ]

# Cost Model

This document lists the places where Chaop can incur cost and the alerts to set before broader E2E testing. It does not contain deployment-instance values.

## Current Billable Surfaces

| Surface | Why Chaop uses it | Budget alert to set |
| --- | --- | --- |
| OpenAI / Codex usage | A connector with `execution.mode = "app_server"` starts turns through the local Codex app-server. A connector with the private fallback `execution.mode = "codex_exec"` runs `codex exec` locally. Both consume the signed-in Codex allowance or API/project budget, depending on local Codex configuration. | Set a monthly OpenAI API budget and email threshold if the local Codex client is API-backed. Also watch the Codex usage or limit page for ChatGPT-backed local clients. |
| Cloudflare Workers | `chaop-api` serves browser API routes, agent bootstrap, agent WebSocket upgrade, and command dispatch. `chaop-web` serves the GUI. | Set account billing notifications and a Worker CPU limit. Watch requests and CPU time. |
| Durable Objects | `WorkspaceDO` coordinates live browser and connector WebSockets. | Watch Durable Object requests, incoming WebSocket message volume, and duration. Long-lived sockets can create duration charges unless hibernation is used. |
| D1 | D1 stores users, connectors, workspaces, tasks, commands, token hashes, thread events, and compact event-unit usage windows. | Watch rows read, rows written, and storage. The cost-sensitive path is event volume; Chaop batches usage-window accounting so bounded backfills update each active window once per batch instead of once per event. |
| R2 | Reserved for command artefacts, uploaded summaries, and larger logs in a later slice. | Create an R2 alert before enabling artefact capture. Watch storage, Class A operations, and Class B operations. |
| Workers Logs / observability | Useful during deploy and incident triage. | Keep production logging short and avoid leaving high-volume tailing or log export enabled without a cap. |

## Practical Alert Checklist

Configure these before leaving the connector running unattended:

1. Cloudflare account billing or usage notification for the whole account.
2. Cloudflare Workers request and CPU alert for `chaop-api`.
3. Durable Object duration/request alert for `WorkspaceDO`.
4. D1 rows-written alert for `chaop-control`.
5. D1 rows-read alert for `chaop-control`.
6. R2 storage and operation alerts for `chaop-artifacts` before artefact upload is enabled.
7. OpenAI API monthly budget and email threshold if local Codex is API-backed.
8. Codex usage/limit watch if local Codex is ChatGPT-plan-backed.

## Budget Board Signals

When D1 is bound, the Browser Budget Board uses Chaop-controlled database signals instead of static sample data:

- The current still-open `usage_windows` row for each of `daily`, `four_hour`, and `burst`.
- The worst current `budget_state` from sampled current usage windows, online connectors, and unarchived tasks.
- Delayed events, compacted events, and local spool bytes from the daily usage window when present, otherwise the next available sampled window.
- Source metadata showing whether the board is backed by D1 usage windows, local sample data, or an empty database.
- Optional Cloudflare GraphQL Analytics samples for Worker requests, Durable Object request-equivalent usage, D1 rows read, and D1 rows written when `CF_TELEMETRY_API_TOKEN` and the non-secret telemetry selectors are configured.
- A persisted Cloudflare telemetry history for the last 24 hours. Samples are bucketed at five minutes by default, so refreshing the board within the same bucket does not insert another history point; if cumulative counters increase, Chaop updates that bucket row so later safety guards do not read stale telemetry.
- The server-side dogfood safety guard uses already persisted Cloudflare telemetry samples plus local usage windows, rather than putting a live GraphQL query in front of guarded write paths. For the current UTC day, guarded write paths read the maximum persisted cumulative counter for each telemetry metric, so a later lower or partial Cloudflare sample cannot relax an earlier hard limit. `/api/safety-posture` remains the explicit live refresh path for operator-facing safety data, persists the refreshed sample into the same low-frequency telemetry bucket, and merges the live sample with the persisted current-day maximum before returning the safety posture.
- A focused D1 rows-written trend. The current UI charts only D1 rows written, then shows 15-minute and one-hour slopes plus a same-day projection derived from cumulative Cloudflare samples.
- Low-cost D1 write activity signals: measured current-day D1 writes, schema-model conservative event write estimates from the current daily usage window, and the residual gap between the two. If Cloudflare telemetry is lower than the local estimate, Chaop uses the local estimate for the daily D1 write guardrail.
- Missing current four-hour and burst usage windows are displayed as `0%` local schema-model baselines. Missing daily D1 rows-written still needs Cloudflare Analytics or a real daily usage window because daily D1 writes can include non-event inventory and control-plane writes.
- Detailed budget constraints for D1 rows written, Worker requests, Durable Object request-equivalent usage, and D1 rows read. The compact posture and throttle decision use the sampled hard constraint with the lowest remaining ratio; missing constraints are shown in the detailed view but do not participate in that minimum.
- While the browser WebSocket is live, the UI refreshes only `/api/usage-summary` every 60 seconds for Budget Board/top-bar metrics; when WebSocket falls back, the existing 10-second bootstrap polling supplies the same data and the budget-only poll is stopped.

The Worker writes those windows from the same paths that persist thread events, including bounded history backfill inserts. Each persisted thread event counts as one Chaop usage unit; low-priority P2/P3 events increment the delayed counter, `command.output` summaries increment the compacted counter, and stored summary bytes increment the local spool byte counter. Usage-window writes are aggregated by window id, so a batch of many imported events normally updates at most the current daily, four-hour, and burst rows once each. Backfilled events keep their original event timestamps in the thread history, but their D1 write-budget windows use the import timestamp because those rows consume today's D1 write quota. The default budget thresholds are scaled from the Cloudflare Free D1 rows-written limit with a conservative schema-derived write model: Chaop budgets 26 D1 rows per event, matching a command lifecycle with an attached task at a daily usage-window boundary. A cheaper steady realtime event writes 12 D1 rows, made up of a thread sequence update, the event row and indexes, and three usage-window updates. Boundary events cost more when a new usage-window row is inserted: 14 rows for the first event in a minute, 16 rows for the first event in a four-hour window, and 18 rows for the first event in a UTC day. A command lifecycle event with an attached task costs 20 rows in the steady case because it also updates command state, task state, and connector activity. Bounded backfill costs 6 rows per imported event plus fixed batched usage-window updates, normally 6 more rows for a same-minute import batch after the current windows exist.

The Worker can optionally query Cloudflare's GraphQL Analytics API for the current UTC day. That path uses `workersInvocationsAdaptive` for the API/Web Worker request count, `d1AnalyticsAdaptiveGroups` for D1 rows read and written, and Durable Object analytics for request-equivalent usage. Incoming Durable Object WebSocket messages are folded into request equivalents at Cloudflare's 20 incoming messages to 1 request ratio only when `CF_TELEMETRY_DO_NAMESPACE_NAME` scopes the periodic metric to the Chaop Durable Object namespace. The query has a short timeout that defaults to five seconds, a per-isolate cache that defaults to five minutes, and a failure backoff of at most 60 seconds. Failures keep those constraints as `missing` instead of blocking the Browser API.

When Cloudflare telemetry is available, the Worker persists at most one `budget_telemetry_samples` row per sample bucket and telemetry selector. The selector hash covers the Cloudflare account, API Worker, Web Worker, D1 database, and Durable Object namespace selectors so environment changes do not reuse stale samples. The history read is bounded to the most recent 24 hours and 300 rows, then cached per isolate for 60 seconds by default unless a new sample row was inserted. Slope calculations use only samples from the same UTC day as the latest sample, because Cloudflare's D1 rows-written counter is cumulative for the current day and resets at 00:00 UTC. Guarded write checks also stay within the same UTC-day reset boundary, but they aggregate the persisted daily maximum per metric instead of trusting only the newest bucket. The D1 activity residual is useful for spotting non-event write drivers, but exact attribution still requires a later query-meta wrapper around write paths.

Chaop's `hard_limited` budget posture is an operator/control-plane state, not a Cloudflare account-level write stop. It can hide or throttle Chaop actions, but Cloudflare will still count any D1 write that reaches D1, including manual dashboard/Wrangler work, deployment migrations, telemetry sample inserts, or code paths that are not yet guarded.

The Budget Board `Bootstrap` action writes zero-count current `daily`, `four_hour`, and `burst` usage windows. It is a manual recovery and diagnostics tool, not required for normal display: unopened current four-hour and burst windows are shown as local `0%` baselines without writing rows. Bootstrap does not backfill historic events, scan the event table, or call billing APIs.

The board does not call Cloudflare billing APIs, does not call OpenAI billing APIs, and does not upload deployment-instance secrets. Cloudflare GraphQL Analytics is an operational analytics source, not the official invoice source. Treat the board as an operator posture estimate and keep the Cloudflare and OpenAI budget alerts above enabled.

## Current Safeguards

The main repository defaults to placeholder execution. Managed Codex execution is only enabled by a private app-server connector config:

```toml
[execution]
mode = "app_server"
```

The CLI adapter is a private fallback/comparison path, not the default product path:

```toml
[execution]
mode = "codex_exec"
```

The connector currently sends only lifecycle events and the final assistant message summary back to Cloudflare for app-server execution. It does not upload app-server `commandExecution` output by default. The CLI adapter also sends a token-usage summary when Codex JSONL includes one. It does not upload full Codex stdout/stderr, local transcripts, artefacts, or per-token logs.
Codex prompts are passed over stdin for `codex_exec` and through `turn/start` for `app_server`; connector config keeps a runtime timeout for each Codex command.

Host Session inventory is quiet while the connector is idle. The Browser Host Sessions page has a manual refresh button and an opt-in one-minute auto-refresh; the Durable Object deduplicates those refresh requests per connector so extra browser windows do not increase connector rescan frequency. User actions that mutate Host Sessions, such as creating or attaching a local thread, can still trigger one immediate inventory report so the UI does not stay stale.

The dogfood guard separates current-command cleanup from new work dispatch. Terminal connector events such as `command.finished` and `command.failed` can still close an in-flight command during a pause or hard limit, but pending command lease/dispatch checks `command_create` safety again before starting another turn, including after stale app-server target cleanup. `conservative` posture blocks broad Host Session refresh only; it still allows already accepted focused command dispatch. Host Session detach is guarded as a write action because it can clear attachments, fail commands, and trigger follow-up dispatch.

## Cost Controls To Keep

- Keep one Rust connector per host and aggregate local logical agents behind it.
- Keep `app_server` opt-in per connector, and keep `codex_exec` as a private fallback hidden from the Browser by default.
- Managed app-server health checks are local connector probes. The connector now reports AppServerInstance state through a dedicated channel, with duplicate healthy reports filtered by Durable Object in-memory dedupe and unchanged summaries protected by a 15 minute D1 debounce. State edges and active turn count changes still persist promptly.
- Keep command output summaries short until an explicit artefact upload policy exists.
- Add server-side per-command event limits before adding live stdout streaming.
- Add R2 chunking and retention rules before enabling artefact upload.
- Add WebSocket hibernation work before leaving many browser sessions open.

## References

- Cloudflare Workers and Durable Objects pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Cloudflare GraphQL Analytics API: https://developers.cloudflare.com/analytics/graphql-api/
- Querying Workers Metrics with GraphQL: https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
- Cloudflare Notifications: https://developers.cloudflare.com/notifications/
- OpenAI API pricing and budget controls: https://openai.com/api/pricing/
- Codex usage limits: https://help.openai.com/en/articles/11369540-codex-in-chatgpt
