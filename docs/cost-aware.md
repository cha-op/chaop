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
- Missing usage windows are displayed as missing samples, not as `0%` usage.
- While the browser WebSocket is live, the UI refreshes only `/api/usage-summary` every 60 seconds for Budget Board/top-bar metrics; when WebSocket falls back, the existing 10-second bootstrap polling supplies the same data and the budget-only poll is stopped.

The Worker writes those windows from the same paths that persist thread events, including bounded history backfill inserts. Each persisted thread event counts as one Chaop usage unit; low-priority P2/P3 events increment the delayed counter, `command.output` summaries increment the compacted counter, and stored summary bytes increment the local spool byte counter. Usage-window writes are aggregated by window id, so a batch of many imported events normally updates at most the current daily, four-hour, and burst rows once each. The default budget thresholds are scaled from the Cloudflare Free D1 rows-written limit with a schema-derived write model: a steady realtime event writes 12 D1 rows, made up of a thread sequence update, the event row and indexes, and three usage-window updates. Boundary events cost more when a new usage-window row is inserted: 14 rows for the first event in a minute, 16 rows for the first event in a four-hour window, and 18 rows for the first event in a UTC day. A command lifecycle event with an attached task costs 20 rows in the steady case because it also updates command state, task state, and connector activity. Bounded backfill costs 6 rows per imported event plus fixed batched usage-window updates, normally 6 more rows for a same-minute batch after the current windows exist. The Worker reads at most one still-open row per window type plus grouped budget-state counts. Expired windows are treated as missing samples until new events write the current windows. It does not scan the full event table, call Cloudflare billing APIs, call OpenAI billing APIs, or require deployment-instance secrets. Treat the board as an operator posture estimate, not as the official invoice source. Keep the Cloudflare and OpenAI budget alerts above enabled.

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
- Cloudflare Notifications: https://developers.cloudflare.com/notifications/
- OpenAI API pricing and budget controls: https://openai.com/api/pricing/
- Codex usage limits: https://help.openai.com/en/articles/11369540-codex-in-chatgpt
