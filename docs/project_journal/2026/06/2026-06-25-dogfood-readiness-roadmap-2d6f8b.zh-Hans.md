---
id: 20260625-2d6f8b-zh-Hans
title: 日常 Dogfood 就绪路线图
status: active
created: 2026-06-25
updated: 2026-06-25
branch: wip/dogfood-readiness-roadmap
pr:
supersedes: []
superseded_by:
---

[ [British English](2026-06-25-dogfood-readiness-roadmap-2d6f8b.md) | 简体中文 ]

# 日常 Dogfood 就绪路线图

## 摘要
- 上一条 dogfood usability roadmap 已完成到 PR E。
- 下一阶段目标是让 Chaop 足够可靠，可以用于日常从 Browser 到 managed app-server 的 dogfood，同时不增加后台成本。
- 成本保护仍是第一约束：默认不做 broad inventory sync，不引入后台写入放大；R2 artefact capture 继续延后，直到 retention 和 alerts 都明确。

## PR 计划
- PR F，Readiness Roadmap Closeout：把上一条 roadmap 标记为完成，记录下一阶段计划，并保持顶层 project state 可恢复。
- PR G，Connector And Budget Preflight：增加低成本 readiness path，在用户开始工作前清楚展示 Budget Board posture、connector online state、managed app-server availability，以及下一步安全 operator action。
- PR H，Opt-In Managed Thread E2E：为 managed app-server conversation path 增加显式 operator-triggered smoke：先跑 budget gate，创建或选择一个小的 test thread，提交一条有边界的 prompt，观察 assistant final answer，并 cleanup 或 archive。
- PR I，Thread Centre Daily Polish：围绕一个重点收紧默认对话界面：current turn status、final answer、pending input/approval，以及可行动的 error messages。避免新增高频 polling。

## 成本规则
- Passive readiness checks 可以读取 budget、connector 和 app-server state，但除非用户显式 opt in，否则不能刷新 broad Host Session inventory。
- Write-path smoke 必须显式、有边界，并且在运行前后都受 Budget Board posture 保护。
- Connector-side debounce、batching 和 rate limits 继续保持每个 connector 全局一致；多个 Browser listeners 不能放大 connector reports。
- R2 继续延后，直到 artefact retention、budget alerts 和产品价值都明确。

## 下一步
- 下一片实现 PR G。
- PR H 继续放在显式 operator flag 后面，因为它会有意触发真实 app-server turn。
- 任何 API、Web、Access、connector、app-server 或 cost-posture 变更后，都继续运行已跟踪的 deployed smoke。

## 证据
- Dogfood usability roadmap：[2026-06-23-dogfood-usability-roadmap-3f8a91.zh-Hans.md](2026-06-23-dogfood-usability-roadmap-3f8a91.zh-Hans.md)。
- Deployed E2E cost gates：[2026-06-25-dogfood-e2e-cost-gates-5e8a12.zh-Hans.md](2026-06-25-dogfood-e2e-cost-gates-5e8a12.zh-Hans.md)。
- PR #23 已合入已跟踪的 deployed smoke runner 和 cost gates。
