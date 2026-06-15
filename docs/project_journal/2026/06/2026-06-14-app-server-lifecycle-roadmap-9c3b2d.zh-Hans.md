---
id: 20260614-9c3b2d-zh-Hans
title: App-server 生命周期路线图
status: active
created: 2026-06-14
updated: 2026-06-15
branch: wip/web-deploy-script
pr:
supersedes: 20260613-e4a7c9
superseded_by:
---

[ [British English](2026-06-14-app-server-lifecycle-roadmap-9c3b2d.md) | 简体中文 ]

# App-server 生命周期路线图

## 摘要
- Chaop 会从当前 opt-in 的 `codex_exec` connector fallback，逐步迁移到 connector 管理的 Codex app-server execution，并把后者作为主要 command path。
- Task 仍然是 thread-first 的另一种视图：每个 task 都有一个 primary thread，后续切片可以把相关 threads 关联到同一个 task。
- App-server lifecycle reporting 必须一开始就按成本治理设计：本机 health checks 可以更频繁，但远端 state writes 必须 deduplicate、batch、debounce，并且全局限流。
- 交付拆成九个 PR。每个 PR 合并前都必须通过完整测试集、三重 review，以及 GitHub conversation resolved 检查。

## PR 顺序

### PR0: Web Deploy Script
- 合并已跟踪的 `pnpm deploy:web` 入口，用于部署 Browser GUI static Worker。
- 部署实例值继续留在本仓库之外。
- 生成的 Web Worker deploy config 会关闭 `workers.dev` 和 preview URLs。

### PR1: Execution UX And Capability Cleanup
- 不再把 `codex_exec` 呈现成普通产品路径。
- 在 protocol 和 UI copy 里区分 placeholder execution、managed Codex app-server execution，以及隐藏/开发者用的 Codex CLI fallback。
- 当没有 managed app-server connector 在线时，改进 new local thread 和 command execution 的 unavailable-state message。
- 更新文档，把 `codex_exec` 记录为 private fallback only。

### PR2: Connector-managed Single App-server Lifecycle
- 让 connector 在配置启用时管理一个 dedicated Codex app-server listener。
- listener 不存在时自动启动，持续 health-check，并在异常退出时重启。
- 只有 managed app-server 足够健康时，才声明 `app_server_threads`、`app_server_archive` 和 `codex_app_server_exec` capabilities。

### PR3: Cost-safe AppServerInstance State Model
- 增加 app-server instances 的 durable state model，但不能把 health checks 变成高频 D1 writes。
- 对未变化的 healthy state 做 deduplicated 和 debounced summary report。
- 对 healthy、degraded、draining、restarting、stopped 等 state edges 及时落库。
- 保持 bootstrap read-only，避免 polling 放大写入。

### PR4: AppServerInstance UI
- 在 Operations 和 Host Sessions 相关界面展示 app-server instance state。
- 显示 connector identity、endpoint type、active turn count、draining/restarting state、last changed time 和 last seen age。
- 第一轮 UI 不做高频 charts 或 log streams。

### PR5: Default Command Path To App-server
- 普通 Codex commands 默认走 managed app-server path。
- 除非显式 private/developer flag 开启，否则不自动 fallback 到 `codex_exec`。
- E2E validation 覆盖 new local thread creation、command execution、archive/unarchive sync、restart 和 inventory。

### PR6: Drain, Scheduled Restart, And Upgrade
- 为 scheduled restart 或 upgrade 增加 draining state。
- 尽可能等到没有 active command、turn 或 in-flight operation 后再重启。
- 重启 managed app-server 后重新 inventory/re-attach 受影响的 threads。

### PR7: Multi-instance And Thread Placement Foundation
- 扩展 registry，使其支持 connector-wide、workspace/project-scoped 和 thread-dedicated app-server instances。
- 默认仍保持 connector-wide placement。
- thread-dedicated placement 作为可选 canary path，为后续 rolling-upgrade experiments 留接口。

Implementation checkpoint:
- `AppServerInstanceSummary` 和 `AgentAppServerInstance` 现在携带可选的 `workspace_id` 和 `thread_id` placement targets。
- D1 会在 `app_server_instances` 保存 placement targets，把 placement 纳入 dedupe fingerprints，并通过 bootstrap 和 realtime updates 暴露给前端。
- Agent app-server reports 现在校验 scope-specific placement：connector-wide reports 默认不带 target，workspace reports 需要 `workspace_id`，thread reports 需要 `thread_id`。
- Operations/Host Sessions 里的 app-server cards 现在显示 placement labels，同时 connector-wide 仍是默认 managed path。

### PR8: Budget Board Real Metrics
- 用 Chaop 可控来源里的真实 usage/cost signals 替换 Budget Board placeholder data。
- metric collection 需要 bounded、sampled，并且 cache-friendly。
- 增加 budget-alert 设置指引，但不提交部署实例值。

## 每个 PR 的合并门禁
- 跑完整本地 test/build suite 和相关 focused checks。
- GitHub CI 通过。
- 完成三重 review：local/manual review、helper-backed independent Codex review，以及可用时的 PR-level GitHub Codex review。
- 合并前确认所有 GitHub review conversations 都已 resolved。
- 只在 PR branch 对所选 merge strategy 足够新时合并；合并后更新本地 target branch，再从更新后的 base 创建下一个 PR branch。

## Lifecycle Reporting 成本护栏
- 本机 app-server health probes 可以频繁，但远端写入必须由 state-change 或 summary 触发。
- 短时间内相同 healthy reports 最多只应该产生一到两次 persisted writes。
- WebSocket broadcasts 不应自动意味着 D1 writes。
- Browser fallback polling 默认保持 10 秒。
- State edges 和 operator-visible failures 在必要时可以绕过普通 healthy-state debounce。

## 延后决策
- 是否默认做到 one app-server per active thread，等 connector-wide lifecycle 稳定后再决定。
- 在 managed app-server path 完整可靠之前，`codex_exec` 只保留为显式 private fallback。
