[ British English | [简体中文](deployment-guide.zh-Hans.md) ]

# Deployment Guide

### Purpose

This guide explains how to prepare the Cloudflare and connector configuration for the first deployment slice of the Codex control plane.

The first slice is Cloudflare-first. The Rust connector supports placeholder execution by default and can opt in to managed Codex app-server execution, or to a private local `codex exec` fallback, through private connector configuration:

```text
Browser GUI -> Cloudflare Access -> Worker / Durable Object -> D1 / R2 -> Rust connector -> Worker / Durable Object -> Browser GUI
```

Current implementation status: the repository can persist command lifecycle rows in D1, dispatch pending commands through the Durable Object, receive lifecycle events from the Rust connector, attach local Codex sessions as task/thread views, create new local Codex app-server threads, and sync archive/unarchive for attached Host Session tasks when the connector has `session_inventory.app_server_url` configured. The intended product execution path is the app-server protocol (`execution.mode = "app_server"`). The CLI adapter (`execution.mode = "codex_exec"`) remains a private fallback/comparison path. R2 artefact capture is still reserved for a later slice.

Keep secrets out of Git. Share sensitive values only through a local ignored file, a password manager, or direct `wrangler secret put` commands.

### Wrangler in this project

Wrangler is Cloudflare's project CLI for Workers development, resource binding, secrets, and deployment.

For this repository, Wrangler should be treated as the deployment control surface:

- `wrangler.jsonc` or `wrangler.toml` is the source of truth for Worker configuration.
- D1 and R2 resources are created with Wrangler commands.
- Runtime secrets are written with `wrangler secret put`.
- Cloudflare Access is configured in Zero Trust first; the Worker then validates the Access JWT.

Official references:

- Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/
- Wrangler environment variables: https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- Cloudflare API token permissions: https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- Cloudflare GraphQL Analytics API: https://developers.cloudflare.com/analytics/graphql-api/
- D1 Wrangler commands: https://developers.cloudflare.com/d1/wrangler-commands/
- R2 Wrangler commands: https://developers.cloudflare.com/r2/reference/wrangler-commands/
- Cloudflare Access self-hosted apps: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/
- Cloudflare Access JWT validation: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

### Values to provide

Provide these non-secret values before the first implementation/deployment pass:

```text
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_ZONE_ID=
CHAOP_RESOURCE_PREFIX=chaop
CHAOP_GUI_DOMAIN=app.example.com
CHAOP_API_DOMAIN=api.example.com
VITE_CHAOP_API_BASE_URL=https://api.example.com
ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
ACCESS_AUD=
CHAOP_ACCESS_ALLOWED_EMAILS=
CHAOP_ACCESS_ALLOWED_GROUPS=
CHAOP_FIRST_CONNECTOR_NAME=
CHAOP_FIRST_CONNECTOR_HOSTNAME=
CHAOP_FIRST_WORKSPACE_ROOT=
CHAOP_DAILY_BUDGET_UNITS=3846
CHAOP_4H_SOFT_BUDGET_UNITS=481
CHAOP_4H_HARD_BUDGET_UNITS=641
CHAOP_BURST_EVENTS_PER_MINUTE=384
CF_TELEMETRY_ACCOUNT_ID=
CF_TELEMETRY_API_WORKER=chaop-api
CF_TELEMETRY_WEB_WORKER=chaop-web
CF_TELEMETRY_D1_DATABASE_ID=
CF_TELEMETRY_DO_NAMESPACE_NAME=WorkspaceDO
CF_TELEMETRY_CACHE_SECONDS=300
```

Provide these secrets through a secure channel only:

```text
CLOUDFLARE_API_TOKEN=
AGENT_BOOTSTRAP_SECRET=
CF_ACCESS_CLIENT_ID=
CF_ACCESS_CLIENT_SECRET=
CF_TELEMETRY_API_TOKEN=
```

### Deployment-instance values

Do not commit deployment-instance values to this repository, even when they are not API secrets. This includes Cloudflare account IDs, zone IDs, Access AUDs, personal or private hostnames, allowlisted email addresses, connector hostnames, and local workspace paths.

Keep deployment-instance values in one of these places:

