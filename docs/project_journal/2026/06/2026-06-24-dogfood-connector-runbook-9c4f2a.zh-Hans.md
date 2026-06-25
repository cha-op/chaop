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
- PR D 把临时 connector 启动方式固化为持久化的 dogfood 运行方式。
- 新脚本会在用户持久化状态目录中管理 connector PID 和日志，启动并停止已有的 `chaop-agent --connect` 循环，支持一次性 smoke 运行，也可以触发 managed app-server 升级标记。
- 配套运行手册记录控制成本的启动、停止、观察、恢复和升级安排，同时不提交任何部署实例值。

## 当前状态
- `scripts/dogfood-connector.sh` 提供 `start`、`stop`、`restart`、`recover`、`status`、`logs`、`doctor`、`once` 和 `schedule-upgrade`。
- `pnpm dogfood:connector -- <command>` 是文档化的 operator entrypoint。
- `docs/dogfood-runbook.md` 和 `docs/dogfood-runbook.zh-Hans.md` 是面向用户的运行手册。
- README 和 deployment guide 入口现在将日常 dogfood 使用指向 persistent script，而不是临时 `cargo run` loop。

## 下一步
- PR E 应强化 deployed dogfood E2E 和 cost telemetry gates；只有再次出现无法解释的增长时，才加入精确 D1 write attribution。

## 证据
- 本地 shell、project 和 deployed smoke validation 会在 merge 前记录到 PR readiness report。
