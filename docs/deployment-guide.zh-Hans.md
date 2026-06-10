[ [British English](deployment-guide.md) | 简体中文 ]

# 部署指南

### 目的

本文说明如何为 Codex app-server 控制面的第一轮部署切片准备 Cloudflare 和 connector 配置。

第一轮切片采用 Cloudflare-first，但 Rust connector 仍然先使用 placeholder 实现。目标是在接入真实 Codex app-server 前先准备控制闭环形态：

```text
Browser GUI -> Cloudflare Access -> Worker / Durable Object -> D1 / R2 -> Rust connector -> Worker / Durable Object -> Browser GUI
```

当前实现状态：仓库已经有本地骨架、binding、schema、认证检查、sample data 和 placeholder command acceptance。它还不会把 command lifecycle 写入 D1，不会通过 Durable Object relay command，也不会通过 Rust connector 执行 command。请把这些行为视为下一轮部署切片，而不是已经完成的生产行为。

不要把密钥提交到 Git。敏感值只通过本地忽略文件、密码管理器，或者直接执行 `wrangler secret put` 来提供。

### 本项目里的 Wrangler

Wrangler 是 Cloudflare 的项目命令行工具，用于 Workers 开发、资源绑定、密钥写入和部署。

在本仓库里，Wrangler 应作为部署控制面使用：

- `wrangler.jsonc` 或 `wrangler.toml` 是 Worker 配置的事实来源。
- D1 和 R2 资源通过 Wrangler 命令创建。
- 运行时密钥通过 `wrangler secret put` 写入。
- Cloudflare Access 先在 Zero Trust 中配置；Worker 再校验 Access JWT。

官方参考：

- Wrangler 配置：https://developers.cloudflare.com/workers/wrangler/configuration/
- Wrangler 环境变量：https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- D1 Wrangler 命令：https://developers.cloudflare.com/d1/wrangler-commands/
- R2 Wrangler 命令：https://developers.cloudflare.com/r2/reference/wrangler-commands/
- Cloudflare Access 自托管应用：https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/
- Cloudflare Access JWT 校验：https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

### 需要提供的值

第一轮实现和部署前，请先提供这些非密钥值：

```text
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_ZONE_ID=
CHAOP_RESOURCE_PREFIX=chaop
CHAOP_GUI_DOMAIN=app.example.com
CHAOP_API_DOMAIN=api.example.com
VITE_CHAOP_API_BASE_URL=https://api.example.com
ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
ACCESS_AUD=
CHAOP_ACCESS_ALLOWED_EMAILS=
CHAOP_ACCESS_ALLOWED_GROUPS=
CHAOP_FIRST_CONNECTOR_NAME=
CHAOP_FIRST_CONNECTOR_HOSTNAME=
CHAOP_FIRST_WORKSPACE_ROOT=
CHAOP_DAILY_BUDGET_UNITS=100
CHAOP_4H_SOFT_BUDGET_UNITS=20
CHAOP_4H_HARD_BUDGET_UNITS=35
CHAOP_BURST_EVENTS_PER_MINUTE=600
```

这些密钥只通过安全渠道提供：

```text
CLOUDFLARE_API_TOKEN=
AGENT_BOOTSTRAP_SECRET=
```

除非你指定其他名称，第一轮实现会从资源前缀推导资源名：

```text
Worker name: chaop-api
D1 database: chaop-control
R2 bucket: chaop-artifacts
Durable Object class: WorkspaceDO
```

### 创建 Cloudflare API token

使用有范围限制的 Cloudflare API token，不要使用全局 API key。

第一轮切片需要 token 具备足够权限来：

- 部署 Worker；
- 创建或绑定 D1；
- 创建或绑定 R2；
- 为 API 域名配置 Worker route；
- 读取 Wrangler 需要的 account/zone 元数据。

如果 Cloudflare Access 通过 dashboard 手动配置，Wrangler 部署 token 不需要 Access 应用管理权限。

如果后续要自动化 Access 配置，应单独创建 Access 管理 token，而不是扩大部署 token 的权限。

### 本地配置文件

等仓库里有部署脚本后，创建一个本地忽略文件，例如：

```text
.env.cloudflare.local
```

内容形态如下：

```text
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ZONE_ID=...
CHAOP_RESOURCE_PREFIX=chaop
CHAOP_GUI_DOMAIN=app.example.com
CHAOP_API_DOMAIN=api.example.com
VITE_CHAOP_API_BASE_URL=https://api.example.com
ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
ACCESS_AUD=...
CHAOP_ACCESS_ALLOWED_EMAILS=you@example.com
CHAOP_ACCESS_ALLOWED_GROUPS=
CHAOP_FIRST_CONNECTOR_NAME=mac-studio
CHAOP_FIRST_CONNECTOR_HOSTNAME=mac-studio.local
CHAOP_FIRST_WORKSPACE_ROOT=/Users/you/Program
CHAOP_DAILY_BUDGET_UNITS=100
CHAOP_4H_SOFT_BUDGET_UNITS=20
CHAOP_4H_HARD_BUDGET_UNITS=35
CHAOP_BURST_EVENTS_PER_MINUTE=600
```

不要提交这个文件。

### 本地开发

已提交的 Worker 配置为了生产安全保留 `CHAOP_DEV_ALLOW_INSECURE=false`。`pnpm dev:worker` 脚本会构建 protocol package、应用本地 D1 migrations，并为本地开发注入 `CHAOP_DEV_ALLOW_INSECURE=true`，这样 Vite GUI 可以通过本地 proxy 使用 `x-chaop-dev-user` header。它也会注入仅用于本地的 bootstrap secret：`local-dev-bootstrap-secret`。