- a local ignored file such as `.env.cloudflare.local`;
- a password manager;
- a private deployment repository or private deployment subrepo.

The first implementation pass will derive resource names from the prefix unless you override them:

```text
Worker name: chaop-api
D1 database: chaop-control
R2 bucket: chaop-artifacts
Durable Object class: WorkspaceDO
```

### Create a Cloudflare API token

Use a scoped Cloudflare API token, not the global API key.

For the first slice, the token needs these dashboard permission groups:

Account permissions on the selected Cloudflare account:

```text
Workers Scripts: Edit
D1: Edit
Workers R2 Storage: Edit
Account Settings: Read
```

Zone permissions on the selected Cloudflare zone:

```text
Workers Routes: Edit
Zone: Read
DNS: Edit
```

Cloudflare's API permission reference may show `Write` where the dashboard shows `Edit`; treat those as the same permission family for this setup. If you do not see an entry named "Worker deploy", use `Workers Scripts: Edit` instead; that is the Worker script deployment permission group.

`DNS: Edit` is included because Worker Custom Domains create DNS records for the hostname. If you choose to configure every DNS record manually and avoid Wrangler-managed Custom Domains, you can narrow that later.

Optional permission:

```text
Workers Tail: Read
```

Add this only if you want the same token to run `wrangler tail`.

If Cloudflare Access is configured manually in the dashboard, the Wrangler deploy token does not need Access application administration rights.

If Access should also be automated later, create a separate Access administration token instead of widening the deployment token.

### Create an Access service token for smoke tests

For command-line E2E smoke tests, create a Cloudflare Access service token and add it to the Access application policy for the browser-facing API routes.

Use the Zero Trust dashboard:

1. Go to Access service tokens.
2. Create a token for operator or CI smoke tests.
3. Copy the client ID and client secret once.
4. Add an Access policy that allows this service token on the Browser API application.

Store the values outside the repository:

```text
CF_ACCESS_CLIENT_ID=...
CF_ACCESS_CLIENT_SECRET=...
```

Treat both values as secrets. A service token request should pass these headers:

```bash
curl \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  https://api.example.com/api/bootstrap
```

The Worker accepts Access JWTs that contain either a user email or a service-token identity claim. Service-token identities are mapped to synthetic `@service.chaop.local` users for smoke-test auditability.

### Local configuration file

After the repo contains the deployment scripts, create a local ignored file such as:

```text
.env.cloudflare.local
```

Use this shape:

```text
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ZONE_ID=...
CHAOP_RESOURCE_PREFIX=chaop
CHAOP_GUI_DOMAIN=app.example.com
CHAOP_API_DOMAIN=api.example.com
VITE_CHAOP_API_BASE_URL=https://api.example.com
ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
ACCESS_AUD=...
CF_ACCESS_CLIENT_ID=...
CF_ACCESS_CLIENT_SECRET=...
CHAOP_ACCESS_ALLOWED_EMAILS=you@example.com
CHAOP_ACCESS_ALLOWED_GROUPS=
CHAOP_FIRST_CONNECTOR_NAME=mac-studio
CHAOP_FIRST_CONNECTOR_HOSTNAME=mac-studio.local
CHAOP_FIRST_WORKSPACE_ROOT=/Users/you/Program
CHAOP_DAILY_BUDGET_UNITS=3846
CHAOP_4H_SOFT_BUDGET_UNITS=481
CHAOP_4H_HARD_BUDGET_UNITS=641
CHAOP_BURST_EVENTS_PER_MINUTE=384
CF_TELEMETRY_ACCOUNT_ID=...
CF_TELEMETRY_API_WORKER=chaop-api
CF_TELEMETRY_WEB_WORKER=chaop-web
CF_TELEMETRY_D1_DATABASE_ID=...
CF_TELEMETRY_DO_NAMESPACE_NAME=WorkspaceDO
CF_TELEMETRY_CACHE_SECONDS=300
```

Do not commit this file.

### Local development

The checked-in Worker config keeps `CHAOP_DEV_ALLOW_INSECURE=false` for production safety. The `pnpm dev:worker` script builds the protocol package, applies local D1 migrations, and injects `CHAOP_DEV_ALLOW_INSECURE=true` for local development so the Vite GUI can use the `x-chaop-dev-user` header through the local proxy. It also injects the local-only bootstrap secret `local-dev-bootstrap-secret`.

