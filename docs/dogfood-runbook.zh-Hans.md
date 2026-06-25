[ [British English](dogfood-runbook.md) | 简体中文 ]

# Dogfood Connector 运行手册

## 目的

这份手册覆盖日常 Chaop dogfood 使用的本机常驻 connector。它假设你已经按[部署指南](deployment-guide.zh-Hans.md)准备好了 Cloudflare 部署、Access 策略、connector bootstrap secret 和 connector token。

运行目标很窄：让一台本机 connector 和它管理的 Codex app-server 保持健康、可观察、容易停止，并且在无人使用 Chaop 时不继续增加成本。

## 安全姿态

- 开始长时间 dogfood 前，先看 Budget Board。
- 宽泛的 Host Session inventory 保持按需触发。只有需要新列表时才使用 Browser 里的 refresh control。
- 用户可见工作流优先使用 `execution.mode = "app_server"`。
- 除非明确要测试 private fallback path，否则保持 `execution.mode = "codex_exec"` 关闭。
- Chaop 长时间闲置时停止 connector。

## 私有配置

connector TOML、connector token、bootstrap secret 和本机路径都放在本仓库之外。dogfood connector 配置建议使用这个形状：

```toml
connector_name = "workstation"
control_url = "wss://api.example.com/ws/agent"
bootstrap_url = "https://api.example.com/connector/bootstrap"
workspace_root = "/path/to/workspaces"
token_file = "/path/to/private/connector.token"
spool_db = "/path/to/private/connector-spool.sqlite"

[bootstrap]
secret_file = "/path/to/private/bootstrap.secret"

[execution]
mode = "app_server"
codex_command = "/absolute/path/to/codex"
codex_timeout_seconds = 300
codex_output_max_bytes = 262144

[session_inventory]
enabled = true
max_sessions = 100
app_server_timeout_seconds = 2

[session_inventory.managed_app_server]
enabled = true
listen_url = "ws://127.0.0.1:9876"
startup_timeout_seconds = 10
restart_backoff_seconds = 5
drain_timeout_seconds = 300
scheduled_restart_interval_seconds = 86400
upgrade_marker_file = "/path/to/private/app-server-upgrade.marker"
```

常驻 connector 应使用绝对路径形式的 `codex_command`。启动服务和 SSH 会话通常不会继承交互式终端里的同一个 `PATH`。

## 持久化状态

dogfood 脚本默认把进程状态放在 `/tmp` 之外：

```text
${XDG_STATE_HOME:-$HOME/.local/state}/chaop/dogfood/
```

只通过私有环境变量覆盖位置：

```bash
export CHAOP_AGENT_CONFIG="/path/to/private/agent.toml"
export CHAOP_DOGFOOD_STATE_DIR="$HOME/.local/state/chaop/dogfood"
export CHAOP_DOGFOOD_UPGRADE_MARKER_FILE="/path/to/private/app-server-upgrade.marker"
```

脚本会在状态目录下写 PID file 和 connector log。它不会保存 Cloudflare API token、Access service-token secret、connector bootstrap secret 或 connector token。

## 命令

启动或恢复 connector：

```bash
pnpm dogfood:connector -- start
pnpm dogfood:connector -- recover
```

查看当前进程：

```bash
pnpm dogfood:connector -- status
pnpm dogfood:connector -- logs --lines 120
pnpm dogfood:connector -- logs --follow
```

验证配置可以加载，并检查 bootstrap request 形状是否正常：

```bash
pnpm dogfood:connector -- doctor
```

运行一次性的 connector session，用于窄范围 smoke：

```bash
pnpm dogfood:connector -- once
```

停止或重启 connector：

```bash
pnpm dogfood:connector -- stop
pnpm dogfood:connector -- restart
```

如果进程没有响应 graceful shutdown，可以有意识地使用 force 选项：

```bash
pnpm dogfood:connector -- stop --force
```

升级 Codex 或变更 app-server runtime assets 后，请求 managed app-server 重启：

```bash
pnpm dogfood:connector -- schedule-upgrade
```

只有当 `CHAOP_DOGFOOD_UPGRADE_MARKER_FILE` 指向的文件与私有 connector config 里的 `session_inventory.managed_app_server.upgrade_marker_file` 相同时，upgrade marker 才会生效。

## 观察清单

执行 `start` 或 `recover` 后：

- `status` 显示 `status=running`。
- log 中没有重复的 authentication、WebSocket 或 app-server startup errors。
- Operations Map 中 connector 显示 online。
- app-server listener 就绪后，Host Sessions 中的 managed app-server instance 显示 healthy。
- Thread Centre 可以创建或选择 app-server thread，并提交 prompt。
- 在进行高写入测试前，Budget Board 仍然显示 `normal` 或已知安全状态。

## 恢复

优先使用 `recover`。它会移除 stale PID file，并且只在没有已记录运行中进程时启动 connector。

如果 connector 反复出现 `401`，请按部署指南里的 bootstrap flow 轮换 connector token，并替换私有 `token_file`。

如果 managed app-server degraded：

1. 用 `logs` 检查 app-server startup error。
2. 确认 `codex_command` 是绝对路径且可执行。
3. 确认 `listen_url` 只绑定 loopback，并且没有被另一个进程占用。
4. 修复本机 Codex 安装后，touch upgrade marker 或运行 `restart`。

如果 UI 里 Host Sessions 陈旧，优先使用 Browser refresh button，而不是重启 connector。只有 connector offline、degraded，或仍在使用旧私有配置时才重启。

如果 Budget Board 进入 hard-limit state，请停止 connector，并暂停 write-path 测试，直到当前窗口恢复。
