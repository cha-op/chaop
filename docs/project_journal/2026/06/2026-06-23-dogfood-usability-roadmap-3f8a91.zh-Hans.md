---
id: 20260623-3f8a91-zh-Hans
title: Dogfood Usability Roadmap
status: active
created: 2026-06-23
updated: 2026-06-23
branch: wip/app-server-attach-resume
pr:
supersedes:
superseded_by:
---

[ [British English](2026-06-23-dogfood-usability-roadmap-3f8a91.md) | 简体中文 ]

# Dogfood Usability Roadmap

## 摘要
- 下一轮产品目标是：先保证 Chaop 不超成本，再让它足够可用，能从 Browser 里支撑日常 dogfood。
- 成本保护排第一：宽泛的 inventory sync 继续保持 opt-in，写入路径必须有边界，UI 要在用户触发高成本操作前清楚展示当前瓶颈。
- 可用性先聚焦一条实际路径：创建或选择 managed app-server thread，发送 prompt，实时看进度，并直接读到 assistant final answer，而不是只看底层 event log。
- 每个实现切片都独立成一个 PR。每个 PR 都必须通过完整本地/CI 测试、三路 review、GitHub conversations resolved、merge、更新 master，并在新分支上开始下一片。

## PR 计划
- PR A，Dogfood Safety Gate：增加更清晰的顶层 cost posture，为 command creation 和 broad refresh actions 加 server-side guards，加入 emergency pause 或 stop path，并补安全运行边界文档。
- PR B，Thread Centre Chat MVP：让 managed app-server path 成为默认可见工作流，支持创建/选择 thread、提交 prompt、stream progress，并把 assistant final answer 渲染在低层 events 之上。
- PR C，Human-In-The-Loop Turns：展示 Codex/app-server turn 的 approval 和 input-needed 状态，并在 Thread Centre 增加 approve、deny 和 provide-input 操作。
- PR D，Persistent Connector Dogfood Runbook：增加 scripts 和文档，用于 dogfood session 期间启动、停止、观察和恢复 connector/app-server pair。
- PR E，Cost And E2E Hardening：扩展 dogfood path 的 deployed smoke 覆盖，把 cost telemetry check 留在 gate 中；只有低成本 telemetry 仍显示无法解释的增长时，才加入精确 D1 write-attribution。

## 交付规则
- 每次 merge 后都保持 `master` green 且可发布。
- 前一个 PR 没有 merge、没有本地更新 `master`、没有从新 `master` 切出 topic branch 之前，不开始下一个实现 PR。
- 每个非平凡切片都写入 `docs/project_journal/`，并维护英文和简体中文配对文档。
- 部署实例值保存在已忽略的本地文件或私有 ops 仓库中，不写入 Chaop tracked docs。
- 用户可见产品路径优先使用 managed app-server execution。除非明确作为 operator fallback，否则继续保持 `codex_exec` private 或 hidden。

## 验证门槛
- 每个 PR 都跑完整 project test/build gate。
- 文档变更时运行 project journal validator。
- 如果切片改变 production-facing API、Web、Access、connector、app-server 或 cost-posture 行为，就运行 deployed E2E smoke。
- merge 前运行三路 review，然后 resolve 或明确关闭每个 GitHub conversation。

## 当前下一步
- 收尾当前 app-server attach/resume PR；在 checks、reviews 和 conversations 都干净后合并。
- 合并后立即从更新后的 `master` 开始 PR A。
