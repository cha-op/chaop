[ British English | [简体中文](e2e-smoke.zh-Hans.md) ]

# E2E Smoke Guide

This guide records the low-cost deployed smoke test for Chaop. It assumes deployment-instance values and secrets live outside this repository.

## Scope

The default smoke avoids product write actions:

- confirm Cloudflare Access service-token authentication;
- confirm the API Worker returns JSON for `/api/health`, `/api/bootstrap`, and `/api/usage-summary`;
- confirm the Web Worker serves the deployed HTML and same-origin JavaScript and CSS assets;
- confirm a real browser can load the production GUI through Cloudflare Access cookies;
- inspect Budget Board posture without creating commands, refreshing Host Session inventory, or bootstrapping usage windows.

The `/api/usage-summary` check can still trigger the Worker to refresh Cloudflare telemetry and persist a best-effort `budget_telemetry_samples` cache row. Treat it as a low-cost smoke, not a zero-write smoke.

Avoid these actions during the default smoke unless the user explicitly asks for a write-path test:

- `POST /api/commands`;
- `POST /api/host-sessions/refresh`;
- `POST /api/budget/bootstrap`;
- attach, detach, archive, or unarchive actions;
- connector start-up or app-server turn execution.

## Required Local Inputs

Use ignored private files or a private deployment repository. The command examples expect these environment variables after sourcing private files:

```text
CHAOP_GUI_DOMAIN
VITE_CHAOP_API_BASE_URL
CF_ACCESS_CLIENT_ID
CF_ACCESS_CLIENT_SECRET
```

Never print the service-token secret. When summarising results, print status codes and selected response fields only.

## Tracked Runner

Use the tracked low-cost runner for ordinary deployment checks:

```bash
pnpm install
pnpm exec playwright install chromium

set -a
. path/to/deployment.env
. path/to/cloudflare-access-smoke.env
set +a

pnpm smoke:deployed
```

For machine-readable output:

```bash
pnpm smoke:deployed -- --json
```

For API, asset, and Budget Board checks without browser automation:

```bash
pnpm smoke:deployed -- --skip-browser
```

The runner fails the smoke when:

- API health, bootstrap, usage summary, GUI index, or referenced assets fail;
- browser rendering fails or the browser observes deployed `4xx` or `5xx` responses;
- Budget Board state is `hard_limited`;
- the sampled hard budget bottleneck is missing;
- sampled Cloudflare telemetry-backed hard constraints are missing;
- measured current-day D1 rows-written activity is missing;
- the bottleneck or daily D1 rows-written percentage exceeds the configured threshold.

Use `--allow-missing-telemetry` only for a known telemetry outage or a non-dogfood environment. The default dogfood gate should require Cloudflare telemetry so cost posture regressions are caught before broader testing.

## API And Asset Smoke

Use Cloudflare Access service-token headers for direct API and static asset requests:

```bash
set -a
. path/to/deployment.env
. path/to/cloudflare-access-smoke.env
set +a

curl -fsS \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  "$VITE_CHAOP_API_BASE_URL/api/health"
```

Expected checks:

- `/api/health` returns `200` JSON with `ok: true` and `service: "chaop-api"`.
- `/api/bootstrap` returns `200` JSON when sent with an allowed `Origin` header for the GUI domain.
- `/api/usage-summary` returns `200` JSON with sampled Cloudflare telemetry-backed constraints when telemetry is configured. The top-level `source` can remain `d1_usage_windows` when local usage windows also exist.
- The GUI index returns `200`.
- Every same-origin JavaScript and CSS asset referenced by the index returns `200` and a non-zero body. Off-origin assets are not fetched with Cloudflare Access service-token headers.

## Browser Smoke

Do not inject `CF-Access-Client-Id` and `CF-Access-Client-Secret` as browser extra headers for the GUI page. Browser fetches to the API are cross-origin, and those custom headers trigger a CORS preflight that Cloudflare Access may reject before the Worker can add CORS headers.

Use this shape instead:

1. Request the GUI domain with service-token headers and capture its `CF_Authorization` cookie.
2. Request the API domain with service-token headers and capture its `CF_Authorization` cookie.
3. Start a browser context without service-token headers.
4. Add the two `CF_Authorization` cookies to the browser context.
5. Open the GUI URL and wait for the app shell to render.

Expected browser checks:

- page title is `Chaop Control Plane`;
- the body contains `Operations Map`;
- the body contains `Budget Board`;
- the body contains `Host Sessions`;
- `/api/bootstrap` on the configured API origin returns `200` JSON;
- no GUI HTML, static asset, or API response returns `4xx` or `5xx`.

## Budget Smoke

For cost validation, inspect `/api/usage-summary` and report a compact summary:

- `source`;
- `state`;
- `generated_at`;
- `bottleneck_constraint.label`, `state`, `used_pct`, and `source`;
- each constraint label, state, used percentage, and source;
- `d1_write_model.budgeted_rows_written_per_event`;
- `d1_activity.signals` for measured current-day D1 rows written.

Healthy deployed budget data should show Cloudflare telemetry-backed constraints rather than `missing` constraints, unless the telemetry token or Cloudflare Analytics API is temporarily unavailable. Current four-hour and minute D1 write guardrails can legitimately use local schema-model baselines when no current write window has been opened.

This smoke can show that current deployed posture is healthy and that passive reads are not creating visible write pressure. It does not prove connector inventory write reduction under load unless a connector is running and Host Session inventory is deliberately exercised.

## Clean-Up

Remove temporary smoke scripts, result JSON, screenshots, and Playwright `test-results/` before finishing. Keep only durable documentation or journal updates.
