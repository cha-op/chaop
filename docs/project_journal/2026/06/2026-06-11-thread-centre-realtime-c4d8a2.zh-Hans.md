---
id: 20260611-c4d8a2-zh-Hans
title: Thread Centre 实时更新切片
status: completed
created: 2026-06-11
updated: 2026-06-11
branch:
pr:
supersedes: []
superseded_by:
---

[ [British English](2026-06-11-thread-centre-realtime-c4d8a2.md) | 简体中文 ]

# Thread Centre 实时更新切片

## 摘要
- 这个实现任务从 side chat 迁回 main thread，因为它涉及非平凡的产品和后端行为。
- Thread Command Centre 现在优先使用 browser WebSocket 更新；断开或连接失败后 fallback 到 10 秒轮询。
- Thread events 改为最新事件在上方，提交 command 后不需要滚到底部找最新状态。

## 决策
- Browser realtime 使用 `/ws/browser`；Vite 保留本地 `/ws` proxy，生产环境从 `VITE_CHAOP_API_BASE_URL` 推导 `wss://.../ws/browser`。
- `WorkspaceDO` 会把已持久化的 agent lifecycle events 作为 `thread.event` envelope 广播给已连接的 browser sockets。
- Fallback polling 使用 10 秒间隔。原先提交后 0s / 1s / 2.5s 的短轮询 burst 已移除。
- `GET /api/bootstrap` 不再无条件写 browser user row，降低 polling fallback 下的 D1 write 放大风险。

## 实现记录
- Web app 会把 realtime thread event 合并进本地 bootstrap state，并从 lifecycle events 更新 command、task 和 thread summary state。
- Top bar 会显示连接状态：`Connecting`、`Live` 或 `Polling 10s`。
- Worker tests 覆盖 read-only bootstrap 和 browser realtime envelope 形态。

## 验证目标
- Worker tests 覆盖 bootstrap no-write 和 DO browser event payload。
- Web typecheck 覆盖 realtime state 和 WebSocket URL handling。
- 现有 full build/test gate。
- Browser 验证 Thread Command Centre layout 和事件倒序。

## 验证
- `pnpm build`
- `pnpm test`
- `git diff --check`
- `project_journal.py validate --repo <repo>`
- Headless Chromium/CDP 验证已加载 `http://127.0.0.1:5173/#thread-centre`，连接本地 Worker dev，并观察到 `Live`。

## 证据
- Web：`apps/web/src/app-root.ts`、`apps/web/src/api.ts`、`apps/web/src/styles.css`。
- Worker：`apps/worker/src/workspace-do.ts`、`apps/worker/src/db.ts`、`apps/worker/src/routes.test.ts`、`apps/worker/src/workspace-do.test.ts`。