For manual Wrangler runs, copy the example file and replace local-only values:

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

Do not use `.dev.vars` values in production.

### Create Cloudflare resources

These commands are the intended shape once the monorepo scripts and Wrangler dependency exist:

```bash
pnpm wrangler d1 create chaop-control
pnpm wrangler r2 bucket create chaop-artifacts
```

The D1 command returns a database UUID. Put that UUID into the Worker Wrangler configuration as the D1 binding. The R2 bucket name is used as the R2 binding.

The Worker configuration points Wrangler at the repository D1 migration directory:

```text
apps/worker/wrangler.jsonc -> d1_databases[0].migrations_dir = ../../migrations/d1
```

After the D1 database UUID is in the Worker configuration, apply the schema:

```bash
pnpm --filter @chaop/worker exec wrangler d1 migrations apply chaop-control --config wrangler.jsonc --remote
```

The Worker configuration should then bind:

```text
DB -> chaop-control
ARTIFACTS -> chaop-artifacts
WorkspaceDO -> Durable Object namespace
```

### Deploy the API Worker from the ops repository

Keep deployment-instance values and local secret material in the private ops repository, not in this repository:

```text
../<private-ops-repo>/deployments/<environment>/chaop.env
../<private-ops-repo>/secrets/cloudflare-deploy.token
../<private-ops-repo>/secrets/cloudflare-telemetry.token
```

Use the checked-in API deployment script once the private deployment profile contains the required non-secret values:

```bash
CLOUDFLARE_API_TOKEN="$(tr -d '\r\n' < ../<private-ops-repo>/secrets/cloudflare-deploy.token)" \
CHAOP_DEPLOY_ENV_FILE=../<private-ops-repo>/deployments/<environment>/chaop.env \
CF_TELEMETRY_WEB_WORKER=chaop-web \
CF_TELEMETRY_DO_NAMESPACE_NAME=WorkspaceDO \
pnpm deploy:api
```

The deployment profile contains deployment-instance values such as domains, resource names, D1/R2 bindings, and Access configuration. The deploy token stays as an ignored file under the private ops repository's `secrets/` directory and is passed only to the current Wrangler process. The script writes a temporary Wrangler config under `.codex-tmp/deploy/api/`, applies remote D1 migrations, then deploys the API Worker.

The generated Worker runtime vars include `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. They are required because the Worker verifies Cloudflare Access JWTs after Access forwards an authenticated browser or service-token request.

The generated Worker runtime vars also include non-secret Cloudflare telemetry selectors when they are available:

```text
CF_TELEMETRY_ACCOUNT_ID
CF_TELEMETRY_API_WORKER
CF_TELEMETRY_WEB_WORKER
CF_TELEMETRY_D1_DATABASE_ID
CF_TELEMETRY_DO_NAMESPACE_NAME
CF_TELEMETRY_TIMEOUT_MS
CF_TELEMETRY_CACHE_SECONDS
```

The API deploy script defaults `CF_TELEMETRY_ACCOUNT_ID` from `CLOUDFLARE_ACCOUNT_ID`, `CF_TELEMETRY_API_WORKER` from the deployed API Worker name, and `CF_TELEMETRY_D1_DATABASE_ID` from `CHAOP_D1_DATABASE_ID`. Set `CF_TELEMETRY_WEB_WORKER` when the GUI Worker has a separate script name. Set `CF_TELEMETRY_DO_NAMESPACE_NAME` to the Durable Object analytics `name` dimension, normally `WorkspaceDO`, if you want incoming WebSocket message counts folded into Durable Object request equivalents. `CF_TELEMETRY_TIMEOUT_MS` defaults to 5000 milliseconds. `CF_TELEMETRY_CACHE_SECONDS` defaults to 300 seconds, with failed queries retried after at most 60 seconds. Keep the token itself as a Worker secret, not as a Wrangler var.

### Configure split domains

Use two hostnames:

```text
GUI: app.example.com
API: api.example.com
```

Build the web app with `VITE_CHAOP_API_BASE_URL=https://api.example.com`, and configure the Worker runtime with `CHAOP_API_DOMAIN=api.example.com`. The GUI uses the Vite value for browser fetches; the Worker uses the runtime value when issuing connector control URLs.

