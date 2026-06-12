[ British English | [简体中文](deployment-guide.zh-Hans.md) ]

# Deployment Guide

### Purpose

This guide explains how to prepare the Cloudflare and connector configuration for the first deployment slice of the Codex control plane.

The first slice is Cloudflare-first. The Rust connector supports placeholder execution by default and can opt in to local `codex exec` execution through private connector configuration:

```text
Browser GUI -> Cloudflare Access -> Worker / Durable Object -> D1 / R2 -> Rust connector -> Worker / Durable Object -> Browser GUI
```

Current implementation status: the repository can persist command lifecycle rows in D1, dispatch pending commands through the Durable Object, receive lifecycle events from the Rust connector, and attach local Codex sessions as task/thread views. It can run local Codex CLI work only when the connector has `execution.mode = "codex_exec"` in private configuration. It can optionally read Codex app-server `Thread.name` values for session titles, but it does not yet use the experimental app-server protocol for execution. R2 artefact capture is still reserved for a later slice.

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
CHAOP_DAILY_BUDGET_UNITS=100
CHAOP_4H_SOFT_BUDGET_UNITS=20
CHAOP_4H_HARD_BUDGET_UNITS=35
CHAOP_BURST_EVENTS_PER_MINUTE=600
```

Provide these secrets through a secure channel only:

```text
CLOUDFLARE_API_TOKEN=
AGENT_BOOTSTRAP_SECRET=
CF_ACCESS_CLIENT_ID=
CF_ACCESS_CLIENT_SECRET=
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
CHAOP_DAILY_BUDGET_UNITS=100
CHAOP_4H_SOFT_BUDGET_UNITS=20
CHAOP_4H_HARD_BUDGET_UNITS=35
CHAOP_BURST_EVENTS_PER_MINUTE=600
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

### Configure split domains

Use two hostnames:

```text
GUI: app.example.com
API: api.example.com
```

Build the web app with `VITE_CHAOP_API_BASE_URL=https://api.example.com`, and configure the Worker runtime with `CHAOP_API_DOMAIN=api.example.com`. The GUI uses the Vite value for browser fetches; the Worker uses the runtime value when issuing connector control URLs.

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

Do not put `/connector/bootstrap` or `/ws/agent` behind this Browser Access application unless we later decide to use Access service tokens for connectors. `/api/agent/bootstrap` is kept only as a legacy migration alias; prefer `/connector/bootstrap` because broad `/api/*` Browser Access protection will also cover the legacy path.

Connector bootstrap uses `AGENT_BOOTSTRAP_SECRET` only to register a connector identity. The Worker then issues a random connector token and stores only its SHA-256 hash in D1. Re-running bootstrap creates a fresh connector identity and token; replace the local connector token file and retire the old connector record in a later management flow.

### Write Worker secrets

Use Wrangler secrets for runtime secrets:

```bash
pnpm wrangler secret put AGENT_BOOTSTRAP_SECRET
pnpm wrangler secret put ACCESS_AUD
pnpm wrangler secret put ACCESS_TEAM_DOMAIN
```

The implementation may store non-secret config in Wrangler vars, but secrets stay in Cloudflare secret storage.

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
app_server_timeout_seconds = 2
# codex_home = "/Users/you/.codex"
# app_server_url = "ws://127.0.0.1:9876"
```

`mode = "placeholder"` is the safe default. To run real local Codex CLI work, set this only in a private deployment config:

```toml
[execution]
mode = "codex_exec"
codex_command = "codex"
codex_sandbox = "read-only"
codex_timeout_seconds = 300
codex_output_max_bytes = 262144
```

Optional execution settings:

```toml
codex_profile = "default"
codex_model = "gpt-5.5"
extra_args = ["--skip-git-repo-check"]
```

Only add optional settings when the local Codex CLI needs them. `codex_exec` can consume Codex/OpenAI allowance or API budget; set the alerts in [Cost Model](cost-aware.md) before leaving it running unattended.
Prompts are passed to Codex over stdin, not command-line arguments. Keep the timeout and output cap in place unless there is a specific operator reason to widen them.

Session inventory is enabled by default. The connector reads local Codex metadata from `CODEX_HOME` or `~/.codex`, reports session id, title, cwd, update time, and title source, and does not upload rollout transcripts. Title resolution prefers metadata or rollout titles, then optional app-server `Thread.name`, then the first local history prompt, and finally a cwd/session-id fallback. Set `app_server_url` only if you already run `codex app-server` with a local WebSocket listener and want Chaop to use app-server titles. Keep `app_server_timeout_seconds` short so a stopped app-server cannot block connector startup.

Create local files outside the repository:

```bash
mkdir -p ~/.chaop
chmod 700 ~/.chaop
```

Then place the bootstrap secret in `~/.chaop/bootstrap.secret` with file permissions readable only by your user.

After the Worker is deployed, run connector bootstrap to exchange the bootstrap secret for a connector token. Store the returned connector token at the `token_file` path in the connector config. The Worker stores only the token hash in D1.

Run the connector loop with:

```bash
cargo run -p chaop-agent -- --config /path/to/agent.toml --connect
```

For a one-command smoke test, use:

```bash
cargo run -p chaop-agent -- --config /path/to/agent.toml --connect --run-once
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
- If the connector connects but never receives commands, check that connector bootstrap has seeded workspace membership, that the command targets an executable connector, and that `WorkspaceDO` is bound in the deployed Worker.
- If Host Sessions is empty, check that the connector was restarted after this slice, `session_inventory.enabled` is true, and the connector user can read `CODEX_HOME` or `~/.codex`.
- If D1 migration fails, confirm the D1 database UUID is present in the Worker config.
- If R2 writes fail, confirm the bucket exists and the Worker binding name matches the implementation.
