---
id: 20260627-6f3a91-zh-Hans
title: 第二台 Dogfood Connector 接入
status: active
created: 2026-06-27
updated: 2026-06-27
branch: master
pr:
supersedes: []
superseded_by:
---

[ [British English](2026-06-27-second-dogfood-connector-onboarding-6f3a91.md) | 简体中文 ]

# 第二台 Dogfood Connector 接入

## 摘要
- 正在把第二台主机接入现有 Cloudflare 控制面，以便用 Chaop 继续开发 Chaop。
- 新 connector identity，以及私密 token、spool、upgrade marker 和 process state 路径，都与暂时不可达的第一台主机隔离。
- 部署实例名称、域名、账号标识、secrets 和本地路径仍只保存在私有 ops 仓库与本地忽略状态中。

## 当前状态
- 本机已具备 Node 24、仓库锁定的 pnpm、Rust 和 Codex app-server 前置条件。
- Release connector build 和配置 doctor 已通过。
- 已使用新轮换的 Worker bootstrap secret 成功完成 connector bootstrap，connector token 使用仅当前用户可访问的权限保存。
- Connector 及其 managed app-server 在可轮询的前台会话中保持健康；app-server 只监听 loopback，connector 持有已建立的 Worker TLS/WebSocket 连接，没有 authentication 或 reconnect 错误。
- 普通后台 wrapper 没有被当作最终证据，因为当前 Codex command runner 会在命令会话结束时清理 detached child processes。这是本地 session ownership 限制，不是 connector 认证失败的证据。
- Headless LaunchDaemon 已安装并在 system domain 激活，同时 connector 与 managed app-server 以普通主机用户运行。一次受控 termination 验证了 `KeepAlive`、正常 app-server cleanup、connector clean exit，以及使用新 processes 恢复 loopback listener 与 Worker TLS/WebSocket connection。
- 带 Access 认证的人工 Browser 检查已确认 connector 与 managed app-server 可见且健康。已实际创建 local thread 并运行一次有边界的 managed turn；但本机还没有 Access service token，因此仓库内已跟踪的自动 smoke 仍待执行。
- 第一次 inventory 产生了明显的 D1 rows-written 峰值，随后在完成有边界的 product flow 时，当日实测总数只从 1,242 增至 1,277。代码检查显示新 connector 首次连接时最多会导入 200 个 Host Sessions；table 与 index 写入可以解释这次一次性峰值，而后续无变化的 report 会跳过 Host Session row update。
- Dogfood 暴露了空 thread 的状态恢复竞态：app-server state database 还没有暴露刚创建的 thread 时，即时完整 inventory 可能清除新 attach session 的 app-server presence，导致切走再返回后只剩 placeholder execution。本地 Worker 修复已加入一分钟的一致性宽限期，并已通过带回归覆盖的完整 Worker test suite；该修复尚未部署。

## 下一步
- 在本地忽略状态中加入 Access service token，然后运行仓库内已跟踪的低成本 deployed smoke。
- 部署空 thread inventory 竞态修复；创建 thread 后先不发 turn，切走再返回，确认仍默认选择 app-server execution。
- 等首次导入的斜率退出窗口后观察一个 idle 15 分钟 D1 delta；只有 rows 明显持续高于有边界的 telemetry sample write 时才继续深挖。
- Managed app-server recovery 部署验证后，再用一个聚焦改动从 product flow 删除 placeholder execution。
- 后续 rebuild/config restart 和主动 unload 继续使用文档中的 LaunchDaemon 操作方式。

## 证据
- 私有 ops deployment status 与 connector profile。
- `chaop-agent` release build 与 connector doctor。
- 成功的 connector bootstrap response；本文不记录任何 token value。
- 本机 process、loopback listener 与已建立 Worker connection 检查。
- 带 Access 认证的人工 dogfood 观察与当日 D1 rows-written telemetry。
- 针对已测试 thread 的只读本机 app-server inventory probe。
- `pnpm test`（48 个 protocol、3 个 script、61 个 web、296 个 Worker 和 165 个 Rust tests 全部通过）。
- `pnpm build`。