Deploy the Browser GUI static Worker with:

```bash
VITE_CHAOP_API_BASE_URL=https://api.example.com pnpm deploy:web
```

The script writes a temporary Wrangler static-assets config under `.codex-tmp/deploy/web/` and deploys the `chaop-web` Worker by default. It explicitly disables `workers.dev` and preview URLs, so production access must come through the Cloudflare-managed custom domain or route that is covered by Access. Override the Worker name with `CHAOP_WEB_WORKER_NAME` when a deployment uses a different static Worker.

The API hostname serves:

```text
/api/*
/connector/bootstrap
/ws/browser
/ws/agent
```

Browser routes under `/api/*` and `/ws/browser` are protected by Cloudflare Access. Agent bootstrap and agent WebSocket routes are authenticated by Worker-level bootstrap/agent tokens, not by Access, in the first slice.

The current Browser command submission sends JSON as `text/plain; charset=utf-8` so that the cross-origin credentialed `POST /api/commands` remains a simple request and does not need an Access preflight path. If a later slice adds custom browser headers or switches command submission back to `application/json`, configure Cloudflare Access and the Worker route so `OPTIONS /api/*` can reach the Worker and return the configured CORS response.

### Configure Cloudflare Access

Create a self-hosted Access application for the GUI and browser-facing API routes.

Record:

```text
Team domain
Application AUD
Allowed email addresses or groups
```

Use the Cloudflare Zero Trust dashboard:

1. Create a self-hosted application and add the GUI public hostname.
2. Add the API public hostname for Browser traffic with `/api/*` and `/ws/browser` coverage.
3. Add an Allow policy with the `Emails` include selector for the operator email addresses, or use a deliberate Access group selector once identity-provider groups are configured.
4. Copy the application AUD into `ACCESS_AUD`.

The Worker must validate `Cf-Access-Jwt-Assertion` for Browser HTTP and WebSocket requests. Cloudflare documents that Access passes this token in the request header, and browser requests may also include a `CF_Authorization` cookie. The Worker should prefer the header.

If a Browser write action returns `401 Missing Cloudflare Access JWT`, the most likely cause is that the new API path is not covered by the Access application destination. Add `/api/*` for the API hostname, then refresh the GUI session.

For the current implementation, Cloudflare Access policy is the source of truth for allowed Browser users. `CHAOP_ACCESS_ALLOWED_EMAILS` and `CHAOP_ACCESS_ALLOWED_GROUPS` document the deployment intent and are available for a later Worker-level allowlist, but the Worker does not enforce them yet.

Do not put `/connector/bootstrap` or `/ws/agent` behind this Browser Access application unless we later decide to use Access service tokens for connectors. The connector bootstrap path intentionally lives outside `/api/*` so broad Browser Access protection does not wrap connector registration.

Connector bootstrap uses `AGENT_BOOTSTRAP_SECRET` only to register a connector identity. The Worker then issues a random connector token and stores only its SHA-256 hash in D1. Re-running bootstrap with the same connector name and hostname keeps the same connector identity and rotates the connector token; replace the local connector token file with the newest value. Older duplicate connector rows from pre-stable identity builds are retired automatically.

### Write Worker secrets

Use Wrangler secrets for runtime secrets:

```bash
pnpm wrangler secret put AGENT_BOOTSTRAP_SECRET
pnpm wrangler secret put ACCESS_AUD
pnpm wrangler secret put ACCESS_TEAM_DOMAIN
```

The implementation may store non-secret config in Wrangler vars, but secrets stay in Cloudflare secret storage.

Cloudflare telemetry is optional. To enable it, create a separate read-only Cloudflare API token with this account permission:

```text
Account Analytics: Read
```

Do not reuse the deployment token for runtime telemetry unless you accept that the Worker would hold deploy-capable permissions. After the first API deploy has generated `.codex-tmp/deploy/api/wrangler.jsonc`, write the telemetry token as a Worker secret:

