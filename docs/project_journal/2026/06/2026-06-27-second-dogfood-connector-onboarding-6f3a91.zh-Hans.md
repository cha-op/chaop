---
id: 20260627-6f3a91-zh-Hans
title: 第二台 Dogfood Connector 接入
status: active
created: 2026-06-27
updated: 2026-06-30
branch: master
pr:
supersedes: []
superseded_by:
---

[ [British English](2026-06-27-second-dogfood-connector-onboarding-6f3a91.md) | 简体中文 ]

# 第二台 Dogfood Connector 接入

## 摘要
- 第二台主机已经接入现有 Cloudflare 控制面，Chaop 现在可以在自身仓库内执行有边界的写入，用于 self-hosted development。
- 新 connector identity，以及私密 token、spool、upgrade marker 和 process state 路径，都与暂时不可达的第一台主机隔离。
- 部署实例名称、域名、账号标识、secrets 和本地路径仍只保存在私有 ops 仓库与本地忽略状态中。

## 当前状态
- 本机已具备 Node 24、仓库锁定的 pnpm、Rust 和 Codex app-server 前置条件。
- Release connector build 和配置 doctor 已通过。
- 已使用新轮换的 Worker bootstrap secret 成功完成 connector bootstrap，connector token 使用仅当前用户可访问的权限保存。
- Connector 及其 managed app-server 在可轮询的前台会话中保持健康；app-server 只监听 loopback，connector 持有已建立的 Worker TLS/WebSocket 连接，没有 authentication 或 reconnect 错误。
- 普通后台 wrapper 没有被当作最终证据，因为当前 Codex command runner 会在命令会话结束时清理 detached child processes。这是本地 session ownership 限制，不是 connector 认证失败的证据。
- Headless LaunchDaemon 已安装并在 system domain 激活，同时 connector 与 managed app-server 以普通主机用户运行。一次受控 termination 验证了 `KeepAlive`、正常 app-server cleanup、connector clean exit，以及使用新 processes 恢复 loopback listener 与 Worker TLS/WebSocket connection。
- 带 Access 认证的人工 Browser 检查已确认 connector 与 managed app-server 可见且健康。已实际创建 local thread 并运行一次有边界的 managed turn。随后，仓库内已跟踪的 service-token smoke 通过了直接 health、bootstrap、usage-summary、same-origin asset 与真实 Chromium 检查，浏览器没有观察到失败 response。
- 第一次 inventory 产生了明显的 D1 rows-written 峰值，随后在完成有边界的 product flow 时，当日实测总数只从 1,242 增至 1,277。代码检查显示新 connector 首次连接时最多会导入 200 个 Host Sessions；table 与 index 写入可以解释这次一次性峰值，而后续无变化的 report 会跳过 Host Session row update。
- 生产 D1 的只读聚合确认：新 connector 今天发现了 217 个 Host Sessions，旧 connector 当日没有 inventory 变化。按每次 Host Session insert 约触发 5 个 D1 row mutation 估算，这些记录可以解释当日实测 1,277 次写入中的约 1,085 次。Database 历史累计已有 1,545 个 Host Sessions，说明 top-N report 限制不是 retention 上限。
- 替代 build 后第一次 connector restart 发生在当日实测写入从 1,277 增至 1,552 的区间。后续只读聚合只发现新增 12 个 Host Sessions，因此 inserts 无法单独解释这 275 rows；已有 inventory update、sync/connector/app-server state 与 telemetry sample 都可能贡献，精确 path attribution 仍需 query-meta instrumentation。代码检查另外发现：相同更新时间会通过随机化的 `HashMap` order 进入 top-N 截断。已部署的 follow-up 会按 session id 排列 ties。第一次 restart 在 17 个本机 rollout 文件发生变化的同时，让当前 connector 的 stored sessions 从 229 增至 236；紧接着的第二次 restart 保持在 236，确认稳定 report 不会继续导入另一组随机 subset。
- Dogfood 暴露了空 thread 的状态恢复竞态：app-server state database 还没有暴露刚创建的 thread 时，即时完整 inventory 可能清除新 attach session 的 app-server presence，导致切走再返回后只剩 placeholder execution。已部署的修复会让 create 与 ensure 之后的 inventory report 使用 incremental scope，同时保留普通完整 inventory 供后续清理。第一次 internal review 否决了更早的 Worker 宽限期实现，因为其 snapshot 与 timestamp 语义不可靠；该实现已删除。随后，一个真实空 thread 在没有发送 prompt 的情况下静置：五秒后的 bootstrap 仍报告 app-server presence，Chromium 初次打开以及切到 Fleet health 再返回后都保持 App-server 选中，且没有失败的 browser response。
- Managed app-server 现在使用固定到 Chaop repository 的 opt-in workspace-write permission profile。Git metadata、repository policy 与 skills、project Codex configuration、GitHub workflows 和已部署 connector binary 保持只读。相对 workspace 的 deny globs 会覆盖嵌套的 environment、package-manager 与 Cargo credential variants；动态 workspace roots 与通用 home-directory reads 仍不可用。Build 使用专用私密 temporary directory，Cargo dependency cache 保持 offline，test network 仅允许 loopback。
- 一次真实 managed turn 已通过部署后的 Chaop command path 创建 ignored canary，并且无需 profile 外 approval 即进入 `command.finished`。Canary content 与 mode 已验证，tracked files 保持干净，随后也已删除 canary。完全相同的 profile 还通过了 48 个 script、3 个 protocol、61 个 Web、294 个 Worker 与 167 个 Rust tests，以及 production build。

