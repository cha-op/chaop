---
id: 20260610-b7f2c1-zh-Hans
title: Codex CLI 执行切片
status: active
created: 2026-06-10
updated: 2026-06-10
branch:
pr:
supersedes: []
superseded_by:
---

[ [British English](2026-06-10-codex-cli-execution-b7f2c1.md) | 简体中文 ]

# Codex CLI 执行切片

## 摘要
- 本切片增加通过 `codex exec` 执行真实本机 command 的 opt-in 路径。
- 主仓库默认仍然安全：connector execution mode 默认是 `placeholder`。
- 部署实例里的开启配置放在私有 ops 仓库或其他已忽略/私有配置存储中。

## 决策
- 第一轮真实执行 adapter 使用 `codex exec --json --ephemeral --sandbox read-only -C <workspace> -`，prompt 通过 stdin 传入。
- Experimental Codex app-server protocol 保留为后续切片。
- 回传给 Cloudflare 的内容只包含 lifecycle events、最终 assistant message 摘要和 token usage 摘要；暂不上传完整 stdout/stderr 或 artefacts。
- Thread Command Centre 可以在 `placeholder` 和 `codex` command type 之间选择。
- OpenAI/Codex 用量作为一个成本面处理，并和 Cloudflare 成本一起写入 budget alert 文档。

## 实现记录
- `CreateCommandRequest` 现在接受可选 command `type`。
- Worker command creation 会保留 `placeholder` 或 `codex` type，并拒绝未知 type。
- Rust connector 只有在私有配置启用时才声明 `codex_exec` capability。
- 未启用 `codex_exec` 的 connector 收到 `codex` command 时，会返回明确失败事件。
- Worker 只会把 `codex` command 指向声明了 `codex_exec` 的 connector。
- Connector 会限制 Codex runtime 和 stdout/stderr buffering，然后再返回结果事件。
- Web app 在 Thread Command Centre 增加紧凑的 execution-mode segmented control。

## 验证目标
- Worker command type 校验单元测试。
- Rust connector execution gating 和 Codex JSONL parsing 测试。
- 所有 package 的 typecheck 和 build。
- 更新私有 connector 配置后，跑 placeholder deployed smoke 和一次有界 Codex command smoke。

## 证据
- Protocol：`packages/protocol/src/index.ts`。
- Worker：`apps/worker/src/routes.ts`、`apps/worker/src/db.ts`。
- Web：`apps/web/src/app-root.ts`、`apps/web/src/api.ts`。
- Connector：`crates/agent/src/config.rs`、`crates/agent/src/connector.rs`、`crates/agent/src/executor.rs`。
- 成本模型：`docs/cost-aware.zh-Hans.md`。