```bash
CLOUDFLARE_API_TOKEN="$(tr -d '\r\n' < ../<private-ops-repo>/secrets/cloudflare-deploy.token)" \
pnpm --filter @chaop/worker exec wrangler secret put CF_TELEMETRY_API_TOKEN \
  --config .codex-tmp/deploy/api/wrangler.jsonc \
  < ../<private-ops-repo>/secrets/cloudflare-telemetry.token
```

Then redeploy the API Worker so the runtime environment and secret revision are active:

```bash
CLOUDFLARE_API_TOKEN="$(tr -d '\r\n' < ../<private-ops-repo>/secrets/cloudflare-deploy.token)" \
CHAOP_DEPLOY_ENV_FILE=../<private-ops-repo>/deployments/<environment>/chaop.env \
CF_TELEMETRY_WEB_WORKER=chaop-web \
CF_TELEMETRY_DO_NAMESPACE_NAME=WorkspaceDO \
pnpm deploy:api
```

### Prepare the first connector

The connector needs a local config file with:

```toml
connector_name = "mac-studio"
control_url = "wss://api.example.com/ws/agent"
bootstrap_url = "https://api.example.com/connector/bootstrap"
workspace_root = "/Users/you/Program"
token_file = "/Users/you/.chaop/connector.token"
spool_db = "/Users/you/.chaop/connector-spool.sqlite"

[bootstrap]
secret_file = "/Users/you/.chaop/bootstrap.secret"

[execution]
mode = "placeholder"
codex_command = "codex"
codex_sandbox = "read-only"
codex_timeout_seconds = 300
codex_output_max_bytes = 262144

[session_inventory]
enabled = true
max_sessions = 100
report_interval_seconds = 60
app_server_timeout_seconds = 2
# codex_home = "/Users/you/.codex"
# app_server_url = "unix:///path/to/private/app-server.sock"
# app_server_auth_token_file = "/path/to/private/app-server.token"

[session_inventory.managed_app_server]
enabled = false
# listen_url = "unix:///path/to/private/app-server.sock"
# extra_args = []
startup_timeout_seconds = 10
restart_backoff_seconds = 5
```

`mode = "placeholder"` is the safe default. To run real local Codex work, prefer the app-server adapter in a private deployment config.

For the private Codex CLI fallback:

```toml
[execution]
mode = "codex_exec"
codex_command = "/opt/homebrew/bin/codex"
codex_sandbox = "read-only"
codex_timeout_seconds = 300
codex_output_max_bytes = 262144
```

Do not expose this as the default Browser execution path. The GUI hides the CLI fallback unless the Web build explicitly sets `VITE_CHAOP_SHOW_CODEX_CLI_FALLBACK=true`; production deployments should leave that unset.

For the Codex app-server adapter:

```toml
[execution]
mode = "app_server"
codex_timeout_seconds = 300

[session_inventory]
app_server_timeout_seconds = 2

[session_inventory.managed_app_server]
enabled = true
listen_url = "unix:///path/to/private/app-server.sock"
extra_args = []
startup_timeout_seconds = 10
restart_backoff_seconds = 5
drain_timeout_seconds = 300
```

Optional execution settings:

```toml
codex_profile = "default"
codex_model = "gpt-5.5"
extra_args = ["--skip-git-repo-check"]
```

Optional managed app-server settings:

```toml
[session_inventory.managed_app_server]
extra_args = ["--ws-project-doc-max-bytes", "131072"]
scheduled_restart_interval_seconds = 86400
upgrade_marker_file = "/path/to/private/app-server-upgrade.marker"
```

Only add optional settings when the local Codex CLI needs them. `execution.extra_args` is reserved for `codex exec` fallback flags; use `session_inventory.managed_app_server.extra_args` for flags that are valid on `codex app-server`. `scheduled_restart_interval_seconds = 0` disables periodic restarts; any positive value schedules a managed restart after that interval. `upgrade_marker_file` is optional and should point to a private local file outside the repository. Touch that file after upgrading the local Codex CLI or changing app-server runtime assets to ask the connector to drain and restart the managed listener. `app_server` and the private `codex_exec` fallback can both consume Codex/OpenAI allowance or API budget; set the alerts in [Cost Model](cost-aware.md) before leaving real execution running unattended. The Budget Board reads Chaop's bounded D1 posture signals; it does not replace Cloudflare or OpenAI billing alerts.
Prompts are passed to Codex over stdin, not command-line arguments. Keep the timeout and output cap in place unless there is a specific operator reason to widen them.
Use an absolute `codex_command` path for long-lived connectors launched by `launchctl` or another service manager. Those processes may not inherit the interactive shell `PATH`; if the executable cannot be found, private CLI fallback commands fail before any workspace `cwd` is used.

