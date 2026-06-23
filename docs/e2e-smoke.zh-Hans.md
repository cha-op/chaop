[ [British English](e2e-smoke.md) | 简体中文 ]

# E2E Smoke 指南

本文记录 Chaop 的低成本线上 smoke test 流程。部署实例值和密钥应保存在本仓库之外。

## 范围

默认 smoke 是只读验证：

- 确认 Cloudflare Access service-token authentication 可用；
- 确认 API Worker 对 `/api/health`、`/api/bootstrap` 和 `/api/usage-summary` 返回 JSON；
- 确认 Web Worker 可以返回已部署的 HTML、JavaScript 和 CSS assets；
- 确认真正的浏览器可以通过 Cloudflare Access cookies 打开生产 GUI；
- 查看 Budget Board posture，但不创建 command、不刷新 Host Session inventory，也不 bootstrap usage windows。

除非用户明确要求测试写路径，默认 smoke 不要执行这些动作：

- `POST /api/commands`；
- `POST /api/host-sessions/refresh`；
- `POST /api/budget/bootstrap`；
- attach、detach、archive 或 unarchive 操作；
- 启动 connector 或执行 app-server turn。

## 必需本地输入

使用已忽略的私有文件或私有部署仓库。下面的命令示例假设 source 私有文件后会得到这些环境变量：

```text
CHAOP_GUI_DOMAIN
VITE_CHAOP_API_BASE_URL
CF_ACCESS_CLIENT_ID
CF_ACCESS_CLIENT_SECRET
```

不要打印 service-token secret。总结结果时只输出 status code 和经过挑选的响应字段。

## API 和 Asset Smoke

直接请求 API 和静态资产时，使用 Cloudflare Access service-token headers：

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

预期检查项：

- `/api/health` 返回 `200` JSON，并包含 `ok: true` 和 `service: "chaop-api"`。
- `/api/bootstrap` 在带允许的 GUI domain `Origin` header 时返回 `200` JSON。
- `/api/usage-summary` 在 telemetry 已配置时返回 `200` JSON，并包含 `source: "cloudflare_analytics"`。
- GUI index 返回 `200`。
- index 引用的每个 JavaScript 和 CSS asset 都返回 `200`，并且 body 非空。

## Browser Smoke

不要在 GUI 页面的 browser extra headers 里直接注入 `CF-Access-Client-Id` 和 `CF-Access-Client-Secret`。浏览器发往 API 的 fetch 是跨域请求，这些自定义 headers 会触发 CORS preflight；Cloudflare Access 可能会在 Worker 添加 CORS headers 前拒绝 preflight。

改用这个流程：

1. 带 service-token headers 请求 GUI domain，并捕获它返回的 `CF_Authorization` cookie。
2. 带 service-token headers 请求 API domain，并捕获它返回的 `CF_Authorization` cookie。
3. 启动不带 service-token headers 的 browser context。
4. 把两个 `CF_Authorization` cookies 加到 browser context。
5. 打开 GUI URL，并等待 app shell 渲染。

预期 browser 检查项：

- 页面标题是 `Chaop Control Plane`；
- body 包含 `Operations Map`；
- body 包含 `Budget Board`；
- body 包含 `Host Sessions`；
- `/api/bootstrap` 返回 `200`；
- GUI HTML、静态 asset 和 API response 都没有返回 `4xx` 或 `5xx`。

## Budget Smoke

成本验证时，检查 `/api/usage-summary` 并输出简短摘要：

- `source`；
- `state`；
- `generated_at`；
- `bottleneck_constraint.label`、`state`、`used_pct` 和 `source`；
- 每个 constraint 的 label、state、used percentage 和 source；
- `d1_write_model.budgeted_rows_written_per_event`；
- `d1_activity.signals` 里的当前日 D1 rows written 实测值。

健康的线上 budget data 应该显示 Cloudflare telemetry-backed constraints，而不是 `missing` constraints；除非 telemetry token 或 Cloudflare Analytics API 暂时不可用。当前 four-hour 和 minute D1 write guardrails 在当前 write window 尚未打开时，可以合理显示成本地 schema-model baseline。

这个 smoke 可以证明当前线上 posture 健康，并且被动读取没有产生明显写入压力。它不能单独证明 connector inventory 在负载下的写入缩减有效；要证明这一点，需要 connector 正在运行，并且有意识地测试 Host Session inventory。

## 清理

结束前删除临时 smoke scripts、result JSON、screenshots 和 Playwright `test-results/`。只保留需要长期维护的文档或 journal 更新。
