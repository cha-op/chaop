[ [British English](cost-aware.md) | 简体中文 ]

# 成本模型

本文列出 Chaop 可能产生费用的位置，以及扩大 E2E 测试前应设置的告警。本文不记录部署实例值。

## 当前可能计费的服务面

| 服务面 | Chaop 为什么会用到 | 应设置的预算告警 |
| --- | --- | --- |
| OpenAI / Codex 用量 | 当 connector 配置 `execution.mode = "codex_exec"` 时，本机 connector 会执行 `codex exec`；当配置 `execution.mode = "app_server"` 时，它会通过本机 Codex app-server 启动 turn。两者都会消耗本机 Codex 登录账号对应的 Codex 额度，或者消耗 API/project budget，具体取决于本机 Codex 配置。 | 如果本机 Codex 走 API 计费，设置 OpenAI API 月度预算和邮件阈值。如果本机 Codex 走 ChatGPT/Codex 计划额度，关注 Codex usage 或 limit 页面。 |
| Cloudflare Workers | `chaop-api` 承载浏览器 API、agent bootstrap、agent WebSocket upgrade 和 command dispatch。`chaop-web` 承载 GUI。 | 设置账号级 billing/usage notification，并为 Worker 设置 CPU limit。重点看 requests 和 CPU time。 |
| Durable Objects | `WorkspaceDO` 负责协调浏览器和 connector 的实时 WebSocket。 | 关注 Durable Object requests、incoming WebSocket message 量和 duration。长连接如果没有 hibernation，可能产生 duration 成本。 |
| D1 | D1 保存 users、connectors、workspaces、tasks、commands、token hashes 和 thread events。 | 关注 rows read、rows written 和 storage。最容易增长的是 event 写入量。 |
| R2 | 后续切片会用来保存 command artefacts、上传摘要和较大的日志。 | 启用 artefact capture 前先设置 R2 告警。关注 storage、Class A operations 和 Class B operations。 |
| Workers Logs / observability | 部署和排障时会用到。 | 生产日志保持短摘要，不要在没有上限时长期打开高频 tail 或 log export。 |

## 实用告警清单

让 connector 长时间无人值守运行前，请先配置：

1. Cloudflare 账号级 billing 或 usage notification。
2. `chaop-api` 的 Workers request 和 CPU 告警。
3. `WorkspaceDO` 的 Durable Object duration/request 告警。
4. `chaop-control` 的 D1 rows-written 告警。
5. `chaop-control` 的 D1 rows-read 告警。
6. 启用 artefact upload 前，为 `chaop-artifacts` 设置 R2 storage 和 operations 告警。
7. 如果本机 Codex 走 API 计费，设置 OpenAI API 月度预算和邮件阈值。
8. 如果本机 Codex 走 ChatGPT/Codex 计划额度，关注 Codex usage/limit。

## 当前防护

主仓库默认仍是 placeholder execution。真实 Codex 执行只通过私有 connector 配置启用：

```toml
[execution]
mode = "codex_exec"
# 或：
mode = "app_server"
```

App-server execution 当前只会把 lifecycle events 和最终 assistant message 摘要发回 Cloudflare；app-server `commandExecution` output 默认不会上传。CLI adapter 还会在 Codex JSONL 包含 token usage 时回传 token-usage 摘要。Connector 不会上传完整 Codex stdout/stderr、本机 transcripts、artefacts 或 token 级日志。
`codex_exec` 会通过 stdin 传入 Codex prompt，`app_server` 会通过 `turn/start` 传入；每个 Codex command 都有 connector 配置里的 runtime timeout。

## 后续需要保留的成本控制

- 每台 host 保持一个 Rust connector，本机多个逻辑 agent 都从它聚合。
- `codex_exec` 和 `app_server` 继续按 connector 显式 opt-in。
- 在明确 artefact upload policy 前，只回传短摘要。
- 在增加 live stdout streaming 前，先做 server-side per-command event limits。
- 启用 artefact upload 前，先做 R2 chunking 和 retention rules。
- 需要长期打开多个浏览器会话前，先补 WebSocket hibernation。

## 参考

- Cloudflare Workers 与 Durable Objects pricing：https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare D1 pricing：https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare R2 pricing：https://developers.cloudflare.com/r2/pricing/
- Cloudflare Notifications：https://developers.cloudflare.com/notifications/
- OpenAI API pricing 与 budget controls：https://openai.com/api/pricing/
- Codex usage limits：https://help.openai.com/en/articles/11369540-codex-in-chatgpt
