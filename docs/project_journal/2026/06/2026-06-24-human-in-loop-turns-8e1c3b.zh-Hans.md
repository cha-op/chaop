---
id: 20260624-8e1c3b-zh-Hans
title: 人工介入回合
status: active
created: 2026-06-24
updated: 2026-06-24
branch: wip/human-in-loop-turns
pr: 21
supersedes:
superseded_by:
---

[ [British English](2026-06-24-human-in-loop-turns-8e1c3b.md) | 简体中文 ]

# 人工介入回合

## 摘要
- PR C 接在已经合入的 Thread Centre chat MVP 后面，继续让 dogfood safety gate 保护每个会产生写入的 operator action。
- 产品目标是：managed Codex app-server turn 需要 approval 或用户输入时，可以在对应的 Thread Centre turn 里暂停并展示待处理操作；operator 响应后，app-server turn 能继续运行。
- 这一片保持成本有边界：一个 pending interaction 只落一条结构化 thread event，一次 response 只落一条结构化 resolution event。不增加轮询表，也不增加宽泛 connector sync。

## 计划范围
- 扩展 shared protocol，加入结构化 `turn_interaction` request 和 resolution payload。
- 在 D1 中为 events 持久化可选 payload JSON，让 approval/input request 刷新后仍然可见，也能从另一台浏览器响应。
- 增加 browser API，用 `turn_interaction` dogfood safety action 保护单个 pending interaction 的 resolve 操作。
- 通过 connector 把 Codex app-server 的 approval 和 input JSON-RPC request 转发给 Chaop，再把浏览器响应回写给 app-server。
- 在相关 Thread Centre turn 内直接渲染 approval 和 input controls。

## 验证计划
- 跑聚焦的 Web 和 Worker 测试，覆盖 turn aggregation、payload persistence、safety posture 和 interaction resolution。
- 跑聚焦的 Rust connector 测试，覆盖 command approval 和 request-user-input app-server flows。
- PR review 前跑完整本地 test/build gate。
- 每批代码修改后都刷新 API 和 Web 部署，然后运行 deployed E2E smoke，并检查 budget/safety posture；确认通过后再报告这个 slice ready。

