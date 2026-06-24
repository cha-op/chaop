---
id: 20260624-4d2c71-zh-Hans
title: Thread Centre Chat MVP
status: completed
created: 2026-06-24
updated: 2026-06-24
branch: wip/thread-centre-chat-mvp
pr:
supersedes:
superseded_by:
---

[ [British English](2026-06-24-thread-centre-chat-mvp-4d2c71.md) | 简体中文 ]

# Thread Centre Chat MVP

## 摘要
- PR B 接在已经合入的 dogfood safety gate 后面，保持 cost protection 不变。
- 产品目标是让用户可以从 Browser 使用一个 managed Codex app-server thread：选择或创建 thread、发送 prompt、查看实时 turn progress，并且不用扫 raw events 就能读到最新 assistant answer。
- 实现范围需要保持收敛。除非现有 event stream 无法表达 chat view，否则优先用前端 turn aggregation，不增加新的持久化写入。

## 已完成范围
- 对已 attached 的 app-server threads，继续把 managed app-server execution 作为默认可见路径。
- 增加一个聚焦的 Thread Centre turn stream，由 commands 和 thread events 聚合而来。
- 当 command summary 可用时显示用户提交的 prompt；用 command events 显示实时 progress/status；从 `Codex:` output events 显示最新 assistant answer；从 failed events 显示清晰失败文本。
- 在 turn stream 下方保留紧凑 raw event list，作为诊断 fallback。
- 更新 sample data 和测试，让本地开发环境能展示一个已完成的 app-server turn。

## 验证
- `pnpm --filter @chaop/web test`
- `pnpm test`
- `pnpm build`
- `cargo fmt --check`
- `project_journal.py validate --repo .`
- `git diff --check`
- 本地 Chromium headless smoke 打开 `#thread-centre`；turn stream、assistant answer 和紧凑 raw events 都正常渲染，没有明显重叠。
- 已在改动后刷新 API 和 Web 部署。
- Deployed E2E smoke 通过 Access-authenticated direct 和 browser paths；Budget/Safety posture 保持 `normal`。

## 下一步
- PR C 应为 Codex app-server turns 增加 human-in-the-loop approval 和 input-needed actions。
- 除非后续切片增加 bounded protocol field 用于完整 assistant messages，否则更深的 app-server transcript hydration 不放入本 PR。
