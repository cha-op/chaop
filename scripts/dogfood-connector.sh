#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

COMMAND=""
CONFIG_PATH="${CHAOP_AGENT_CONFIG:-${CHAOP_CONNECTOR_CONFIG:-}}"
STATE_DIR="${CHAOP_DOGFOOD_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/chaop/dogfood}"
LOG_DIR="${CHAOP_DOGFOOD_LOG_DIR:-}"
PID_FILE="${CHAOP_DOGFOOD_PID_FILE:-}"
PID_META_FILE="${CHAOP_DOGFOOD_PID_META_FILE:-}"
LOG_FILE="${CHAOP_DOGFOOD_LOG_FILE:-}"
AGENT_BIN="${CHAOP_AGENT_BIN:-}"
BUILD_PROFILE="${CHAOP_AGENT_BUILD_PROFILE:-release}"
HOSTNAME_VALUE="${CHAOP_HOSTNAME:-}"
LOG_LINES="${CHAOP_DOGFOOD_LOG_LINES:-80}"
STOP_TIMEOUT_SECONDS="${CHAOP_DOGFOOD_STOP_TIMEOUT_SECONDS:-15}"
NO_BUILD=0
FOLLOW_LOGS=0
FORCE_STOP=0

usage() {
  cat <<'USAGE'
Usage: scripts/dogfood-connector.sh [options] <command>

Commands:
  start             Build if needed and start the long-lived connector.
  stop              Stop the connector recorded in the pid file.
  restart           Stop, then start the connector.
  recover           Start the connector if it is not running; keep a running process intact.
  status            Print pid, log, state, config, and process state.
  logs              Print the connector log tail. Use --follow to stream.
  doctor            Validate config loading and print the bootstrap request shape.
  once              Run a single connector session with --run-once.
  schedule-upgrade  Touch the configured upgrade marker file.

Options:
  --config <path>       Connector TOML config. Defaults to CHAOP_AGENT_CONFIG.
  --state-dir <path>    Persistent dogfood state dir.
  --pid-file <path>     Pid file path.
  --pid-meta-file <p>   Pid metadata path. Default: <pid-file>.meta.
  --log-file <path>     Connector log path.
  --agent-bin <path>    Prebuilt chaop-agent binary.
  --build-profile <p>   release or debug. Default: release.
  --hostname <name>     Hostname used by doctor/bootstrap request output.
  --lines <n>           Log lines for logs/status. Default: 80.
  --no-build            Do not build chaop-agent when --agent-bin is not set.
  --follow              Follow logs for the logs command.
  --force               Force-kill on stop timeout.
  --help                Show this help.

Environment:
  CHAOP_AGENT_CONFIG
  CHAOP_AGENT_BIN
  CHAOP_DOGFOOD_STATE_DIR
  CHAOP_DOGFOOD_LOG_FILE
  CHAOP_DOGFOOD_PID_FILE
  CHAOP_DOGFOOD_PID_META_FILE
  CHAOP_DOGFOOD_UPGRADE_MARKER_FILE
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --config)
        CONFIG_PATH="${2:-}"
        [[ -n "$CONFIG_PATH" ]] || die "--config requires a path"
        shift 2
        ;;
      --state-dir)
        STATE_DIR="${2:-}"
        [[ -n "$STATE_DIR" ]] || die "--state-dir requires a path"
        shift 2
        ;;
      --pid-file)
        PID_FILE="${2:-}"
        [[ -n "$PID_FILE" ]] || die "--pid-file requires a path"
        shift 2
        ;;
      --pid-meta-file)
        PID_META_FILE="${2:-}"
        [[ -n "$PID_META_FILE" ]] || die "--pid-meta-file requires a path"
        shift 2
        ;;
      --log-file)
        LOG_FILE="${2:-}"
        [[ -n "$LOG_FILE" ]] || die "--log-file requires a path"
        shift 2
        ;;
      --agent-bin)
        AGENT_BIN="${2:-}"
        [[ -n "$AGENT_BIN" ]] || die "--agent-bin requires a path"
        shift 2
        ;;
      --build-profile)
        BUILD_PROFILE="${2:-}"
        [[ -n "$BUILD_PROFILE" ]] || die "--build-profile requires a value"
        shift 2
        ;;
      --hostname)
        HOSTNAME_VALUE="${2:-}"
        [[ -n "$HOSTNAME_VALUE" ]] || die "--hostname requires a value"
        shift 2
        ;;
      --lines)
        LOG_LINES="${2:-}"
        [[ "$LOG_LINES" =~ ^[0-9]+$ ]] || die "--lines requires a positive integer"
        shift 2
        ;;
      --no-build)
        NO_BUILD=1
        shift
        ;;
      --follow)
        FOLLOW_LOGS=1
        shift
        ;;
      --force)
        FORCE_STOP=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      --)
        shift
        ;;
      start|stop|restart|recover|status|logs|doctor|once|schedule-upgrade)
        [[ -z "$COMMAND" ]] || die "only one command can be supplied"
        COMMAND="$1"
        shift
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done

  [[ -n "$COMMAND" ]] || {
    usage >&2
    exit 2
  }
}

