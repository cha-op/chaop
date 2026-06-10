[ British English | [简体中文](deployment-guide.zh-Hans.md) ]

# Deployment Guide

### Purpose

This guide explains how to prepare the Cloudflare and connector configuration for the first deployment slice of the Codex app-server control plane.

The first slice is Cloudflare-first, but it still uses a placeholder Rust connector. It prepares the control-loop shape before connecting to the real Codex app-server:

```text
Browser GUI -> Cloudflare Access -> Worker / Durable Object -> D1 / R2 -> Rust connector -> Worker / Durable Object -> Browser GUI
```

Current implementation status: the repository has local skeletons, bindings, schema, authentication checks, sample data, and placeholder command acceptance. It does not yet persist command lifecycle rows in D1, relay commands through the Durable Object, or execute commands through the Rust connector. Treat those behaviours as the next deployment slice, not as completed production behaviour.

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
```

The first implementation pass will derive resource names from the prefix unless you override them:

```text
Worker name: chaop-api
D1 database: chaop-control
R2 bucket: chaop-artifacts
Durable Object class: WorkspaceDO
```

### Create a Cloudflare API token

Use a scoped Cloudflare API token, not the global API key.

For the first slice, the token needs enough access to:

- deploy the Worker;
- create or bind D1;
- create or bind R2;
- configure the Worker route for the API domain;
- read the account/zone metadata needed by Wrangler.

If Cloudflare Access is configured manually in the dashboard, the Wrangler deploy token does not need Access application administration rights.

If Access should also be automated later, create a separate Access administration token instead of widening the deployment token.

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
/ws/browser
/ws/agent
```

Browser routes are protected by Cloudflare Access. Agent bootstrap and agent WebSocket routes are authenticated by Worker-level bootstrap/agent tokens, not by Access, in the first slice.

The current Browser command submission sends JSON as `text/plain; charset=utf-8` so that the cross-origin credentialed `POST /api/commands` remains a simple request and does not need an Access preflight path. If a later slice adds custom browser headers or switches command submission back to `application/json`, configure Cloudflare Access and the Worker route so `OPTIONS /api/*` can reach the Worker and return the configured CORS response.

### Configure Cloudflare Access

Create a self-hosted Access application for the GUI and browser-facing API routes.

Record:

```text
Team domain
Application AUD
Allowed email addresses or groups
```

The Worker must validate `Cf-Access-Jwt-Assertion` for Browser HTTP and WebSocket requests. Cloudflare documents that Access passes this token in the request header, and browser requests may also include a `CF_Authorization` cookie. The Worker should prefer the header.

Do not put `/api/agent/bootstrap` or `/ws/agent` behind this Browser Access application unless we later decide to use Access service tokens for connectors.

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

The placeholder connector will need a local config file with:

```toml
connector_name = "mac-studio"
control_url = "wss://api.example.com/ws/agent"
bootstrap_url = "https://api.example.com/api/agent/bootstrap"
workspace_root = "/Users/you/Program"
token_file = "/Users/you/.chaop/connector.token"
spool_db = "/Users/you/.chaop/connector-spool.sqlite"

[bootstrap]
secret_file = "/Users/you/.chaop/bootstrap.secret"
```

Create local files outside the repository:

```bash
mkdir -p ~/.chaop
chmod 700 ~/.chaop
```

Then place the bootstrap secret in `~/.chaop/bootstrap.secret` with file permissions readable only by your user.

### What I need from you

For the next implementation pass, send the non-secret values directly in the thread and put the secrets in the secure channel we agree on.

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
CHAOP_FIRST_CONNECTOR_NAME
CHAOP_FIRST_WORKSPACE_ROOT
```

### Troubleshooting

- If Wrangler cannot authenticate, check `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- If the Browser gets `403`, check the Access application AUD, team domain, and allowed user policy.
- If Browser command submission fails before reaching the Worker, check whether the request has become a CORS preflight and either keep the simple request shape or allow `OPTIONS /api/*` through Cloudflare Access.
- If the connector gets `401`, check `AGENT_BOOTSTRAP_SECRET` and whether the Worker route excludes Browser Access.
- If D1 migration fails, confirm the D1 database UUID is present in the Worker config.
- If R2 writes fail, confirm the bucket exists and the Worker binding name matches the implementation.
