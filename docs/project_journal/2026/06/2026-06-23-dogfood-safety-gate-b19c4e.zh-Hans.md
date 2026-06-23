---
id: 20260623-b19c4e-zh-Hans
title: Dogfood Safety Gate
status: active
created: 2026-06-23
updated: 2026-06-23
branch: wip/dogfood-safety-gate
pr: 19
supersedes:
superseded_by:
---

[ [British English](2026-06-23-dogfood-safety-gate-b19c4e.md) | 简体中文 ]

# Dogfood Safety Gate

## 摘要
- PR A 从已更新的 `master` 开始，app-server attach/resume PR 已经合并。
- 目标是在加入更完整的 Thread Centre chat flow 之前，先保证 dogfood 使用不会失控地产生成本。
- 这个切片要突出展示当前 safety posture，在 server 侧保护高成本 write 和 refresh actions，并提供即使多个浏览器同时打开也能生效的 emergency pause 或 stop path。

## 实现计划
- 增加 protocol/API safety posture，由当前 Budget Summary 和 emergency pause flag 共同推导。
- 当 posture 不安全时，在 server 侧挡住 command creation、local thread creation、Host Session refresh、app-server attach/backfill 等由浏览器触发的高成本操作。
- 在 Browser 中加入 emergency pause/resume 控制；被禁用的操作需要解释当前触发的限制，而不是静默失败。
- 宽泛 Host Session inventory 继续保持 opt-in，并保留 debounce 设计。
- 开 PR 前补齐测试、双语文档和 deployed E2E smoke 期望。

## 验证计划
- 开发期间运行聚焦的 worker/web 测试。
- 提交前运行完整本地 gate：pnpm 测试、Rust 测试、journal validation、build、formatting 和 diff checks。
- 代码变更后重新部署 API 和 Web，再运行 deployed E2E smoke。
- 合并前跑三路 review，并 resolve 每个 GitHub conversation。

## 进展
- 已实现 protocol safety posture、Worker guard、emergency pause/resume API，以及 Browser safety strip。
- 已在 server 侧保护 command creation、local thread creation、Host Session refresh、app-server attach、task archive/unarchive 和 budget bootstrap。
- 已补充 conservative posture、emergency pause/resume、blocked command creation、blocked Host Session refresh、migration coverage、null telemetry handling，以及 Browser safety helper behaviour 的测试。
- 已修复第一条 review 发现的问题：dogfood safety posture 和 server-side guard decisions 现在会纳入 connector 与 active task 的 budget states。
- Browser API error 现在会保留结构化 safety payload，因此 server-side safety block 可以立即更新本地 UI posture。
- 已修复第二条 review 发现的问题：emergency-pause state 无法读取时现在会 fail closed，而不是继续允许受保护的写入。
- 已新增 `agent_event` guard；当 dogfood safety 暂停或进入 hard limit 时，运行中的 connector WebSocket events 会在 D1 event persistence 前被拒绝。
- 已细化 `agent_event` 行为：pause 或 hard limit 期间会挡住高频非终态 events，但 `command.finished` / `command.failed` 仍可关闭 command 并清理 socket activity。
- 已把 safety 文案从宽泛的 “dogfood writes” 收窄为 “guarded dogfood actions”，避免把仍需保留的 cleanup paths 误描述为同一类受阻动作。

## 本地验证
- `pnpm --filter @chaop/web test`
- `pnpm --filter @chaop/worker test`
- `pnpm test`
- `pnpm build`
- `cargo fmt --check`
- `python3 /Users/joey/.codex/personal-sync/overlays/private/releases/5f1ab3fa5d9f7d534507216a2d6f765694f9b710/personal_codex/skills/project-journal/scripts/project_journal.py validate --repo .`
- `git diff --check`

## 下一步
- 提交并推送这次 review fix。
- 刷新部署 API/Web，运行 deployed E2E smoke，然后重新运行三路 review，并在 merge 前 resolve 所有 GitHub conversations。
