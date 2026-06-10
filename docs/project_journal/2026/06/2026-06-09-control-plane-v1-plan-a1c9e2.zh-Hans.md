---
id: 20260609-a1c9e2-zh-Hans
title: 控制面 V1 计划切片
status: active
created: 2026-06-09
updated: 2026-06-10
branch:
pr:
supersedes: []
superseded_by:
---

[ [British English](2026-06-09-control-plane-v1-plan-a1c9e2.md) | 简体中文 ]

# 控制面 V1 计划切片

## 摘要
- 第一版从 Cloudflare-first 的端到端控制闭环开始：Browser GUI、Worker、Durable Object、D1、R2 绑定，以及 Rust placeholder connector。
- 第一轮 UX 切片优先覆盖 dashboard 状态、agents/workspaces、thread 详情、command 提交、事件流，以及成本状态可见性。
- 后续实现必须按 project journal 工作流维护。普通工作流状态写入本 journal；仓库级恢复入口写入 `docs/PROJECT_STATE.md`；跨工作流待办写入 `docs/PROJECT_TODO.md`。

## 当前决策
- UX 切片：控制闭环。
- 视觉流程：将已生成的方向作为互补产品视图使用，而不是只选择其中一个。
- 部署模型：Cloudflare-first。
- Browser 认证：Cloudflare Access。
- Agent 认证：bootstrap secret 签发每个 connector 的 token；D1 保存 token hash。
- Agent 入口：`/api/agent/bootstrap` 和 `/ws/agent` 由 Worker 校验机器 token；Browser 路径继续由 Cloudflare Access 保护。
- 域名形态：GUI 和 API 使用分离域名。
- 资源创建：优先使用 Wrangler 自动化，并让配置由代码控制。
- 初始数据：connector 注册时先记录 connector identity；host 和 workspace 记录延后到 inventory 切片。
- Command 执行深度：先实现 Rust placeholder connector，不接真实 Codex app-server。
- 成本 UX 深度：状态标记加 daily 和 4-hour 简要用量摘要。
- UX 聚焦规则：每个视图只有一个主要任务；共享信号保持紧凑和辅助，除非它们就是该视图的核心任务。
- Approval、artifact 和完整日志上传：第一切片只保留协议和 UI 入口，真实流程延后。

## 文档要求
- 面向用户的文档默认路径保存英文 canonical 文件。
- 配套简体中文文档使用相同 basename，并增加 `.zh-Hans.md` 后缀。
- 语言切换放在每份配套文档顶部附近，显示为 `[ British English | 简体中文 ]` 链接；不要把语言切换放进标题。
- 英文文档使用英式英语。简体中文文档必须使用汉字书写，方便汉语使用者阅读，不使用拼音替代。
- 文档集合应包括使用指南、快速上手、FAQ、故障排查、部署指南、架构文档、成本模型，以及后续新增的运维手册。

## 下一步
- 评审本地实现切片，并修复评审发现的问题。
- 在运行第一轮真实部署前，准备 Cloudflare 和 connector 配置值。
- 在后续切片中将 placeholder connector 执行替换为真实 Codex app-server 集成。

## 2026-06-09 交接记录
- 已生成三个视觉方向：`Operations Map`、`Thread Command Centre` 和 `Budget Reliability Board`。
- 已新增部署指南，覆盖 Cloudflare、Wrangler、Access、域名、预算和 connector bootstrap 配置。
- 已新增视觉方向摘要。
- 已调整 UX 决策：所有视觉方向都作为第一版一等视图纳入。
- 已新增 `Operations Task Board`，作为 Operations 下任务聚焦的子视图，支持用户自定义分类，并按 `Running`、`Idle`、`Waiting for approval`、`Waiting for input`、`Throttled` 和 `Done` 分 swimlane。
- 已新增视图聚焦规则：一个视图只服务一个主要任务，跨视图共享信号保持辅助地位。
- 已实现第一轮本地骨架：pnpm/Vite/Lit web app、Cloudflare Worker route skeleton、WorkspaceDO skeleton、共享协议包、D1 migration 和 Rust placeholder connector。
- 本地验证已通过：`pnpm test`、`pnpm build`、`cargo fmt --check`、`migrations/d1/0001_initial.sql` 的 SQLite 解析、Wrangler deploy dry-run、Wrangler D1 本地 migration 发现检查、project journal 校验、setup-ci node tests、Operations Map 和 Operations Task Board 的 Chromium headless 截图检查，以及经过 dev auth 和 Origin guard 的本地 Worker `POST /api/commands` smoke check。
- 已应用 review 修复：Cloudflare Access JWT 现在通过 Access JWKS 校验签名、audience 和标准化后的 issuer；生产 agent bootstrap 会签发随机 connector token，且 D1 只保存 SHA-256 token hash；开发专用 agent token 会签名，并且只在 insecure dev mode 开启时接受；畸形 agent token 稳定返回 401；Lit 使用 light DOM 以确保全局 CSS 生效；生产环境 bootstrap 失败不再静默展示 sample data；Worker 配置已显式指向 `migrations/d1`；D1 migration 已加入第一轮 FK/CHECK 约束。
- 已应用后续 review 修复：生产 web fetch 现在使用 `VITE_CHAOP_API_BASE_URL` 支持 GUI/API 分离域名；Worker JSON response 会附带 allowlist 后的 credentialed CORS headers；部署指南中的 Access 变量名已与 Worker runtime 名称一致；Worker route 会对畸形 JSON 或缺少必填字段的 request 返回 400。
- 已应用最终 review 修复：browser API 和 browser WebSocket route 现在会在产生副作用前拒绝不允许的 origin；connector ID 加入随机后缀，避免同名 connector 覆盖 metadata/token；`migrations/d1/*.sql` 已显式抵消用户全局 `*.sql` ignore 规则；本地 Worker dev 脚本会注入 insecure dev auth 且不会触发 Wrangler skills prompt；README/source-note 文档已澄清当前切片状态和文档入口。
- 已应用最终 re-check 修复：app-level dev 脚本现在会在启动 Vite 或 Wrangler 前先构建 `@chaop/protocol`；Worker dev 会应用本地 D1 migrations 并注入仅用于本地的 bootstrap secret；本地 insecure agent bootstrap 会返回当前本地 Worker WebSocket URL，而不是示例生产 API 域名。
- 2026-06-10 已应用宽复查后续修复：connector token 查询通过 migration `0002` 新增 D1 `token_hash` 索引；web command 提交使用 simple `text/plain` JSON body，以规避当前切片里 Cloudflare Access 的 preflight 风险；web placeholder command 不再硬编码 connector target；D1 已绑定时 Worker command creation 会按 workspace membership、`can_execute` 和 offline status 校验传入的 connector target；Thread Command Centre 会显示 command accepted/failed 反馈。
- 部署实例值不得 tracked 到本仓库。主仓库文档保持通用模板，branch history 需要重写以移除曾经提交的实例值；具体部署值记录到私有部署仓库/subrepo 或本地已忽略 env 文件。
- 真实 Cloudflare 部署仍阻塞于私有部署实例配置、API token、bootstrap secret、第一台 connector 详情，以及 D1 database UUID。

## 证据
- 来源文档：`docs/design-starter.md`、`docs/cost-aware.md`。
- 部署指南：`docs/deployment-guide.md`。
- 视觉方向摘要：`docs/ux-visual-directions.md`。
- 实现入口：`apps/web`、`apps/worker`、`packages/protocol`、`crates/agent`、`migrations/d1/0001_initial.sql`。
- 计划结果记录于 2026-06-09。
