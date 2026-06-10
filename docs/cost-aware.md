[ British English | [简体中文](cost-aware.zh-Hans.md) ]

# Cost Model

This document lists the places where Chaop can incur cost and the alerts to set before broader E2E testing. It does not contain deployment-instance values.

## Current Billable Surfaces

| Surface | Why Chaop uses it | Budget alert to set |
| --- | --- | --- |
| OpenAI / Codex usage | A connector with `execution.mode = "codex_exec"` runs `codex exec` locally. That consumes the signed-in Codex allowance or API/project budget, depending on local Codex configuration. | Set a monthly OpenAI API budget and email threshold if the local Codex client is API-backed. Also watch the Codex usage or limit page for ChatGPT-backed local clients. |
| Cloudflare Workers | `chaop-api` serves browser API routes, agent bootstrap, agent WebSocket upgrade, and command dispatch. `chaop-web` serves the GUI. | Set account billing notifications and a Worker CPU limit. Watch requests and CPU time. |
| Durable Objects | `WorkspaceDO` coordinates live browser and connector WebSockets. | Watch Durable Object requests, incoming WebSocket message volume, and duration. Long-lived sockets can create duration charges unless hibernation is used. |
| D1 | D1 stores users, connectors, workspaces, tasks, commands, token hashes, and thread events. | Watch rows read, rows written, and storage. The cost-sensitive path is event volume. |
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

## Current Safeguards

The main repository defaults to placeholder execution. Real Codex execution is only enabled by a private connector config:

```toml
[execution]
mode = "codex_exec"
```

The connector currently sends only lifecycle events, the final assistant message summary, and a token-usage summary back to Cloudflare. It does not upload full Codex stdout/stderr, artefacts, or per-token logs.
Codex prompts are passed over stdin, and connector config keeps a runtime timeout plus stdout/stderr output cap for each Codex command.

## Cost Controls To Keep

- Keep one Rust connector per host and aggregate local logical agents behind it.
- Keep `codex_exec` opt-in per connector.
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
