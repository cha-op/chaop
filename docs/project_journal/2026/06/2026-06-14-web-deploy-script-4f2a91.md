---
id: 20260614-4f2a91
title: Web Deployment Script
status: completed
created: 2026-06-14
updated: 2026-06-14
branch: wip/web-deploy-script
pr:
supersedes:
superseded_by:
---

[ British English | [简体中文](2026-06-14-web-deploy-script-4f2a91.zh-Hans.md) ]

# Web Deployment Script

## Summary
- Add a tracked `pnpm deploy:web` entrypoint for deploying the Browser GUI static Worker.
- Keep deployment-instance values outside the repository by reading `VITE_CHAOP_API_BASE_URL` and optional `CHAOP_WEB_WORKER_NAME` from the caller environment.
- Generate the Wrangler static-assets config in `.codex-tmp/deploy/web/` so custom-domain and account details remain in Cloudflare/private deployment configuration.
- Disable `workers.dev` and preview URLs in the generated Web Worker config so Browser access stays behind the configured Cloudflare Access custom domain.

## Validation
- `node --check scripts/deploy-web.mjs`
- `pnpm --filter @chaop/web build`
- `pnpm deploy:web` with private deployment environment
