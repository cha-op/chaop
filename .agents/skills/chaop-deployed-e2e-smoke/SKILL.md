---
name: chaop-deployed-e2e-smoke
description: Run or update Chaop's deployed E2E smoke workflow after Cloudflare Worker/Web deployments, Access service-token setup, browser verification, or Budget Board cost-posture checks.
---

# Chaop Deployed E2E Smoke

Use this repo-local skill when verifying a deployed Chaop slice, especially after API/Web deploys, Access service-token changes, Budget Board telemetry changes, or connector cost-control work.

## Required Context

- Read `docs/e2e-smoke.md` before running the workflow.
- Read `docs/cost-aware.md` when the user asks whether budget or cost-reduction behaviour is healthy.
- Keep deployment-instance values and secrets outside the main repository. Do not print service-token secrets, Cloudflare account identifiers, private domains, or local workspace paths.

## Default Workflow

1. Source the private deployment env and Access smoke env without echoing values.
2. Run the low-cost API and asset smoke:
   - `/api/health`;
   - `/api/bootstrap` with the allowed GUI Origin;
   - `/api/usage-summary`, which can refresh Cloudflare telemetry and write a bounded telemetry cache row;
   - stop immediately on a failing Budget Board gate before requesting GUI assets or running browser automation;
   - GUI index;
   - referenced same-origin JavaScript and CSS assets, with automatic redirects disabled, request timeouts applied, and HTML SPA fallback rejected for service-token requests.
3. Run browser smoke through Access cookies:
   - exchange the service token for `CF_Authorization` cookies and any Access binding cookies on the GUI and API hosts;
   - add those cookies to the browser context;
   - do not inject service-token headers into the page context;
   - assert the app shell renders `Operations Map`, `Budget Board`, and `Host Sessions`;
   - assert `/api/bootstrap` on the configured API origin returns `200` JSON before the configured timeout.
4. For Budget Board checks, summarise `/api/usage-summary`:
   - `source`, `state`, and `generated_at`;
   - bottleneck constraint;
   - each constraint label, state, used percentage, and source;
   - `d1_write_model.budgeted_rows_written_per_event`;
   - current-day measured D1 rows-written activity.
5. Clean temporary scripts, response files, screenshots, Playwright `test-results/`, and any `.codex-tmp` smoke directory before finishing.
6. Record durable verification outcomes in `docs/project_journal/` when the result changes deployment confidence, cost posture, or future recovery steps.

## Cost Guardrails

Default to low-cost checks that avoid product write actions. Do not call these endpoints unless the user asks for a write-path or connector test:

- `POST /api/commands`;
- `POST /api/host-sessions/refresh`;
- `POST /api/budget/bootstrap`;
- attach, detach, archive, or unarchive routes.

Direct browser extra headers with `CF-Access-Client-Id` and `CF-Access-Client-Secret` can trigger CORS preflight failures. Use Access cookie exchange for browser automation.
