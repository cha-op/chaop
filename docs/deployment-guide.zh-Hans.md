[ [British English](deployment-guide.md) | 简体中文 ]

# 部署指南

### 目的

本文说明如何为 Codex 控制面的第一轮部署切片准备 Cloudflare 和 connector 配置。

第一轮切片采用 Cloudflare-first。Rust connector 默认支持 placeholder execution，也可以通过私有 connector 配置显式开启 managed Codex app-server execution，或私有本机 `codex exec` fallback：

```text
Browser GUI -> Cloudflare Access -> Worker / Durable Object -> D1 / R2 -> Rust connector -> Worker / Durable Object -> Browser GUI
```

当前实现状态：仓库可以把 command lifecycle 写入 D1，通过 Durable Object dispatch pending command，接收 Rust connector 发回的 lifecycle events，把本机 Codex sessions attach 成 task/thread 视图，并且在 connector 配置了 `session_inventory.app_server_url` 时创建新的本机 Codex app-server thread、同步已 attach Host Session tasks 的 archive/unarchive 状态。预期产品执行路径是 app-server protocol（`execution.mode = "app_server"`）。CLI adapter（`execution.mode = "codex_exec"`）保留为 private fallback/comparison path。R2 artefact capture 仍然保留给后续切片。

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
CF_ACCESS_CLIENT_ID=
CF_ACCESS_CLIENT_SECRET=
```

### 部署实例值

不要把部署实例值提交到本仓库，即使它们不是 API secret。这里包括 Cloudflare account ID、zone ID、Access AUD、个人或私有主机名、允许访问的邮箱、connector hostname，以及本地 workspace path。

部署实例值应保存在以下位置之一：

- 本地已忽略文件，例如 `.env.cloudflare.local`；
- 密码管理器；
- 私有部署仓库或私有部署 subrepo。

除非你指定其他名称，第一轮实现会从资源前缀推导资源名：

```text
Worker name: chaop-api
D1 database: chaop-control
R2 bucket: chaop-artifacts
Durable Object class: WorkspaceDO
```

### 创建 Cloudflare API token

使用有范围限制的 Cloudflare API token，不要使用全局 API key。

第一轮切片需要 token 具备这些 dashboard 权限组：

所选 Cloudflare account 上的权限：

```text
Workers Scripts: Edit
D1: Edit
Workers R2 Storage: Edit
Account Settings: Read
```

所选 Cloudflare zone 上的权限：

```text
Workers Routes: Edit
Zone: Read
DNS: Edit
```

Cloudflare 的 API permission reference 可能把 dashboard 里的 `Edit` 显示成 `Write`；这轮配置里可以把它们视为同一类权限。如果你没有看到名为 “Worker deploy” 的入口，请使用 `Workers Scripts: Edit`；它对应 Worker script 部署权限组。

这里包含 `DNS: Edit`，是因为 Worker Custom Domain 会为主机名创建 DNS 记录。如果你之后决定完全手动配置 DNS，并且不让 Wrangler 管理 Custom Domain，可以再收窄这个权限。

可选权限：

```text
Workers Tail: Read
```

只有你想用同一个 token 运行 `wrangler tail` 时才需要添加。

如果 Cloudflare Access 通过 dashboard 手动配置，Wrangler 部署 token 不需要 Access 应用管理权限。

如果后续要自动化 Access 配置，应单独创建 Access 管理 token，而不是扩大部署 token 的权限。

### 创建用于 smoke test 的 Access service token

命令行 E2E smoke test 需要创建一个 Cloudflare Access service token，并把它加入面向 Browser API 路径的 Access application policy。

在 Zero Trust dashboard 中：

1. 进入 Access service tokens。
2. 创建一个用于 operator 或 CI smoke tests 的 token。
3. 只在创建时复制 client ID 和 client secret。
4. 在 Browser API application 的 Access policy 中允许这个 service token。

把值保存在仓库外：

```text
CF_ACCESS_CLIENT_ID=...
CF_ACCESS_CLIENT_SECRET=...
```

这两个值都按 secret 处理。Service token request 应带上这些 headers：

```bash
curl \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  https://api.example.com/api/bootstrap
```

Worker 会接受包含 user email 或 service-token identity claim 的 Access JWT。Service-token identity 会映射成 synthetic `@service.chaop.local` user，方便 smoke test 审计。

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
CF_ACCESS_CLIENT_ID=...
CF_ACCESS_CLIENT_SECRET=...
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

使用下面的命令部署 Browser GUI 静态 Worker：

```bash
VITE_CHAOP_API_BASE_URL=https://api.example.com pnpm deploy:web
```

该脚本会在 `.codex-tmp/deploy/web/` 下写入临时 Wrangler static-assets 配置，并默认部署 `chaop-web` Worker。它会显式关闭 `workers.dev` 和 preview URLs，因此生产访问必须通过已被 Access 覆盖的 Cloudflare custom domain 或 route。如果某个部署使用不同的静态 Worker 名称，可以用 `CHAOP_WEB_WORKER_NAME` 覆盖。

API 主机名承载：

```text
/api/*
/connector/bootstrap
/ws/browser
/ws/agent
```

`/api/*` 和 `/ws/browser` 下的 Browser 路径由 Cloudflare Access 保护。第一轮切片里，agent bootstrap 和 agent WebSocket 路径由 Worker 级 bootstrap/agent token 认证，不由 Access 认证。

当前 Browser command submission 会把 JSON 作为 `text/plain; charset=utf-8` 发送，使跨域、带凭据的 `POST /api/commands` 仍然是 simple request，不需要 Access preflight 路径。如果后续切片加入自定义浏览器 header，或把 command submission 改回 `application/json`，请配置 Cloudflare Access 和 Worker route，让 `OPTIONS /api/*` 能到达 Worker 并返回已配置的 CORS response。

### 配置 Cloudflare Access

为 GUI 和面向 Browser 的 API 路径创建 self-hosted Access application。

记录：

```text
Team domain
Application AUD
Allowed email addresses or groups
```

在 Cloudflare Zero Trust dashboard 里：

1. 创建 self-hosted application，并添加 GUI public hostname。
2. 为 API hostname 上的 Browser traffic 添加 `/api/*` 和 `/ws/browser` 覆盖。
3. 添加 Allow policy，使用 `Emails` include selector 填入 operator email addresses；如果已经配置 identity-provider groups，也可以有意识地改用 Access group selector。
4. 把 application AUD 复制到 `ACCESS_AUD`。

Worker 必须为 Browser HTTP 和 WebSocket 请求校验 `Cf-Access-Jwt-Assertion`。Cloudflare 文档说明 Access 会在请求 header 中传递这个 token，浏览器请求也可能带有 `CF_Authorization` cookie。Worker 应优先使用 header。

如果 Browser 写操作返回 `401 Missing Cloudflare Access JWT`，最可能的原因是新的 API path 没有被 Access application destination 覆盖。请为 API hostname 添加 `/api/*`，然后刷新 GUI session。

在当前实现里，Cloudflare Access policy 是 Browser 用户允许列表的事实来源。`CHAOP_ACCESS_ALLOWED_EMAILS` 和 `CHAOP_ACCESS_ALLOWED_GROUPS` 现在用于记录部署意图，也为后续 Worker 级 allowlist 预留，但 Worker 暂时还不会执行它们。

除非后续决定为 connector 使用 Access service token，不要把 `/connector/bootstrap` 或 `/ws/agent` 放到这个 Browser Access application 后面。Connector bootstrap path 有意放在 `/api/*` 之外，这样宽泛的 Browser Access protection 不会包住 connector registration。

Connector bootstrap 只用 `AGENT_BOOTSTRAP_SECRET` 注册 connector identity。Worker 随后签发随机 connector token，并且只在 D1 中保存它的 SHA-256 hash。用同一个 connector name 和 hostname 重新执行 bootstrap 会保留同一个 connector identity，并轮换 connector token；请用最新值替换本地 connector token 文件。稳定 identity 之前生成的旧重复 connector rows 会自动 retire。

### 写入 Worker secret

运行时密钥使用 Wrangler secrets：

```bash
pnpm wrangler secret put AGENT_BOOTSTRAP_SECRET
pnpm wrangler secret put ACCESS_AUD
pnpm wrangler secret put ACCESS_TEAM_DOMAIN
```

实现可以把非密钥配置放在 Wrangler vars 里，但密钥必须留在 Cloudflare secret storage 中。

### 准备第一台 connector

connector 需要一个本地配置文件：

```toml
connector_name = "mac-studio"
control_url = "wss://api.example.com/ws/agent"
bootstrap_url = "https://api.example.com/connector/bootstrap"
workspace_root = "/Users/you/Program"
token_file = "/Users/you/.chaop/connector.token"
spool_db = "/Users/you/.chaop/connector-spool.sqlite"

[bootstrap]
secret_file = "/Users/you/.chaop/bootstrap.secret"

[execution]
mode = "placeholder"
codex_command = "codex"
codex_sandbox = "read-only"
codex_timeout_seconds = 300
codex_output_max_bytes = 262144

[session_inventory]
enabled = true
max_sessions = 100
report_interval_seconds = 60
app_server_timeout_seconds = 2
# codex_home = "/Users/you/.codex"
# app_server_url = "ws://127.0.0.1:9876"

[session_inventory.managed_app_server]
enabled = false
# listen_url = "ws://127.0.0.1:9876"
# extra_args = []
startup_timeout_seconds = 10
restart_backoff_seconds = 5
```

`mode = "placeholder"` 是安全默认值。要运行真实本机 Codex 工作，优先在私有部署配置里使用 app-server adapter。

Private Codex CLI fallback 配置：

```toml
[execution]
mode = "codex_exec"
codex_command = "/opt/homebrew/bin/codex"
codex_sandbox = "read-only"
codex_timeout_seconds = 300
codex_output_max_bytes = 262144
```

不要把它暴露成 Browser 默认执行路径。GUI 默认隐藏 CLI fallback；只有 Web build 显式设置 `VITE_CHAOP_SHOW_CODEX_CLI_FALLBACK=true` 时才显示。生产部署应保持未设置。

Codex app-server adapter 配置：

```toml
[execution]
mode = "app_server"
codex_timeout_seconds = 300

[session_inventory]
app_server_timeout_seconds = 2

[session_inventory.managed_app_server]
enabled = true
listen_url = "ws://127.0.0.1:9876"
startup_timeout_seconds = 10
restart_backoff_seconds = 5
drain_timeout_seconds = 300
```

可选执行设置：

```toml
codex_profile = "default"
codex_model = "gpt-5.5"
extra_args = ["--skip-git-repo-check"]
```

可选 managed app-server 设置：

```toml
[session_inventory.managed_app_server]
extra_args = ["--ws-project-doc-max-bytes", "131072"]
scheduled_restart_interval_seconds = 86400
upgrade_marker_file = "/path/to/private/app-server-upgrade.marker"
```

只有本机 Codex CLI 确实需要时才加入可选设置。`execution.extra_args` 只用于 `codex exec` fallback flags；`codex app-server` 可用的 flags 请放在 `session_inventory.managed_app_server.extra_args`。`scheduled_restart_interval_seconds = 0` 会关闭周期性 restart；任何正数都会让 managed restart 在该间隔后排队执行。`upgrade_marker_file` 是可选项，应指向仓库外的私有本地文件。升级本机 Codex CLI 或替换 app-server runtime assets 后，touch 这个文件即可请求 connector drain 并重启 managed listener。`app_server` 和 private `codex_exec` fallback 都可能消耗 Codex/OpenAI 额度或 API budget；让真实执行无人值守运行前，请先按 [成本模型](cost-aware.zh-Hans.md) 设置告警。Budget Board 读取的是 Chaop 自己的有界 D1 posture signals，不能替代 Cloudflare 或 OpenAI billing alerts。
Prompt 会通过 stdin 传给 Codex，不放在命令行参数里。除非有明确运维理由，不要放宽 timeout 和 output cap。
由 `launchctl` 或其他 service manager 启动的常驻 connector，请使用绝对 `codex_command` 路径。这类进程不一定继承交互式 shell 的 `PATH`；如果找不到 executable，private CLI fallback command 会在使用 workspace `cwd` 之前就失败。

Session inventory 默认开启。Connector 会从 `CODEX_HOME` 或 `~/.codex` 读取本机 Codex metadata，上报 session id、title、cwd、更新时间和 title 来源；普通 inventory report 不会上传 rollout transcripts。Title 解析优先使用 metadata 或 rollout 里的标题，其次使用可选 app-server `Thread.name`，再其次使用本地 history 里的近期 prompt，最后 fallback 到 cwd 和 session id。设置 `session_inventory.enabled = false` 会同时禁用 Host Session inventory 和 Host Session history backfill capability。

当用户明确 attach 某个 Host Session 时，Worker 会向该 session 所属 connector 请求这个单一 session 的有界 history backfill。Connector 会读取匹配的本机 rollout，跳过注入的 developer/context records、reasoning records 和 tool output records，只返回简短的 user、assistant 和 tool call 摘要。如果找不到 rollout，则 fallback 到该 session 在 `history.jsonl` 里的近期 prompt。导入的 events 会保留本机原始事件时间，所以旧 history backfill 不会在全局 recent-event feed 里挤掉更新的 control-plane events。Backfill 失败不会阻止 attachment；Browser 仍会显示已 attach thread，并单独显示 backfill warning。

当 Chaop 需要让这个 connector 管理一个专用的本机 Codex app-server listener 时，设置 `session_inventory.managed_app_server.enabled = true`。如果 listener 不存在，connector 会带上配置里的 `execution.codex_profile`、`execution.codex_model`、`session_inventory.managed_app_server.extra_args` 和 `--listen <listen_url>` 启动 `codex app-server`；声明 app-server capabilities 前会先做 protocol 初始化级别的健康检查；如果子进程退出或启动失败，会在 `restart_backoff_seconds` 后重试。Managed listener URL 必须绑定到 `localhost`、`127.0.0.1` 或 `::1`；connector 会拒绝非 loopback host，避免把 app-server protocol 暴露到 LAN interface。如果你已经用其他 service manager 管理这个 listener，则保持 managed mode 关闭，并设置 `session_inventory.app_server_url` 指向外部 listener。

在 managed mode 下，只有 managed app-server URL 健康到足以初始化 protocol 时，connector 才会声明 `app_server_threads` 和 `app_server_archive`；只有该 URL 健康且 `execution.mode = "app_server"` 时，connector 才会声明 `codex_app_server_exec` 和 `host_session_app_server_ensure`。Connector 连接 Worker 后会通过 `agent.ready` 刷新这些 capabilities，所以 degraded managed listener 不会继续被选中执行新的 app-server 工作。如果使用外部管理的 `session_inventory.app_server_url`，capability 声明会跟随配置的 URL，listener 的健康维护由外部 service manager 负责。这和只适用于 CLI 的 `codex_exec` capability 是分开的。如果没有在线 app-server connector 声明 `app_server_threads`，Worker 会拒绝新建本机 thread 请求。已 attach 的 app-server command execution 要求 owning connector 声明 `codex_app_server_exec`；Chaop 会拒绝 command creation 或 lease，而不是 fallback 到另一台 connector 的 `codex_exec`。Host Session attach 只有在 connector 声明 `host_session_app_server_ensure` 时，才会发送 app-server resume/ensure control message；较旧的 app-server execution connector 会保留 D1-only attach 路径，不会因为未知 control envelope 等到 timeout。Connector 不声明 `app_server_archive` 时，archive/unarchive 会保持 D1-only；声明后，Chaop 会先更新 D1，然后 connector 把存储的 Codex session id 解析成 app-server thread id，再调用 `thread/archive` 或 `thread/unarchive`。同步失败会作为 Browser warning 回传，不会阻止本地 archive 状态更新。`app_server_timeout_seconds` 应保持较短，避免 app-server 停止时让 connector 启动、thread 创建、command setup、Host Session attach 或 archive 同步等待过久。

当 scheduled restart 或 upgrade marker restart 正在等待执行时，connector 会把 managed instance 上报为 `draining`，并临时从 `agent.ready` 中移除 app-server execution/thread/archive capabilities。这样 control plane 不会继续分配新的 app-server 工作，而已有 active turns 可以先结束。`active_turn_count` 归零后，connector 会重启 managed listener，完成健康检查，再重新声明 app-server capabilities 并恢复普通 inventory reports。如果 active turns 在 `drain_timeout_seconds` 内没有结束，connector 会强制重启，并把 timeout 写入 AppServerInstance state。Drain timeout 应足够覆盖正常 turns，但也要有限，避免 abandoned turn 永久阻塞 upgrade。

新建本机 thread 一律使用 connector 配置里的 `workspace_root` 作为启动 cwd；Browser API 不接受也不会转发任意 cwd。
App-server command execution 只会运行在已经 attach 到本机 app-server Host Session 的 Chaop thread/task 上。Worker 会在 `command.dispatch` 里带上已 attach 的本机 session id 和 cwd，connector 再把 session 解析成当前 app-server thread id，并从该 cwd 调用 `thread/resume` 和 `turn/start`。Command setup 会在 `codex_timeout_seconds` 预算内继续翻页扫描 app-server thread list；当连接取消或超时时，如果已经知道 turn id，或还能从 `turn/start` response 里恢复 turn id，connector 会 best-effort 发送 `turn/interrupt`。Chaop 只记录 lifecycle events 和最终 assistant message 摘要；本机 commandExecution output 默认不会上传。
Archive/unarchive 同步只适用于已经 attach 到 Host Session，且能在 app-server thread list 里解析出来的 Chaop task。仅存在于 Chaop 本地的 task 和 history-only Host Sessions 仍然只在 D1 里 archive。这个流程不会修改本机 history 文件；connector 只调用 app-server protocol。

如果不使用 managed mode，则用只有 connector host 能访问的私有 listener 手动启动本地 app-server：

```bash
codex app-server --listen ws://127.0.0.1:9876
```

然后在私有 connector 配置里设置对应 URL：

```toml
[session_inventory]
app_server_url = "ws://127.0.0.1:9876"
```

`report_interval_seconds` 控制周期性本机重扫间隔；周期路径只有 inventory 变化时才会上报。Host Sessions 的 refresh 按钮会请求在线 connectors 立即重扫并上报。只有 app-server list 调用成功、`thread/list` 所有分页都已耗尽，且合并后的 Host Session report 没有被 `max_sessions` 截断时，app-server inventory report 才会被当作完整快照；短暂 app-server list 失败或被截断的 report 不会清除已有 Host Sessions 的已知 app-server presence。

在仓库外创建本地文件目录：

```bash
mkdir -p ~/.chaop
chmod 700 ~/.chaop
```

然后把 bootstrap secret 放入 `~/.chaop/bootstrap.secret`，并确保只有当前用户可以读取。

Worker 部署后，执行 connector bootstrap，用 bootstrap secret 换取 connector token。当前 agent CLI 只会打印 bootstrap request body；它还不会自己发送 request，也不会自己写入 token file。请在仓库 checkout 中运行这个受支持的手动 exchange 流程：

```bash
export CHAOP_API_DOMAIN="api.example.com"
export CHAOP_AGENT_CONFIG="/path/to/agent.toml"
export CHAOP_HOSTNAME="$(hostname)"
export CHAOP_BOOTSTRAP_SECRET="$(cat ~/.chaop/bootstrap.secret)"

cargo run -p chaop-agent -- --config "$CHAOP_AGENT_CONFIG" --hostname "$CHAOP_HOSTNAME" \
  | curl -fsS "https://$CHAOP_API_DOMAIN/connector/bootstrap" \
      -H "content-type: application/json" \
      -H "x-chaop-bootstrap-secret: $CHAOP_BOOTSTRAP_SECRET" \
      --data-binary @- \
  | node -e 'let s = ""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => { const body = JSON.parse(s); if (!body.token) { console.error(s); process.exit(1); } process.stdout.write(body.token + "\n"); });' \
  > ~/.chaop/connector.token

chmod 600 ~/.chaop/connector.token
unset CHAOP_BOOTSTRAP_SECRET
```

把返回的 connector token 存到 connector config 中 `token_file` 指向的位置。Worker 只会在 D1 中保存 token hash。如果你需要检查 bootstrap response 里的 `connector_id` 或 `control_url`，可以用同一条命令，但去掉最后的 `node` 提取步骤，并把 response 重定向到仓库外的本地私有文件。

运行 connector loop：

```bash
cargo run -p chaop-agent -- --config /path/to/agent.toml --connect
```

如果只跑一个 command 的 smoke test，使用：

```bash
cargo run -p chaop-agent -- --config /path/to/agent.toml --connect --run-once
```

### 我需要你提供什么

下一轮实现时，部署实例值不要放进本仓库。非密钥实例值放进私有部署仓库或本地已忽略 env 文件；密钥请放到我们约定的安全渠道。

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
CF_ACCESS_CLIENT_ID
CF_ACCESS_CLIENT_SECRET
CHAOP_FIRST_CONNECTOR_NAME
CHAOP_FIRST_WORKSPACE_ROOT
```

### 故障排查

- 如果 Wrangler 无法认证，检查 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。
- 如果 Browser 返回 `403`，检查 Access application AUD、team domain 和允许访问的用户策略。
- 如果 service-token smoke tests 收到 Worker 返回的身份类 `401`，检查 Access policy 是否允许该 service token，以及 service-token headers 是否能到达 API route。
- 如果 Browser command submission 在到达 Worker 前失败，检查请求是否已经变成 CORS preflight；要么保持 simple request 形态，要么允许 `OPTIONS /api/*` 通过 Cloudflare Access。
- 如果 connector 返回 `401`，检查 `AGENT_BOOTSTRAP_SECRET`，并确认 `/connector/bootstrap` 和 `/ws/agent` 没有被 Browser Access 拦截。
- 如果 private CLI fallback 返回 `Codex executable not found`，请把 `execution.codex_command` 设置成 connector process 可执行的绝对路径，例如当前 macOS 部署中的 `/opt/homebrew/bin/codex`。这和被 attach session 的 `cwd` 是两回事。
- 如果 app-server execution 在 turn 开始前失败，检查 `execution.mode = "app_server"`、`session_inventory.app_server_url` 是否已设置、目标 Chaop thread 是否已经 attach 到 app-server Host Session，以及 app-server 是否正在配置的 listener 上运行。
- 如果 connector 已连接但一直收不到 command，检查 connector bootstrap 是否已经写入 workspace membership，command 是否 target 到可执行 connector，以及已部署 Worker 是否绑定 `WorkspaceDO`。
- 如果 New local thread 返回 app-server 错误，检查 `codex app-server --listen ws://127.0.0.1:9876` 是否正在运行、`session_inventory.app_server_url` 是否匹配，以及修改配置后是否已经重启 connector。
- 如果 Host Sessions 页面为空或过期，先使用 Host Sessions refresh 按钮，再等待最多 `session_inventory.report_interval_seconds`，并检查 connector 是否已经在本切片后重启、`session_inventory.enabled` 是否为 true，以及运行 connector 的用户是否可以读取 `CODEX_HOME` 或 `~/.codex`。
- 如果 attach 之后的历史 Host Session 仍只显示少量 events，检查 connector 运行用户是否可以读取匹配的 `~/.codex/sessions/**/rollout-*.jsonl` 文件。Backfill 会刻意限制为“单个明确 attach 的 session 的短摘要”；完整 transcript 和 artefact capture 仍留到后续切片。
- 如果 D1 migration 失败，确认 D1 database UUID 已写入 Worker 配置。
- 如果 R2 写入失败，确认 bucket 已创建，并且 Worker binding 名称与实现一致。