## 下一步
- 通过这个有边界的 write profile 完成一个小型真实 source change；在专门设计对应 workflow 前，commit/push 仍由 managed turn 之外执行。
- 等首次导入的斜率退出窗口后观察一个 idle 15 分钟 D1 delta；只有 rows 明显持续高于有边界的 telemetry sample write 时才继续深挖。
- 为 stale unattached Host Sessions 增加 retention 或 cleanup，避免滚动 top-N inventory 让 D1 长期只增不减。
- Managed app-server recovery 部署验证后，再用一个聚焦改动从 product flow 删除 placeholder execution。
- 后续 rebuild/config restart 和主动 unload 继续使用文档中的 LaunchDaemon 操作方式。

## 证据
- 私有 ops deployment status 与 connector profile。
- `chaop-agent` release build 与 connector doctor。
- 成功的 connector bootstrap response；本文不记录任何 token value。
- 本机 process、loopback listener 与已建立 Worker connection 检查。
- 带 Access 认证的人工 dogfood 观察与当日 D1 rows-written telemetry。
- 针对已测试 thread 的只读本机 app-server inventory probe。
- 仓库内已跟踪的低成本 deployed smoke；Budget Board state 为 `normal`，当日实测 D1 rows written 保持在 1,277。
- Wrangler D1 只读聚合查询；每条查询都报告 `rows_written: 0`，且没有输出 connector 或 session identifier。
- Internal review 与稳定排序修复后的 `pnpm test`（48 个 script、3 个 protocol、61 个 web、294 个 Worker 和 167 个 Rust tests 全部通过）。
- `pnpm build`。
- 独立 Codex review 检查了 `origin/master..57304c9`，没有发现可操作的 correctness issue。
- 两次相邻的 LaunchDaemon restart 都恢复了 loopback app-server listener 与 Worker connection；第二次保持相同的 236-session D1 聚合。
- 不发送 prompt 的空 thread recovery smoke 已通过；navigation 前后都保留 app-server presence 与选择，也没有发送 command。
- 最终仓库内已跟踪 deployed smoke 通过了 direct API、assets 与真实 Chromium 检查。Budget state 保持 `normal`；当日实测 D1 rows written 仍为 1,552（`1.6%`），D1 rows-read bottleneck 为 `4.3%`。
- Post-write deployed smoke 通过了 direct API、assets 与真实 Chromium 检查，没有失败的 browser response。Budget state 保持 `normal`；采样到的当日 D1 rows written 仍为 1,235（`1.2%`）。
- 冻结提交范围的独立审查发现第一版 profile 存在已部署 binary 可写和 credential pattern 覆盖不完整的问题。后续直接 Codex sandbox probe 在保留普通 workspace 写入的同时，阻止了已部署 binary 的 write-open 与嵌套 credential reads；重载后的 LaunchDaemon 已在运行中 app-server arguments 里暴露加固后的 profile。