Session inventory is enabled by default. The connector reads local Codex metadata from `CODEX_HOME` or `~/.codex`, reports session id, title, cwd, update time, and title source, and does not upload rollout transcripts during ordinary inventory reports. Title resolution prefers metadata or rollout titles, then optional app-server `Thread.name`, then a recent local history prompt, and finally a cwd/session-id fallback. Setting `session_inventory.enabled = false` disables both host session inventory and host session history backfill capability.

When a user explicitly attaches a Host Session, the Worker asks that session's connector for a bounded history backfill for that single session. The connector reads the matching local rollout, skips injected developer/context records, reasoning records, and tool output records, and returns short user, assistant, and tool-call summaries only. If no rollout is found, it falls back to a recent `history.jsonl` prompt for that session. Imported events keep the original local event timestamp, so old backfilled history does not crowd out newer control-plane events in the global recent-event feed. Backfill failures do not block the attachment; the Browser shows the attached thread and reports the backfill warning separately.

Use `session_inventory.managed_app_server.enabled = true` when Chaop should manage one dedicated local Codex app-server listener for this connector. The connector starts `codex app-server` with the configured `execution.codex_profile`, `execution.codex_model`, `session_inventory.managed_app_server.extra_args`, and `--listen <listen_url>` when the listener is absent, health-checks the listener before advertising app-server capabilities, and retries after `restart_backoff_seconds` if the child exits or fails startup. On Unix hosts, prefer an absolute `unix:///path/to/private/app-server.sock` URL inside a private directory that model-invoked tools cannot access. The connector also accepts WebSocket listeners bound to `localhost`, `127.0.0.1`, or `::1`, and refuses non-loopback hosts instead of exposing the app-server protocol to a LAN interface. Loopback is not an authentication boundary: the connector never sends an app-server Bearer token over plaintext `ws://`, including loopback. Authenticated external listeners must use certificate-validated `wss://` with `session_inventory.app_server_auth_token_file`; keep that private file outside the workspace and deny tool access to it. If you already manage the listener with another service manager, leave managed mode disabled and set `session_inventory.app_server_url` to the external listener instead.

In managed mode, the connector advertises `app_server_threads` and `app_server_archive` only while the managed app-server URL is healthy enough to initialise the protocol, and advertises `codex_app_server_exec` plus `host_session_app_server_ensure` only when that URL is healthy and `execution.mode = "app_server"`. It refreshes those capabilities through `agent.ready` after connecting to the Worker, so a degraded managed listener stops being selected for new app-server work. With an externally managed `session_inventory.app_server_url`, capability advertisement follows the configured URL and the external service manager is responsible for keeping the listener healthy. This is separate from the CLI-only `codex_exec` capability. The Worker rejects new local thread requests when no online app-server connector has `app_server_threads`. Attached app-server command execution requires the owning connector to advertise `codex_app_server_exec`; Chaop rejects command creation or leasing instead of falling back to `codex_exec` on a different connector. Host Session attach only sends the app-server resume/ensure control message when the connector advertises `host_session_app_server_ensure`; older app-server execution connectors keep the D1-only attach path instead of timing out on an unknown control envelope. Archive/unarchive remains D1-only when the connector does not advertise `app_server_archive`; when it does, Chaop updates D1 first, then the connector resolves the stored Codex session id to an app-server thread id before calling `thread/archive` or `thread/unarchive`. Sync failures are returned to the Browser as warnings instead of blocking the local archive state. Keep `app_server_timeout_seconds` short so a stopped app-server cannot stall connector startup, thread creation, command setup, Host Session attach, or archive synchronisation longer than necessary.

