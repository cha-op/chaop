---
id: 20260624-9c4f2a-zh-Hans
title: Dogfood Connector Runbook
status: completed
created: 2026-06-24
updated: 2026-06-24
branch: wip/dogfood-runbook
pr:
supersedes: []
superseded_by:
---

[ [British English](2026-06-24-dogfood-connector-runbook-9c4f2a.md) | 简体中文 ]

# Dogfood Connector 运行手册

## 摘要
- PR D 把 ad-hoc connector launch path 固化为 persistent dogfood operating path。
- 新脚本会在 durable user state directory 中管理 connector PID 和 log，启动并停止已有的 `chaop-agent --connect` loop，支持 one-shot smoke run，也可以 touch managed app-server upgrade marker。
- 配套 runbook 记录 cost-safe start、stop、observation、recovery 和 upgrade scheduling，同时不提交任何 deployment-instance values。

## 当前状态
- `scripts/dogfood-connector.sh` 提供 `start`、`stop`、`restart`、`recover`、`status`、`logs`、`doctor`、`once` 和 `schedule-upgrade`。
- `pnpm dogfood:connector -- <command>` 是文档化的 operator entrypoint。
- `docs/dogfood-runbook.md` 和 `docs/dogfood-runbook.zh-Hans.md` 是面向用户的运行手册。
- README 和 deployment guide 入口现在将日常 dogfood 使用指向 persistent script，而不是临时 `cargo run` loop。

## 下一步
- PR E 应强化 deployed dogfood E2E 和 cost telemetry gates；只有再次出现无法解释的增长时，才加入精确 D1 write attribution。

## 证据
- 本地 shell、project 和 deployed smoke validation 会在 merge 前记录到 PR readiness report。