手动运行 Wrangler 时，复制 example 文件并替换本地专用值：

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

不要在生产环境使用 `.dev.vars` 里的值。

### 创建 Cloudflare 资源

等 monorepo 脚本和 Wrangler 依赖存在后，命令形态会是：

```bash
pnpm wrangler d1 create chaop-control
pnpm wrangler r2 bucket create chaop-artifacts
```

D1 命令会返回 database UUID。把这个 UUID 写入 Worker 的 Wrangler 配置，作为 D1 binding。R2 bucket 名称用于 R2 binding。

Worker 配置会明确告诉 Wrangler 使用仓库里的 D1 migration 目录：

```text
apps/worker/wrangler.jsonc -> d1_databases[0].migrations_dir = ../../migrations/d1
```

把 D1 database UUID 写入 Worker 配置后，执行 schema migration：

```bash
pnpm --filter @chaop/worker exec wrangler d1 migrations apply chaop-control --config wrangler.jsonc --remote
```

Worker 配置随后应绑定：

```text
DB -> chaop-control
ARTIFACTS -> chaop-artifacts
WorkspaceDO -> Durable Object namespace
```

### 配置分离域名

使用两个主机名：

```text
GUI: app.example.com
API: api.example.com
```

构建 web app 时设置 `VITE_CHAOP_API_BASE_URL=https://api.example.com`，Worker 运行时设置 `CHAOP_API_DOMAIN=api.example.com`。GUI 用 Vite 变量发起浏览器请求；Worker 用运行时变量签发 connector control URL。

API 主机名承载：

```text
/api/*
/ws/browser
/ws/agent
```

Browser 路径由 Cloudflare Access 保护。第一轮切片里，agent bootstrap 和 agent WebSocket 路径由 Worker 级 bootstrap/agent token 认证，不由 Access 认证。

当前 Browser command submission 会把 JSON 作为 `text/plain; charset=utf-8` 发送，使跨域、带凭据的 `POST /api/commands` 仍然是 simple request，不需要 Access preflight 路径。如果后续切片加入自定义浏览器 header，或把 command submission 改回 `application/json`，请配置 Cloudflare Access 和 Worker route，让 `OPTIONS /api/*` 能到达 Worker 并返回已配置的 CORS response。

### 配置 Cloudflare Access

为 GUI 和面向 Browser 的 API 路径创建 self-hosted Access application。

记录：

```text
Team domain
Application AUD
Allowed email addresses or groups
```

Worker 必须为 Browser HTTP 和 WebSocket 请求校验 `Cf-Access-Jwt-Assertion`。Cloudflare 文档说明 Access 会在请求 header 中传递这个 token，浏览器请求也可能带有 `CF_Authorization` cookie。Worker 应优先使用 header。

除非后续决定为 connector 使用 Access service token，不要把 `/api/agent/bootstrap` 或 `/ws/agent` 放到这个 Browser Access application 后面。

Connector bootstrap 只用 `AGENT_BOOTSTRAP_SECRET` 注册 connector identity。Worker 随后签发随机 connector token，并且只在 D1 中保存它的 SHA-256 hash。重新执行 bootstrap 会创建新的 connector identity 和 token；请替换本地 connector token 文件，并在后续管理流程中停用旧 connector 记录。

### 写入 Worker secret

运行时密钥使用 Wrangler secrets：

```bash
pnpm wrangler secret put AGENT_BOOTSTRAP_SECRET
pnpm wrangler secret put ACCESS_AUD
pnpm wrangler secret put ACCESS_TEAM_DOMAIN
```

实现可以把非密钥配置放在 Wrangler vars 里，但密钥必须留在 Cloudflare secret storage 中。

### 准备第一台 connector

placeholder connector 需要一个本地配置文件：

```toml
connector_name = "mac-studio"
control_url = "wss://api.example.com/ws/agent"
bootstrap_url = "https://api.example.com/api/agent/bootstrap"
workspace_root = "/Users/you/Program"
token_file = "/Users/you/.chaop/connector.token"
spool_db = "/Users/you/.chaop/connector-spool.sqlite"

[bootstrap]
secret_file = "/Users/you/.chaop/bootstrap.secret"
```

在仓库外创建本地文件目录：

```bash
mkdir -p ~/.chaop
chmod 700 ~/.chaop
```

然后把 bootstrap secret 放入 `~/.chaop/bootstrap.secret`，并确保只有当前用户可以读取。

### 我需要你提供什么

下一轮实现时，非密钥值可以直接发在对话里；密钥请放到我们约定的安全渠道。

最低必需集合：

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_ZONE_ID
CHAOP_GUI_DOMAIN
CHAOP_API_DOMAIN
VITE_CHAOP_API_BASE_URL
ACCESS_TEAM_DOMAIN
ACCESS_AUD
CLOUDFLARE_API_TOKEN
AGENT_BOOTSTRAP_SECRET
CHAOP_FIRST_CONNECTOR_NAME
CHAOP_FIRST_WORKSPACE_ROOT
```

### 故障排查

- 如果 Wrangler 无法认证，检查 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。
- 如果 Browser 返回 `403`，检查 Access application AUD、team domain 和允许访问的用户策略。
- 如果 Browser command submission 在到达 Worker 前失败，检查请求是否已经变成 CORS preflight；要么保持 simple request 形态，要么允许 `OPTIONS /api/*` 通过 Cloudflare Access。
- 如果 connector 返回 `401`，检查 `AGENT_BOOTSTRAP_SECRET`，并确认 Worker route 没有被 Browser Access 拦截。
- 如果 D1 migration 失败，确认 D1 database UUID 已写入 Worker 配置。
- 如果 R2 写入失败，确认 bucket 已创建，并且 Worker binding 名称与实现一致。