When a scheduled or upgrade-marker restart is pending, the connector reports the managed instance as `draining` and temporarily removes app-server execution/thread/archive capabilities from `agent.ready`. That keeps the control plane from assigning new app-server work while existing active turns finish. Once `active_turn_count` reaches zero, the connector restarts the managed listener, health-checks it, then advertises app-server capabilities again and resumes ordinary inventory reports. If active turns do not finish before `drain_timeout_seconds`, the connector forces the restart and reports the timeout in AppServerInstance state. Keep the drain timeout long enough for normal turns, but finite enough that an abandoned turn cannot block an upgrade forever.

New local threads always start in the connector's configured `workspace_root`; the Browser API does not accept or forward an arbitrary cwd.
App-server command execution only runs against a Chaop thread/task attached to a local app-server Host Session. The Worker includes the attached local session id and cwd in `command.dispatch`, and the connector resolves the session to the current app-server thread id before calling `thread/resume` and `turn/start` from that cwd. Command setup can paginate through the app-server thread list under `codex_timeout_seconds`; cancellation or timeout best-effort sends `turn/interrupt` when a turn id is known or can still be recovered from the `turn/start` response. Chaop records lifecycle events and the final assistant message summary only; local commandExecution output is not uploaded by default.
Archive/unarchive synchronisation only applies to Chaop tasks that are attached to a Host Session and can be resolved in the app-server thread list. Local-only Chaop tasks and history-only Host Sessions still archive only in D1. The connector does not modify local history files for this flow; it talks to the app-server protocol.

If you do not use managed mode, prefer a private Unix socket outside the workspace:

```bash
codex app-server --listen unix:///path/to/private/app-server.sock
```

Then set the matching private connector config:

```toml
[session_inventory]
app_server_url = "unix:///path/to/private/app-server.sock"
```

Host Session inventory is demand-driven by default. The connector does not periodically rescan local Codex sessions while idle; the Host Sessions refresh button asks online connectors to rescan and report immediately, and the Browser can opt into a one-minute auto-refresh while the Host Sessions page is open. The Durable Object debounces refresh requests per connector, so multiple browser listeners do not increase connector rescan frequency. User actions that create, attach, archive, or otherwise mutate local sessions may still trigger one immediate inventory report to keep the UI coherent. `report_interval_seconds` is retained for private compatibility and future connector-side auto modes, but it is not the default idle polling path. App-server inventory reports are treated as complete only when the app-server list call succeeds, all `thread/list` pages are exhausted, and the combined Host Session report is not truncated by `max_sessions`; transient app-server list failures or truncated reports do not clear known app-server presence for existing Host Sessions. Immediate inventory reports after local thread creation or app-server ensure are incremental, so a lagging app-server state database cannot clear the exact session already returned to and persisted by the Browser API. A later operator-requested complete report can still clear a genuinely unavailable app-server session.

Create local files outside the repository:

```bash
mkdir -p ~/.chaop
chmod 700 ~/.chaop
```

Then place the bootstrap secret in `~/.chaop/bootstrap.secret` with file permissions readable only by your user.

After the Worker is deployed, run connector bootstrap to exchange the bootstrap secret for a connector token. The current agent CLI prints the bootstrap request body; it does not post the request or write the token file by itself yet. Run the supported manual exchange from the repository checkout:

```bash
export CHAOP_API_DOMAIN="api.example.com"
export CHAOP_AGENT_CONFIG="/path/to/agent.toml"
export CHAOP_HOSTNAME="$(hostname)"
export CHAOP_BOOTSTRAP_SECRET="$(cat ~/.chaop/bootstrap.secret)"

cargo run -p chaop-agent -- --config "$CHAOP_AGENT_CONFIG" --hostname "$CHAOP_HOSTNAME" \
  | curl -fsS "https://$CHAOP_API_DOMAIN/connector/bootstrap" \
      -H "content-type: application/json" \
      -H "x-chaop-bootstrap-secret: $CHAOP_BOOTSTRAP_SECRET" \
      --data-binary @- \
  | node -e 'let s = ""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => { const body = JSON.parse(s); if (!body.token) { console.error(s); process.exit(1); } process.stdout.write(body.token + "\n"); });' \
  > ~/.chaop/connector.token

chmod 600 ~/.chaop/connector.token
unset CHAOP_BOOTSTRAP_SECRET
```