normalise_paths() {
  LOG_DIR="${LOG_DIR:-$STATE_DIR/logs}"
  PID_FILE="${PID_FILE:-$STATE_DIR/connector.pid}"
  PID_META_FILE="${PID_META_FILE:-$PID_FILE.meta}"
  LOG_FILE="${LOG_FILE:-$LOG_DIR/connector.log}"
  HOSTNAME_VALUE="${HOSTNAME_VALUE:-$(hostname)}"
}

ensure_state_dirs() {
  mkdir -p "$STATE_DIR" "$LOG_DIR" "$(dirname "$PID_FILE")" "$(dirname "$PID_META_FILE")" "$(dirname "$LOG_FILE")"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  touch "$LOG_FILE"
}

preflight_launch_files() {
  touch "$LOG_FILE" "$PID_FILE" "$PID_META_FILE"
  rm -f "$PID_FILE" "$PID_META_FILE"
}

ensure_config() {
  [[ -n "$CONFIG_PATH" ]] || die "set --config or CHAOP_AGENT_CONFIG"
  [[ -r "$CONFIG_PATH" ]] || die "connector config is not readable: $CONFIG_PATH"
}

ensure_agent_bin() {
  if [[ -n "$AGENT_BIN" ]]; then
    [[ -x "$AGENT_BIN" ]] || die "chaop-agent binary is not executable: $AGENT_BIN"
    printf '%s\n' "$AGENT_BIN"
    return
  fi

  case "$BUILD_PROFILE" in
    release)
      AGENT_BIN="$REPO_ROOT/target/release/chaop-agent"
      if [[ "$NO_BUILD" -eq 0 ]]; then
        cargo build -p chaop-agent --release
      fi
      ;;
    debug)
      AGENT_BIN="$REPO_ROOT/target/debug/chaop-agent"
      if [[ "$NO_BUILD" -eq 0 ]]; then
        cargo build -p chaop-agent
      fi
      ;;
    *)
      die "--build-profile must be release or debug"
      ;;
  esac

  [[ -x "$AGENT_BIN" ]] || die "chaop-agent binary is not executable: $AGENT_BIN"
  printf '%s\n' "$AGENT_BIN"
}

pid_from_file() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$pid"
}

is_pid_running() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

process_command() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

process_started_at() {
  local pid="$1"
  ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' || true
}

metadata_field() {
  local key="$1"
  [[ -f "$PID_META_FILE" ]] || return 1
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found = 1 } END { exit found ? 0 : 1 }' "$PID_META_FILE"
}

write_pid_metadata() {
  local pid="$1"
  local agent_bin="$2"
  local started_at
  started_at="$(process_started_at "$pid")"
  {
    printf 'pid=%s\n' "$pid"
    printf 'started_at=%s\n' "$started_at"
    printf 'agent_bin=%s\n' "$agent_bin"
    printf 'config=%s\n' "$CONFIG_PATH"
  } > "$PID_META_FILE"
}

pid_matches_metadata() {
  local pid="$1"
  local recorded_pid recorded_started_at current_started_at
  recorded_pid="$(metadata_field pid)" || return 1
  recorded_started_at="$(metadata_field started_at)" || return 1
  [[ "$recorded_pid" == "$pid" ]] || return 1
  [[ -n "$recorded_started_at" ]] || return 0
  current_started_at="$(process_started_at "$pid")"
  [[ "$current_started_at" == "$recorded_started_at" ]]
}

pid_matches_connector() {
  local pid="$1"
  if pid_matches_metadata "$pid"; then
    return 0
  fi
  local command_line
  command_line="$(process_command "$pid")"
  [[ "$command_line" == *"--connect"* ]] || return 1
  if [[ -n "$CONFIG_PATH" ]]; then
    [[ "$command_line" == *"$CONFIG_PATH"* ]] || return 1
  fi
}

current_pid() {
  local pid
  pid="$(pid_from_file)" || return 1
  is_pid_running "$pid" || return 1
  pid_matches_connector "$pid" || return 1
  printf '%s\n' "$pid"
}

remove_stale_pid_file() {
  local pid
  if pid="$(pid_from_file)" && ! is_pid_running "$pid"; then
    rm -f "$PID_FILE" "$PID_META_FILE"
  fi
}

