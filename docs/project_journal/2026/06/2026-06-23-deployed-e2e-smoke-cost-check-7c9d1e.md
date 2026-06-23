---
id: 20260623-7c9d1e
title: Deployed E2E Smoke And Cost Check
status: completed
created: 2026-06-23
updated: 2026-06-23
branch: wip/app-server-attach-resume
pr:
supersedes:
superseded_by:
---

[ British English | [简体中文](2026-06-23-deployed-e2e-smoke-cost-check-7c9d1e.zh-Hans.md) ]

# Deployed E2E Smoke And Cost Check

## Summary
- Recorded the deployed E2E smoke flow in `docs/e2e-smoke.md` with a paired Simplified Chinese document.
- Added the repo-local `chaop-deployed-e2e-smoke` skill because the workflow is Chaop-specific and includes Cloudflare Access cookie exchange, Budget Board telemetry, and private ops env conventions.
- Verified the deployed API and Web Workers through the new Access service-token smoke path.
- Rechecked live Budget Summary after the host-session inventory cost-control deployment.
- Re-ran the full deployed gate after the conservative D1 write-guardrail deployment and Web/API refresh.

## Current State
- API smoke passed: `/api/health`, `/api/bootstrap`, and `/api/usage-summary` all returned `200` JSON through Cloudflare Access service-token auth.
- Static Web smoke passed: the GUI index and referenced JavaScript/CSS assets returned `200` with non-empty bodies.
- Browser smoke passed after switching from service-token browser headers to Access cookie exchange. Direct browser service-token headers trigger a CORS preflight failure before the Worker can add CORS headers.
- Live Budget Summary now reports `source: cloudflare_analytics` and `state: normal`.
- Live constraints are no longer missing: D1 rows-written/day, Worker requests/day, Durable Object requests/day, and D1 rows-read/day all reported `normal`.
- Current measured D1 rows written for the UTC day was 769 at the sampled check, with the D1 rows-written/day constraint around 0.8% and D1 rows-read/day around 1.2%.
- Latest deployed gate passed after the API and Web redeploy: API health, bootstrap, usage summary, GUI index, JavaScript/CSS assets, browser app shell, and in-browser bootstrap all returned `200`.
- The Access cookie exchange must target a protected API endpoint such as `/api/health`; the API root path returns `404` and does not issue a `CF_Authorization` cookie.
- Latest Budget Summary remained `source: cloudflare_analytics` and `state: normal`; the sampled bottleneck was D1 rows read/day at 1.8%, D1 rows-written/day was 0.9%, Worker requests/day was 0.3%, and Durable Object requests/day was 0%.

## Cost Reduction Assessment
- The deployed budget data is healthy again and no longer stuck in the previous over-limit state.
- Passive reads for API, asset, browser, and budget smoke did not require command creation, Host Session inventory refresh, or budget bootstrap writes.
- This confirms the deployed cost posture and read-only smoke path. It does not by itself prove connector inventory reduction under active connector load; that still needs a short connector-on observation window if write growth reappears.
- The smoke is now part of the PR gate for deployment-affecting changes: refresh the API/Web deployment, then run the read-only deployed E2E smoke before merge.

## Next Steps
- Use the repo-local skill for future deployed smoke passes.
- If validating inventory write reduction under load, briefly run one connector, avoid automatic Host Sessions refresh, and compare D1 rows-written slope before and after a single explicit inventory refresh.
