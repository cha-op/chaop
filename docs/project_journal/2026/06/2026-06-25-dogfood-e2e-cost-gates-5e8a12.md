---
id: 20260625-5e8a12
title: Dogfood E2E Cost Gates
status: completed
created: 2026-06-25
updated: 2026-06-25
branch: wip/dogfood-e2e-cost-gates
pr:
supersedes: []
superseded_by:
---

[ British English | [简体中文](2026-06-25-dogfood-e2e-cost-gates-5e8a12.zh-Hans.md) ]

# Dogfood E2E Cost Gates

## Summary
- PR E turns the deployed smoke workflow from a temporary runner into a tracked low-cost script.
- The runner verifies Access-authenticated API, bootstrap, usage summary, GUI assets, browser rendering, and Budget Board posture without calling product write-path endpoints. `/api/usage-summary` can still refresh and cache a bounded Cloudflare telemetry sample.
- Budget gate checks now fail by default when Cloudflare telemetry or measured current-day D1 rows-written activity is missing.

## Current State
- `scripts/deployed-smoke.mjs` is the operator entrypoint behind `pnpm smoke:deployed`.
- The browser path uses Cloudflare Access cookie exchange instead of injecting service-token headers into cross-origin browser requests.
- The browser path preserves Access binding cookies alongside `CF_Authorization` when Cloudflare returns them.
- Direct service-token fetches disable automatic redirects so same-origin asset checks cannot leak Access headers to an off-origin redirect target.
- Direct API checks derive the `Origin` header from the GUI origin, not a full GUI URL path, matching browser Origin semantics.
- Direct API, asset, Access cookie-exchange, and browser bootstrap fetches have smoke-level timeouts to avoid stalled deployment checks.
- The runner rejects explicit `http://` GUI or API origins before sending Cloudflare Access service-token headers.
- API health checks assert both `ok: true` and `service: "chaop-api"` so a misrouted Worker cannot pass the deployment smoke.
- Direct bootstrap checks assert the response contains a `workspaces` array, so `--skip-browser` cannot pass on malformed bootstrap JSON.
- Browser response checks ignore optional `/favicon.ico` failures, while continuing to fail on real GUI asset/API `4xx`/`5xx` responses and non-optional request failures without HTTP responses.
- Browser navigation failures are wrapped in redacted `SmokeError` messages so private GUI origins are not printed.
- The pending app-bootstrap response wait is consumed on early navigation or shell failures so the original smoke diagnostic is not followed by an unhandled rejection.
- Browser smoke verifies the app shell's own `/api/bootstrap` response origin, status, and API JSON shape against the configured API origin, catching stale `VITE_CHAOP_API_BASE_URL` bundles.
- App-server request deadline errors now keep the in-flight method name, avoiding suite-load-dependent timeout classification in the agent tests.
- Asset checks validate JavaScript/CSS content types so Cloudflare Assets SPA fallback HTML cannot make a missing asset pass.
- Asset summaries and asset failure messages redact deployment origins and report paths only.
- The deployed smoke runner evaluates the budget gate immediately after `/api/usage-summary` and stops before GUI asset or browser checks when the gate fails.
- The budget gate treats `hard_limited`, `throttled`, missing sampled hard constraints, missing telemetry, missing D1 rows-written activity, and high bottleneck/D1-write usage as failures.
- `--allow-missing-telemetry` is available only for known telemetry outages or non-dogfood environments.

## Next Steps
- Keep exact D1 write attribution deferred until telemetry shows unexplained write growth again.
- Continue using the deployed smoke after API/Web deploys and after connector cost-control changes.

## Evidence
- Local Node tests cover argument parsing, HTTPS origin validation, API Origin header derivation, API health service validation, bootstrap shape validation, browser navigation redaction without bootstrap-wait unhandled rejections, app API-origin validation, optional favicon filtering, request-failure detection, asset and cookie parsing, and budget gate pass/fail behaviour.
- The app-server resume deadline regression is covered by the existing Rust agent test that checks unmatched resume responses time out by method.
- Full local and deployed validation should be recorded in the PR readiness report before merge.