print_status() {
  normalise_paths
  local pid
  printf 'state_dir=%s\n' "$STATE_DIR"
  printf 'pid_file=%s\n' "$PID_FILE"
  printf 'pid_meta_file=%s\n' "$PID_META_FILE"
  printf 'log_file=%s\n' "$LOG_FILE"
  if [[ -n "$CONFIG_PATH" ]]; then
    printf 'config=%s\n' "$CONFIG_PATH"
  fi
  if pid="$(current_pid)"; then
    printf 'status=running\n'
    printf 'pid=%s\n' "$pid"
    printf 'process=%s\n' "$(process_command "$pid")"
  elif pid="$(pid_from_file)" && is_pid_running "$pid"; then
    printf 'status=pid-file-points-to-other-process\n'
    printf 'pid=%s\n' "$pid"
    printf 'process=%s\n' "$(process_command "$pid")"
  else
    remove_stale_pid_file
    printf 'status=stopped\n'
  fi
}

start_connector() {
  normalise_paths
  ensure_config
  ensure_state_dirs
  remove_stale_pid_file
  local pid
  if pid="$(current_pid)"; then
    printf 'connector already running with pid %s\n' "$pid"
    return 0
  fi
  if pid="$(pid_from_file)" && is_pid_running "$pid"; then
    die "pid file points to a different running process; refusing to start another connector"
  fi
  preflight_launch_files

  local agent_bin
  agent_bin="$(ensure_agent_bin)"
  {
    printf '\n[%s] starting connector\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'agent_bin=%s\n' "$agent_bin"
    printf 'config=%s\n' "$CONFIG_PATH"
  } >> "$LOG_FILE"

  nohup "$agent_bin" --config "$CONFIG_PATH" --connect >> "$LOG_FILE" 2>&1 &
  pid="$!"
  printf '%s\n' "$pid" > "$PID_FILE"
  write_pid_metadata "$pid" "$agent_bin"
  sleep 1
  if ! is_pid_running "$pid"; then
    printf 'connector exited during startup; recent log follows:\n' >&2
    tail -n "$LOG_LINES" "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE" "$PID_META_FILE"
    exit 1
  fi
  printf 'connector started with pid %s\n' "$pid"
  printf 'log_file=%s\n' "$LOG_FILE"
}

stop_connector() {
  normalise_paths
  local pid
  if pid="$(pid_from_file)" && is_pid_running "$pid" && ! pid_matches_connector "$pid"; then
    die "pid file points to a different running process; refusing to stop pid $pid"
  fi
  if ! pid="$(current_pid)"; then
    remove_stale_pid_file
    printf 'connector is not running\n'
    return 0
  fi

  printf 'stopping connector pid %s\n' "$pid"
  kill -TERM "$pid"
  local waited=0
  while is_pid_running "$pid"; do
    if [[ "$waited" -ge "$STOP_TIMEOUT_SECONDS" ]]; then
      if [[ "$FORCE_STOP" -eq 1 ]]; then
        printf 'force killing connector pid %s after %s seconds\n' "$pid" "$STOP_TIMEOUT_SECONDS"
        kill -KILL "$pid" 2>/dev/null || true
        break
      fi
      die "connector did not stop after ${STOP_TIMEOUT_SECONDS}s; rerun stop --force if needed"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  rm -f "$PID_FILE" "$PID_META_FILE"
  printf 'connector stopped\n'
}

recover_connector() {
  normalise_paths
  if current_pid >/dev/null; then
    print_status
    return 0
  fi
  remove_stale_pid_file
  start_connector
}

show_logs() {
  normalise_paths
  [[ -f "$LOG_FILE" ]] || die "log file does not exist: $LOG_FILE"
  if [[ "$FOLLOW_LOGS" -eq 1 ]]; then
    tail -n "$LOG_LINES" -f "$LOG_FILE"
  else
    tail -n "$LOG_LINES" "$LOG_FILE"
  fi
}

doctor() {
  normalise_paths
  ensure_config
  local agent_bin
  agent_bin="$(ensure_agent_bin)"
  "$agent_bin" --config "$CONFIG_PATH" --hostname "$HOSTNAME_VALUE"
}

run_once() {
  normalise_paths
  ensure_config
  local agent_bin
  agent_bin="$(ensure_agent_bin)"
  "$agent_bin" --config "$CONFIG_PATH" --connect --run-once
}

schedule_upgrade() {
  local marker="${CHAOP_DOGFOOD_UPGRADE_MARKER_FILE:-${CHAOP_APP_SERVER_UPGRADE_MARKER_FILE:-}}"
  [[ -n "$marker" ]] || die "set CHAOP_DOGFOOD_UPGRADE_MARKER_FILE to the private upgrade_marker_file path"
  mkdir -p "$(dirname "$marker")"
  touch "$marker"
  printf 'upgrade marker touched: %s\n' "$marker"
}

parse_args "$@"
normalise_paths

case "$COMMAND" in
  start)
    start_connector
    ;;
  stop)
    stop_connector
    ;;
  restart)
    stop_connector
    start_connector
    ;;
  recover)
    recover_connector
    ;;
  status)
    print_status
    ;;
  logs)
    show_logs
    ;;
  doctor)
    doctor
    ;;
  once)
    run_once
    ;;
  schedule-upgrade)
    schedule_upgrade
    ;;
esac
