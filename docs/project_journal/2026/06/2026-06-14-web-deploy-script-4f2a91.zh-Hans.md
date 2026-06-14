---
id: 20260614-4f2a91-zh-Hans
title: Web 部署脚本
status: completed
created: 2026-06-14
updated: 2026-06-14
branch: wip/web-deploy-script
pr:
supersedes:
superseded_by:
---

[ [British English](2026-06-14-web-deploy-script-4f2a91.md) | 简体中文 ]

# Web 部署脚本

## 摘要
- 增加已跟踪的 `pnpm deploy:web` 入口，用于部署 Browser GUI static Worker。
- 部署实例值仍留在仓库外；脚本从调用方环境读取 `VITE_CHAOP_API_BASE_URL` 和可选的 `CHAOP_WEB_WORKER_NAME`。
- Wrangler static-assets 配置生成到 `.codex-tmp/deploy/web/`，因此 custom-domain 和 account 细节仍由 Cloudflare 或私有部署配置维护。
- 生成的 Web Worker 配置会关闭 `workers.dev` 和 preview URLs，让 Browser 访问继续走已配置 Cloudflare Access 的 custom domain。

## 验证
- `node --check scripts/deploy-web.mjs`
- `pnpm --filter @chaop/web build`
- 使用私有部署环境运行 `pnpm deploy:web`