Store the returned connector token at the `token_file` path in the connector config. The Worker stores only the token hash in D1. If you need to inspect the bootstrap response for `connector_id` or `control_url`, run the same command without the final `node` extraction and redirect the response to a local private file outside the repository.

For daily dogfooding, run the persistent connector through the checked-in operator script documented in the [Dogfood Connector Runbook](dogfood-runbook.md):

```bash
export CHAOP_AGENT_CONFIG="/path/to/agent.toml"
pnpm dogfood:connector -- start
pnpm dogfood:connector -- status
```

The script keeps PID and log state in `${XDG_STATE_HOME:-$HOME/.local/state}/chaop/dogfood/` by default, not in `/tmp`.

For a narrow one-command smoke test, use:

```bash
pnpm dogfood:connector -- once
```

For ad-hoc development without the persistent wrapper, the raw connector command is still:

```bash
cargo run -p chaop-agent -- --config /path/to/agent.toml --connect
```

### What I need from you

For the next implementation pass, keep deployment-instance values outside this repository. Put non-secret instance values in the private deployment repository or local ignored env file, and put secrets in the secure channel we agree on.

Minimum required set:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_ZONE_ID
CHAOP_GUI_DOMAIN
CHAOP_API_DOMAIN
VITE_CHAOP_API_BASE_URL
ACCESS_TEAM_DOMAIN
ACCESS_AUD
CLOUDFLARE_API_TOKEN
AGENT_BOOTSTRAP_SECRET
CF_ACCESS_CLIENT_ID
CF_ACCESS_CLIENT_SECRET
CHAOP_FIRST_CONNECTOR_NAME
CHAOP_FIRST_WORKSPACE_ROOT
```

### Troubleshooting

- If Wrangler cannot authenticate, check `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- If the Browser gets `403`, check the Access application AUD, team domain, and allowed user policy.
- If service-token smoke tests get `401` from the Worker with an identity error, check that the Access policy allows the service token and that the service-token headers reach the API route.
- If Browser command submission fails before reaching the Worker, check whether the request has become a CORS preflight and either keep the simple request shape or allow `OPTIONS /api/*` through Cloudflare Access.
- If the connector gets `401`, check `AGENT_BOOTSTRAP_SECRET` and whether `/connector/bootstrap` and `/ws/agent` are excluded from Browser Access.
- If the private CLI fallback returns `Codex executable not found`, set `execution.codex_command` to an absolute path that the connector process can execute, for example `/opt/homebrew/bin/codex` on this macOS deployment. This is separate from the attached session `cwd`.
- If app-server execution fails before the turn starts, check that `execution.mode = "app_server"`, `session_inventory.app_server_url` is set, the target Chaop thread is attached to an app-server Host Session, and the app-server is running on the configured listener. For an authenticated external listener, also confirm that the URL uses certificate-validated `wss://` and that `session_inventory.app_server_auth_token_file` points to the expected non-empty token.
- If the connector connects but never receives commands, check that connector bootstrap has seeded workspace membership, that the command targets an executable connector, and that `WorkspaceDO` is bound in the deployed Worker.
- If New local thread fails with an app-server error, check that the configured Unix socket exists in its private directory, `session_inventory.app_server_url` matches it, and the connector was restarted after the config change. For a WebSocket deployment, confirm the listener and URL use the same scheme, host, and port; Bearer tokens are rejected over plaintext `ws://`.
- If Host Sessions is empty or stale, use the Host Sessions refresh button, wait up to `session_inventory.report_interval_seconds`, check that the connector was restarted after this slice, `session_inventory.enabled` is true, and the connector user can read `CODEX_HOME` or `~/.codex`.
- If an attached historical Host Session still shows only a few events, check that the connector user can read the matching `~/.codex/sessions/**/rollout-*.jsonl` file. Backfill is intentionally bounded to short summaries for one explicitly attached session; full transcript and artefact capture are still deferred.
- If D1 migration fails, confirm the D1 database UUID is present in the Worker config.
- If R2 writes fail, confirm the bucket exists and the Worker binding name matches the implementation.