## 复查跟进
- 最后一轮 review 发现 permission approval 需要先向 operator 展示 requested `network` 和 `fileSystem` 明细，才能安全批准 turn 或 session scope。
- Review 也发现 dogfood safety pause 不能对隐藏的 approval/input request event 做 fake accept；现在 control plane 拒绝必要 interaction event 时，connector 会让对应 turn 可见地失败。
- App-server input auto-resolution 现在会发出 `input.received` resolution event，这样 Browser clients 能清掉过期的 pending input controls，迟到提交也会被现有 resolution guard 拒绝。
- 后续 review 发现 connector race：final app-server events 可能先于已排队的 interaction events 返回。现在 connector 会先 drain pending interaction events，再返回最终 turn events。
- 合并准备复查又发现三处 delivery race：浏览器响应现在必须等 connector 明确确认已投递后才会持久化；Worker 的 auto-resolution expiry 会包含 connector 的 grace window；短暂超时后可以回收 stale resolution claim。
- Sample HITL 数据现在使用泛化 workspace 路径，不再使用 deployment-instance 或本机路径。
- 最终 review 发现 response delivery acknowledgement 还需要证明 app-server worker 已消费同一个 interaction response。现在 connector 会跟踪每个 app-server turn 的 active interaction，并等待本地 worker delivery acknowledgement 后，Worker 才会记录 browser response。
- 重复 interaction-resolution insert 在输给 unique constraint 时，会 best-effort 回滚本次分配的 sequence number，避免 sequence gap 和后续不必要的 accounting。
- App-server v2 command approval 兼容性现在会保留 `availableDecisions`、object 形态的 `acceptWithExecpolicyAmendment` response、`proposedExecpolicyAmendment`、`commandActions` 和 `networkApprovalContext`，让 Thread Centre 能显示 network-specific approval，并把准确的 accepted decision 回写给 app-server。
- WorkspaceDO 内部 turn-interaction validator 现在也接受同 public route 一致的 object 形态 exec-policy amendment approval decision，并补了 DO 层测试覆盖它转发给 connector 的路径。
- 浏览器提交的 interaction response 现在必须匹配已存储的 request payload：如果 app-server 给出了 `available_decisions`，approval decision 必须在其中；input answer 必须完整覆盖请求的问题并且非空；Thread Centre 也会展示完整 network approval context，让未知但可能影响安全判断的字段可见。
- GitHub Codex 后续 review 修复移除了绝对 workspace 形态的 sample path，app-server auto-resolution deadline 改为 checked arithmetic，HITL response delivery ack 会等到 app-server response 写回成功后再确认，并且 connector 在等待 request event acknowledgement 时也会处理已经到达的 HITL response。
- Independent PR review 又发现两个 fail-closed 缺口。WorkspaceDO 现在会在任何 DB 写入前用 negative ack 拒绝 malformed 的必要 `approval.requested` 和 `input.requested` events；app-server `availableDecisions` 里若全是无效 decision，也会保留空 `available_decisions` list，让浏览器和 API 不再回退到无限制默认 approval choices。
- 后续 review 又发现三个 fail-closed 和 auditability 缺口。浏览器 response 现在会先持久化到 resolution claim，再投递给 connector；已经 delivered 的 claim 可以重试补 durable event，而不重复发送给 app-server；没有合法问题的 input request 会在变成 operator-visible 之前被拒绝；malformed resolution payload 也会在 DB 去重逻辑触发运行时异常前被拒绝或防御性忽略。
- 最新 independent review 发现原始 input answer 不能留存在 D1 claim 里，而且已经 delivered 但尚未记录 event 的 claim 不能被短 TTL 清理。现在 resolution claim 只保存可恢复的安全 summary/payload，不保存 input answers；重复的 pending 提交会被拒绝而不是重新派发；当 app-server approval choices 没有任何有效 decision 时会 fail closed。
- Review re-run 又发现四个恢复缺口。已经 delivered 的 claim 现在会在 auto-resolution deadline 检查前恢复；已经开始 dispatch 的 claim 不会被 pending-claim TTL 回收；auto-resolved input event 只会在 app-server JSON-RPC result 写回后发出；approval request 现在在 connector、Worker、Durable Object、Web 和 sample data 路径里都必须带显式且非空的 `available_decisions` allow-list。
- 最终合并准备复查发现 dispatch-started claim 还需要显式恢复路径。Worker 现在会在短期防重复窗口内保留模糊的 `sent_unknown` delivery，只对 `not_sent` 或 connector 明确拒绝的 response 释放 claim，并在更长超时后回收 stale dispatch-started claim，避免被中断的 response 永久卡住 approval 或 input request。
- 后续复查发现模糊 delivery 需要独立的持久状态，不能只靠 dispatch-started timestamp。Worker 现在会给 `sent_unknown` claim 标记 `delivery_uncertain_at`，因此不会被 TTL 清理并重新派发；但真正从未发出的 dispatch-started claim 仍然可以在较长超时后恢复。浏览器提交 input 时也会保留原始 answer 文本；Worker 会拒绝 crafted request 中不属于给定 options 的 answer，除非该问题允许 `is_other`；connector 也会按 Worker delivery timeout 等待 app-server worker acknowledgement。

## 成本说明
- 每次 human-in-the-loop pause 最多增加两条 event row：一条 request，一条 response。
- Resolution claim 按 command 和 interaction 共同限定，避免不同 turn 复用 app-server request ID 时让后续 response 被错误拦住。
- Response claim 现在会保存 delivered marker 和可恢复的安全 resolution summary/payload。为兼容性可以保留 approval decision，但 input answers 不会存入 claim。它只在 operator resolve HITL request 的低频路径上增加有边界的写入，不增加后台 sweep 或 polling path。
- Response claim 也会保存 dispatch-started marker。这是在显式 operator response 路径上的一次额外有界写入，用来避免不确定的 app-server delivery 被自动清理后再次派发。
- 模糊的 `sent_unknown` response 只会在显式 operator response 路径上额外写入一个有界 marker：`delivery_uncertain_at`。这里不增加后台 retry、poller 或 sweep；恢复需要后续显式 operator action，或未来的手动恢复 UI。
- Dispatch-started claim recovery 只会在更长超时后、下一次 operator response attempt 里顺带发生；不会新增后台任务、轮询或 sweep。
- Stale claim recovery 只发生在 response dispatch 路径里，不增加后台扫描。
- WebSocket delivery 继续作为首选 realtime path；现有 10 秒 fallback polling 不变。
- 新增的 `turn_interaction` safety action 让 hard limit 和 pause controls 可以在 operator response 产生 D1 写入前拦截。
