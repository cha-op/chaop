[ [British English](cost-aware.md) | 简体中文 ]

# 成本模型

本文列出 Chaop 可能产生费用的位置，以及扩大 E2E 测试前应设置的告警。本文不记录部署实例值。

## 当前可能计费的服务面

| 服务面 | Chaop 为什么会用到 | 应设置的预算告警 |
| --- | --- | --- |
| OpenAI / Codex 用量 | 当 connector 配置 `execution.mode = "app_server"` 时，它会通过本机 Codex app-server 启动 turn。配置 private fallback `execution.mode = "codex_exec"` 时，本机 connector 会执行 `codex exec`。两者都会消耗本机 Codex 登录账号对应的 Codex 额度，或者消耗 API/project budget，具体取决于本机 Codex 配置。 | 如果本机 Codex 走 API 计费，设置 OpenAI API 月度预算和邮件阈值。如果本机 Codex 走 ChatGPT/Codex 计划额度，关注 Codex usage 或 limit 页面。 |
| Cloudflare Workers | `chaop-api` 承载浏览器 API、agent bootstrap、agent WebSocket upgrade 和 command dispatch。`chaop-web` 承载 GUI。 | 设置账号级 billing/usage notification，并为 Worker 设置 CPU limit。重点看 requests 和 CPU time。 |
| Durable Objects | `WorkspaceDO` 负责协调浏览器和 connector 的实时 WebSocket。 | 关注 Durable Object requests、incoming WebSocket message 量和 duration。长连接如果没有 hibernation，可能产生 duration 成本。 |
| D1 | D1 保存 users、connectors、workspaces、tasks、commands、token hashes、thread events，以及紧凑的 event-unit usage windows。 | 关注 rows read、rows written 和 storage。最容易增长的是 event 写入量；每个持久化 thread event 还会维护最多三条紧凑 usage-window rows。 |
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

## Budget Board 信号

D1 绑定可用时，Browser 里的 Budget Board 会使用 Chaop 自己控制的数据库信号，而不是静态 sample data：

- 分别读取 `daily`、`four_hour` 和 `burst` 的最新一条 `usage_windows` row。
- 从 sampled usage windows、在线 connectors 和未归档 tasks 中取当前最严重的 `budget_state`。
- Delayed events、compacted events 和 local spool bytes 优先来自 daily usage window；如果没有 daily window，则使用下一个可用的 sampled window。
- 页面会显示 source metadata，区分当前是 D1 usage windows、本地 sample data，还是空数据库。
- 缺失的 usage window 会显示为 missing sample，不会显示成 `0%` usage。
- 浏览器 WebSocket 处于 live 状态时，UI 只会每 60 秒刷新一次 `/api/usage-summary` 来更新 Budget Board 和 top-bar metrics；如果 WebSocket fallback，原有 10 秒 bootstrap polling 会提供同一份数据，并停止 budget-only polling。

Worker 会在持久化 thread events 的同一路径里写入这些 windows。每个 accepted thread event 记为一个 Chaop usage unit；低优先级 P2/P3 events 会增加 delayed counter，`command.output` summaries 会增加 compacted counter，已存储 summary bytes 会增加 local spool byte counter。Worker 每种 window type 最多读取一行，再读取 grouped budget-state counts。它不会扫描完整 event table，不会调用 Cloudflare billing APIs，不会调用 OpenAI billing APIs，也不需要部署实例 secrets。请把 Budget Board 当作 operator posture view，而不是官方账单来源；上面的 Cloudflare 和 OpenAI budget alerts 仍然需要开启。

## 当前防护

主仓库默认仍是 placeholder execution。Managed Codex execution 只通过私有 app-server connector 配置启用：

```toml
[execution]
mode = "app_server"
```

CLI adapter 是 private fallback/comparison path，不是默认产品路径：

```toml
[execution]
mode = "codex_exec"
```

App-server execution 当前只会把 lifecycle events 和最终 assistant message 摘要发回 Cloudflare；app-server `commandExecution` output 默认不会上传。CLI adapter 还会在 Codex JSONL 包含 token usage 时回传 token-usage 摘要。Connector 不会上传完整 Codex stdout/stderr、本机 transcripts、artefacts 或 token 级日志。
`codex_exec` 会通过 stdin 传入 Codex prompt，`app_server` 会通过 `turn/start` 传入；每个 Codex command 都有 connector 配置里的 runtime timeout。

## 后续需要保留的成本控制

- 每台 host 保持一个 Rust connector，本机多个逻辑 agent 都从它聚合。
- `app_server` 继续按 connector 显式 opt-in；`codex_exec` 只作为 private fallback，并且 Browser 默认隐藏。
- Managed app-server health checks 是本机 connector probes。Connector 现在会通过独立通道上报 AppServerInstance state；重复 healthy reports 会先经过 Durable Object 内存去重，未变化 summaries 受 15 分钟 D1 debounce 保护。状态边缘和 active turn count changes 仍会及时持久化。
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
