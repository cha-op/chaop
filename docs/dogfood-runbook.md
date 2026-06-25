[ British English | [简体中文](dogfood-runbook.zh-Hans.md) ]

# Dogfood Connector Runbook

## Purpose

This runbook covers the persistent local connector used for daily Chaop dogfooding. It assumes the Cloudflare deployment, Access policy, connector bootstrap secret, and connector token have already been prepared from the [Deployment Guide](deployment-guide.md).

The operating goal is narrow: keep one local connector and its managed Codex app-server healthy, observable, and easy to stop without increasing cost while nobody is using Chaop.

## Safety Posture

- Check the Budget Board before starting long dogfood sessions.
- Keep broad Host Session inventory demand-driven. Use the Browser refresh control only when you need a fresh list.
- Prefer `execution.mode = "app_server"` for user-visible work.
- Leave `execution.mode = "codex_exec"` disabled unless you are intentionally testing the private fallback path.
- Stop the connector when Chaop is idle for an extended period.

## Private Configuration

Keep the connector TOML, connector token, bootstrap secret, and local paths outside this repository. A dogfood connector config should use this shape:

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

Use an absolute `codex_command` path for a persistent connector. Launch services and SSH sessions often do not inherit the same `PATH` as an interactive terminal.

## Persistent State

The dogfood script stores process state outside `/tmp` by default:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/chaop/dogfood/
```

Override the location only with private environment variables:

```bash
export CHAOP_AGENT_CONFIG="/path/to/private/agent.toml"
export CHAOP_DOGFOOD_STATE_DIR="$HOME/.local/state/chaop/dogfood"
export CHAOP_DOGFOOD_UPGRADE_MARKER_FILE="/path/to/private/app-server-upgrade.marker"
```

The script writes a PID file and connector log under the state directory. It does not store Cloudflare API tokens, Access service-token secrets, connector bootstrap secrets, or connector tokens.

## Commands

Start or recover the connector:

```bash
pnpm dogfood:connector -- start
pnpm dogfood:connector -- recover
```

Inspect the current process:

```bash
pnpm dogfood:connector -- status
pnpm dogfood:connector -- logs --lines 120
pnpm dogfood:connector -- logs --follow
```

Validate that the config loads and that the bootstrap request shape is still sane:

```bash
pnpm dogfood:connector -- doctor
```

Run a one-shot connector session for a narrow smoke:

```bash
pnpm dogfood:connector -- once
```

Stop or restart the connector:

```bash
pnpm dogfood:connector -- stop
pnpm dogfood:connector -- restart
```

If a process ignores graceful shutdown, use the force option deliberately:

```bash
pnpm dogfood:connector -- stop --force
```

Request a managed app-server restart after upgrading Codex or changing app-server runtime assets:

```bash
pnpm dogfood:connector -- schedule-upgrade
```

The upgrade marker only works when `CHAOP_DOGFOOD_UPGRADE_MARKER_FILE` points to the same file as `session_inventory.managed_app_server.upgrade_marker_file` in the private connector config.

## Observation Checklist

After `start` or `recover`:

- `status` shows `status=running`.
- The log has no repeating authentication, WebSocket, or app-server startup errors.
- Operations Map shows the connector online.
- Host Sessions shows a managed app-server instance as healthy once the app-server listener is ready.
- Thread Centre can create or select an app-server thread and submit a prompt.
- Budget Board still shows `normal` or a known safe state before write-heavy testing.

## Recovery

Use `recover` first. It removes a stale PID file and starts the connector only when no recorded process is running.

If the connector loops on `401`, rotate the connector token through the bootstrap flow in the Deployment Guide and replace the private `token_file`.

If the managed app-server is degraded:

1. Check `logs` for the app-server startup error.
2. Confirm `codex_command` is absolute and executable.
3. Confirm `listen_url` is loopback-only and not already owned by another process.
4. Touch the upgrade marker or run `restart` after fixing the local Codex install.

If the UI shows stale Host Sessions, prefer the Browser refresh button rather than restarting the connector. Restart only when the connector is offline, degraded, or running with outdated private config.

If Budget Board enters a hard-limit state, stop the connector and leave write-path testing paused until the current window has recovered.
