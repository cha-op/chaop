#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

COMMAND=""
CONFIG_PATH="${CHAOP_AGENT_CONFIG:-${CHAOP_CONNECTOR_CONFIG:-}}"
STATE_DIR="${CHAOP_DOGFOOD_STATE_DIR:-}"
LOG_DIR="${CHAOP_DOGFOOD_LOG_DIR:-}"
PID_FILE="${CHAOP_DOGFOOD_PID_FILE:-}"
PID_META_FILE="${CHAOP_DOGFOOD_PID_META_FILE:-}"
LOG_FILE="${CHAOP_DOGFOOD_LOG_FILE:-}"
LOCK_DIR="${CHAOP_DOGFOOD_LOCK_DIR:-}"
AGENT_BIN="${CHAOP_AGENT_BIN:-}"
BUILD_PROFILE="${CHAOP_AGENT_BUILD_PROFILE:-release}"
HOSTNAME_VALUE="${CHAOP_HOSTNAME:-}"
LOG_LINES="${CHAOP_DOGFOOD_LOG_LINES:-80}"
STOP_TIMEOUT_SECONDS="${CHAOP_DOGFOOD_STOP_TIMEOUT_SECONDS:-15}"
LOCK_TIMEOUT_SECONDS="${CHAOP_DOGFOOD_LOCK_TIMEOUT_SECONDS:-15}"
START_FAILURE_STOP_TIMEOUT_SECONDS="${CHAOP_DOGFOOD_START_FAILURE_STOP_TIMEOUT_SECONDS:-5}"
NO_BUILD=0
FOLLOW_LOGS=0
FORCE_STOP=0
LOCK_ACQUIRED=0
STARTED_CHILD_PID=""

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
  CHAOP_DOGFOOD_LOCK_DIR
  CHAOP_DOGFOOD_LOCK_TIMEOUT_SECONDS
  CHAOP_DOGFOOD_START_FAILURE_STOP_TIMEOUT_SECONDS
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
  if [[ -z "$STATE_DIR" ]]; then
    STATE_DIR="$(default_state_dir)"
  fi
  LOG_DIR="${LOG_DIR:-$STATE_DIR/logs}"
  PID_FILE="${PID_FILE:-$STATE_DIR/connector.pid}"
  PID_META_FILE="${PID_META_FILE:-$PID_FILE.meta}"
  LOG_FILE="${LOG_FILE:-$LOG_DIR/connector.log}"
  LOCK_DIR="${LOCK_DIR:-$STATE_DIR/connector.lock}"
  HOSTNAME_VALUE="${HOSTNAME_VALUE:-$(hostname)}"
}

default_state_dir() {
  if [[ -n "${XDG_STATE_HOME:-}" ]]; then
    printf '%s/chaop/dogfood\n' "$XDG_STATE_HOME"
    return 0
  fi
  if [[ -n "${HOME:-}" ]]; then
    printf '%s/.local/state/chaop/dogfood\n' "$HOME"
    return 0
  fi
  die "set --state-dir or CHAOP_DOGFOOD_STATE_DIR when HOME and XDG_STATE_HOME are unset"
}

resolve_existing_path() {
  local path_value="$1"
  local parent_dir base_name resolved_parent
  parent_dir="$(dirname "$path_value")"
  base_name="$(basename "$path_value")"
  resolved_parent="$(cd "$parent_dir" && pwd -P)"
  printf '%s/%s\n' "$resolved_parent" "$base_name"
}

resolve_existing_dir_path() {
  local path_value="$1"
  cd "$path_value" && pwd -P
}

state_mode() {
  local file_path="$1"
  case "$(uname -s)" in
    Darwin|FreeBSD|OpenBSD|NetBSD)
      stat -f '%Lp' "$file_path"
      ;;
    *)
      stat -c '%a' "$file_path"
      ;;
  esac
}

state_file_path_key() {
  local file_path="$1"
  local parent_dir base_name resolved_parent
  parent_dir="$(dirname "$file_path")"
  base_name="$(basename "$file_path")"
  resolved_parent="$(cd "$parent_dir" && pwd -P)"
  printf '%s/%s\n' "$resolved_parent" "$base_name"
}

state_file_identity() {
  local file_path="$1"
  case "$(uname -s)" in
    Darwin|FreeBSD|OpenBSD|NetBSD)
      stat -f '%d:%i' "$file_path"
      ;;
    *)
      stat -c '%d:%i' "$file_path"
      ;;
  esac
}

path_has_parent_reference() {
  local path_value="$1"
  local IFS='/'
  local -a parts
  read -r -a parts <<< "$path_value"
  local part
  for part in "${parts[@]}"; do
    [[ "$part" == ".." ]] && return 0
  done
  return 1
}

ensure_physical_state_subpath() {
  local path_value="$1"
  local state_root="$2"
  local parent_dir nearest_parent nearest_real path_real
  path_has_parent_reference "$path_value" && die "state paths must not contain ..: $path_value"

  if [[ -e "$path_value" ]]; then
    if [[ -d "$path_value" ]]; then
      path_real="$(resolve_existing_dir_path "$path_value")"
    else
      path_real="$(resolve_existing_path "$path_value")"
    fi
    case "$path_real" in
      "$state_root"|"$state_root"/*)
        return 0
        ;;
    esac
    die "state paths must stay under --state-dir: $path_value"
  fi

  parent_dir="$(dirname "$path_value")"
  nearest_parent="$parent_dir"
  while [[ ! -e "$nearest_parent" ]]; do
    local next_parent
    next_parent="$(dirname "$nearest_parent")"
    [[ "$next_parent" != "$nearest_parent" ]] || break
    nearest_parent="$next_parent"
  done
  nearest_real="$(cd "$nearest_parent" && pwd -P)" || die "could not inspect state path parent: $path_value"
  case "$nearest_real" in
    "$state_root"|"$state_root"/*)
      ;;
    *)
      die "state paths must stay under --state-dir: $path_value"
      ;;
  esac
}

ensure_physical_dir_under_state() {
  local dir_path="$1"
  local state_root="$2"
  local dir_real
  dir_real="$(resolve_existing_dir_path "$dir_path")"
  case "$dir_real" in
    "$state_root"|"$state_root"/*)
      ;;
    *)
      die "state directory resolved outside --state-dir: $dir_path"
      ;;
  esac
}

ensure_distinct_state_paths() {
  local pid_path meta_path log_path
  pid_path="$(state_file_path_key "$PID_FILE")"
  meta_path="$(state_file_path_key "$PID_META_FILE")"
  log_path="$(state_file_path_key "$LOG_FILE")"
  if [[ "$pid_path" == "$meta_path" || "$pid_path" == "$log_path" || "$meta_path" == "$log_path" ]]; then
    die "pid, pid metadata, and log files must be distinct paths"
  fi
}

ensure_distinct_state_file_identities() {
  local pid_id meta_id log_id
  pid_id="$(state_file_identity "$PID_FILE")"
  meta_id="$(state_file_identity "$PID_META_FILE")"
  log_id="$(state_file_identity "$LOG_FILE")"
  if [[ "$pid_id" == "$meta_id" || "$pid_id" == "$log_id" || "$meta_id" == "$log_id" ]]; then
    die "pid, pid metadata, and log files must not point to the same file"
  fi
}

ensure_private_dir() {
  local dir_path="$1"
  local mode existed=0
  [[ -e "$dir_path" ]] && existed=1
  mkdir -p "$dir_path"
  if [[ "$existed" -eq 0 ]]; then
    chmod 700 "$dir_path" 2>/dev/null || true
  fi
  mode="$(state_mode "$dir_path")" || die "could not inspect directory permissions: $dir_path"
  if (( (8#$mode & 077) != 0 )); then
    die "state directory must not be group/other accessible: $dir_path"
  fi
}

ensure_state_root() {
  ensure_private_dir "$STATE_DIR"
  resolve_existing_dir_path "$STATE_DIR"
}

ensure_private_state_dir() {
  local dir_path="$1"
  local state_root="$2"
  local mode existed=0
  ensure_physical_state_subpath "$dir_path" "$state_root"
  [[ -e "$dir_path" ]] && existed=1
  mkdir -p "$dir_path"
  ensure_physical_dir_under_state "$dir_path" "$state_root"
  if [[ "$existed" -eq 0 ]]; then
    chmod 700 "$dir_path" 2>/dev/null || true
  fi
  mode="$(state_mode "$dir_path")" || die "could not inspect directory permissions: $dir_path"
  if (( (8#$mode & 077) != 0 )); then
    die "state directory must not be group/other accessible: $dir_path"
  fi
  ensure_physical_dir_under_state "$dir_path" "$state_root"
}

state_file_is_safe() {
  local file_path="$1"
  [[ ! -L "$file_path" ]] || return 1
  [[ ! -e "$file_path" || -f "$file_path" ]]
}

ensure_state_file_is_safe() {
  local file_path="$1"
  state_file_is_safe "$file_path" || die "state file must be a regular file or absent: $file_path"
}

state_files_are_safe() {
  state_file_is_safe "$PID_FILE" || return 1
  state_file_is_safe "$PID_META_FILE" || return 1
  state_file_is_safe "$LOG_FILE" || return 1
}

ensure_safe_state_files() {
  ensure_state_file_is_safe "$PID_FILE"
  ensure_state_file_is_safe "$PID_META_FILE"
  ensure_state_file_is_safe "$LOG_FILE"
}

ensure_lock_dir_not_symlink() {
  [[ ! -L "$LOCK_DIR" ]] || die "state lock directory must not be a symlink: $LOCK_DIR"
}

ensure_state_safety() {
  local state_root
  state_root="$(ensure_state_root)"
  ensure_private_state_dir "$LOG_DIR" "$state_root"
  ensure_private_state_dir "$(dirname "$PID_FILE")" "$state_root"
  ensure_private_state_dir "$(dirname "$PID_META_FILE")" "$state_root"
  ensure_private_state_dir "$(dirname "$LOG_FILE")" "$state_root"
  ensure_distinct_state_paths
  ensure_safe_state_files
}

ensure_state_dirs() {
  ensure_state_safety
  touch "$LOG_FILE"
  ensure_safe_state_files
}

preflight_launch_files() {
  ensure_safe_state_files
  touch "$LOG_FILE" "$PID_FILE" "$PID_META_FILE"
  ensure_safe_state_files
  ensure_distinct_state_file_identities
  rm -f "$PID_FILE" "$PID_META_FILE"
}

acquire_state_lock() {
  local state_root
  state_root="$(ensure_state_root)"
  ensure_physical_state_subpath "$LOCK_DIR" "$state_root"
  ensure_private_state_dir "$(dirname "$LOCK_DIR")" "$state_root"
  local waited=0
  while true; do
    ensure_lock_dir_not_symlink
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      if write_lock_owner; then
        LOCK_ACQUIRED=1
        chmod 700 "$LOCK_DIR" 2>/dev/null || true
        return 0
      fi
      rm -f "$LOCK_DIR/owner.pid" "$LOCK_DIR/owner.started_at"
      rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
    local remove_ownerless=0
    local remove_unknown_owner=0
    [[ "$waited" -gt 0 ]] && remove_ownerless=1
    [[ "$waited" -ge "$LOCK_TIMEOUT_SECONDS" ]] && remove_unknown_owner=1
    remove_stale_lock_dir "$remove_ownerless" "$remove_unknown_owner"
    if [[ ! -e "$LOCK_DIR" ]]; then
      continue
    fi
    if [[ "$waited" -ge "$LOCK_TIMEOUT_SECONDS" ]]; then
      die "could not acquire connector state lock: $LOCK_DIR"
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

write_lock_owner() {
  local owner_started_at
  owner_started_at="$(process_started_at "$$")" || true
  printf '%s\n' "$$" > "$LOCK_DIR/owner.pid" || return 1
  if [[ -n "$owner_started_at" ]]; then
    printf '%s\n' "$owner_started_at" > "$LOCK_DIR/owner.started_at" || return 1
  fi
}

remove_stale_lock_dir() {
  local remove_ownerless="${1:-0}"
  local remove_unknown_owner="${2:-0}"
  local owner_file="$LOCK_DIR/owner.pid"
  local owner_started_at_file="$LOCK_DIR/owner.started_at"
  local owner_pid=""
  local owner_started_at=""
  ensure_lock_dir_not_symlink
  if [[ -f "$owner_file" ]]; then
    owner_pid="$(tr -d '[:space:]' < "$owner_file")"
    if is_pid_running "$owner_pid"; then
      if [[ -f "$owner_started_at_file" ]]; then
        owner_started_at="$(sed 's/^[[:space:]]*//; s/[[:space:]]*$//' "$owner_started_at_file")"
        if [[ -n "$owner_started_at" && "$(process_started_at "$owner_pid")" == "$owner_started_at" ]]; then
          return 0
        fi
      elif [[ "$remove_unknown_owner" -eq 0 ]]; then
        return 0
      fi
    fi
    rm -f "$owner_file" "$owner_started_at_file"
    rmdir "$LOCK_DIR" 2>/dev/null || true
    return 0
  fi
  if [[ "$remove_ownerless" -eq 1 ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}

release_state_lock() {
  if [[ "$LOCK_ACQUIRED" -eq 1 ]]; then
    rm -f "$LOCK_DIR/owner.pid" "$LOCK_DIR/owner.started_at"
    rmdir "$LOCK_DIR" 2>/dev/null || true
    LOCK_ACQUIRED=0
  fi
}

handle_lock_signal() {
  local signal_name="$1"
  local exit_status=143
  [[ "$signal_name" == "INT" ]] && exit_status=130
  if [[ -n "$STARTED_CHILD_PID" ]]; then
    stop_start_failure_child "$STARTED_CHILD_PID"
    rm -f "$PID_FILE" "$PID_META_FILE"
    STARTED_CHILD_PID=""
  fi
  release_state_lock
  trap - EXIT INT TERM
  exit "$exit_status"
}

with_state_lock() {
  normalise_paths
  acquire_state_lock
  trap release_state_lock EXIT
  trap 'handle_lock_signal INT' INT
  trap 'handle_lock_signal TERM' TERM
  local status=0
  "$@" || status=$?
  release_state_lock
  trap - EXIT INT TERM
  return "$status"
}

ensure_config() {
  [[ -n "$CONFIG_PATH" ]] || die "set --config or CHAOP_AGENT_CONFIG"
  [[ -r "$CONFIG_PATH" ]] || die "connector config is not readable: $CONFIG_PATH"
  CONFIG_PATH="$(resolve_existing_path "$CONFIG_PATH")"
}

cargo_target_dir() {
  local metadata target_dir
  metadata="$(cd "$REPO_ROOT" && cargo metadata --format-version 1 --no-deps 2>/dev/null)" || die "could not inspect Cargo target directory"
  if command -v node >/dev/null 2>&1; then
    target_dir="$(printf '%s' "$metadata" | node -e 'const fs = require("fs"); const input = fs.readFileSync(0, "utf8"); const metadata = JSON.parse(input); if (typeof metadata.target_directory !== "string" || metadata.target_directory.length === 0) process.exit(1); process.stdout.write(metadata.target_directory);')" || true
  else
    target_dir="$(printf '%s\n' "$metadata" | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')"
  fi
  [[ -n "$target_dir" ]] || die "could not parse Cargo target directory"
  printf '%s\n' "$target_dir"
}

ensure_agent_bin() {
  if [[ -n "$AGENT_BIN" ]]; then
    [[ -x "$AGENT_BIN" ]] || die "chaop-agent binary is not executable: $AGENT_BIN"
    AGENT_BIN="$(resolve_existing_path "$AGENT_BIN")"
    printf '%s\n' "$AGENT_BIN"
    return
  fi

  local target_dir
  target_dir="$(cargo_target_dir)"
  case "$BUILD_PROFILE" in
    release)
      AGENT_BIN="$target_dir/release/chaop-agent"
      if [[ "$NO_BUILD" -eq 0 ]]; then
        (cd "$REPO_ROOT" && cargo build -p chaop-agent --release)
      fi
      ;;
    debug)
      AGENT_BIN="$target_dir/debug/chaop-agent"
      if [[ "$NO_BUILD" -eq 0 ]]; then
        (cd "$REPO_ROOT" && cargo build -p chaop-agent)
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
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  ps -p "$pid" >/dev/null 2>&1 || return 1
  ! is_pid_zombie "$pid"
}

is_pid_zombie() {
  local pid="$1"
  local state=""
  if [[ -r "/proc/$pid/stat" ]]; then
    local stat_line stat_tail
    stat_line="$(< "/proc/$pid/stat")" || return 1
    stat_tail="${stat_line##*) }"
    state="${stat_tail%% *}"
  else
    state="$(ps -p "$pid" -o stat= 2>/dev/null | awk 'NR == 1 { print substr($1, 1, 1) }')" || return 1
  fi
  [[ "$state" == "Z" ]]
}

process_command() {
  local pid="$1"
  case "$(uname -s)" in
    Darwin|FreeBSD|OpenBSD|NetBSD)
      ps -ww -p "$pid" -o command= 2>/dev/null || true
      ;;
    *)
      ps -ww -p "$pid" -o command= 2>/dev/null || ps -p "$pid" -o command= 2>/dev/null || true
      ;;
  esac
}

process_argv_matches() {
  local pid="$1"
  local recorded_agent_bin="$2"
  local recorded_config="$3"
  if [[ ! -r "/proc/$pid/cmdline" ]]; then
    return 2
  fi
  local -a argv
  mapfile -t argv < <(tr '\0' '\n' < "/proc/$pid/cmdline")
  [[ "${#argv[@]}" -gt 0 ]] || return 2
  [[ "${argv[0]:-}" == "$recorded_agent_bin" ]] || return 1
  [[ "${argv[1]:-}" == "--config" ]] || return 1
  [[ "${argv[2]:-}" == "$recorded_config" ]] || return 1
  [[ "${argv[3]:-}" == "--connect" ]] || return 1
  [[ "${#argv[@]}" -eq 4 ]] || return 1
}

process_run_token_matches() {
  local pid="$1"
  local recorded_run_token="$2"
  if [[ ! -r "/proc/$pid/environ" ]]; then
    return 2
  fi
  tr '\0' '\n' < "/proc/$pid/environ" | grep -Fx "CHAOP_DOGFOOD_RUN_TOKEN=$recorded_run_token" >/dev/null
}

process_started_at() {
  local pid="$1"
  ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' || true
}

wait_for_process_started_at() {
  local pid="$1"
  local started_at=""
  for _ in {1..10}; do
    started_at="$(process_started_at "$pid")"
    if [[ -n "$started_at" ]]; then
      printf '%s\n' "$started_at"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

new_run_token() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen
    return 0
  fi
  printf '%s-%s-%s\n' "$$" "$(date -u '+%Y%m%dT%H%M%SZ')" "$RANDOM"
}

metadata_field() {
  local key="$1"
  [[ -f "$PID_META_FILE" ]] || return 1
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found = 1 } END { exit found ? 0 : 1 }' "$PID_META_FILE"
}

write_pid_metadata() {
  local pid="$1"
  local agent_bin="$2"
  local run_token="$3"
  local started_at
  started_at="$(wait_for_process_started_at "$pid")" || return 1
  state_files_are_safe || return 1
  if ! {
    printf 'pid=%s\n' "$pid"
    printf 'run_token=%s\n' "$run_token"
    printf 'started_at=%s\n' "$started_at"
    printf 'agent_bin=%s\n' "$agent_bin"
    printf 'config=%s\n' "$CONFIG_PATH"
  } > "$PID_META_FILE"; then
    return 1
  fi
}

write_started_child_state() {
  local pid="$1"
  local agent_bin="$2"
  local run_token="$3"
  state_files_are_safe || return 1
  printf '%s\n' "$pid" > "$PID_FILE" || return 1
  write_pid_metadata "$pid" "$agent_bin" "$run_token"
}

pid_matches_metadata() {
  local pid="$1"
  local recorded_pid recorded_run_token recorded_started_at recorded_agent_bin recorded_config current_started_at command_line
  recorded_pid="$(metadata_field pid)" || return 1
  recorded_run_token="$(metadata_field run_token)" || return 1
  recorded_started_at="$(metadata_field started_at)" || return 1
  recorded_agent_bin="$(metadata_field agent_bin)" || return 1
  recorded_config="$(metadata_field config)" || return 1
  [[ "$recorded_pid" == "$pid" ]] || return 1
  [[ -n "$recorded_run_token" ]] || return 1
  [[ -n "$recorded_started_at" ]] || return 1
  [[ -n "$recorded_agent_bin" ]] || return 1
  [[ -n "$recorded_config" ]] || return 1
  current_started_at="$(process_started_at "$pid")"
  [[ -n "$current_started_at" ]] || return 1
  [[ "$current_started_at" == "$recorded_started_at" ]] || return 1
  local token_status=0
  if process_run_token_matches "$pid" "$recorded_run_token"; then
    :
  else
    token_status=$?
  fi
  [[ "$token_status" -eq 0 || "$token_status" -eq 2 ]] || return 1
  local argv_status=0
  if process_argv_matches "$pid" "$recorded_agent_bin" "$recorded_config"; then
    return 0
  else
    argv_status=$?
  fi
  [[ "$argv_status" -eq 2 ]] || return 1
  command_line="$(process_command "$pid")"
  [[ "$command_line" == "$recorded_agent_bin --config $recorded_config --connect" ]]
}

stop_start_failure_child() {
  local pid="$1"
  local waited=0
  kill -TERM "$pid" 2>/dev/null || true
  while is_pid_running "$pid"; do
    if [[ "$waited" -ge "$START_FAILURE_STOP_TIMEOUT_SECONDS" ]]; then
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null || true
}

child_pids_of() {
  local parent_pid="$1"
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -P "$parent_pid" 2>/dev/null || true
    return 0
  fi
  ps -o pid= --ppid "$parent_pid" 2>/dev/null | awk '{ print $1 }' || true
}

process_group_pids() {
  local group_id="$1"
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -g "$group_id" 2>/dev/null || true
    return 0
  fi
  ps -o pid= -g "$group_id" 2>/dev/null | awk '{ print $1 }' || true
}

signal_child_pid_list() {
  local child_pids="$1"
  local signal_name="$2"
  local child_pid
  while IFS= read -r child_pid; do
    [[ "$child_pid" =~ ^[0-9]+$ ]] || continue
    kill "-$signal_name" "-$child_pid" 2>/dev/null || true
    if is_pid_running "$child_pid"; then
      kill "-$signal_name" "$child_pid" 2>/dev/null || true
    fi
  done <<< "$child_pids"
}

child_pid_list_has_running() {
  local child_pids="$1"
  local child_pid group_pid
  while IFS= read -r child_pid; do
    [[ "$child_pid" =~ ^[0-9]+$ ]] || continue
    while IFS= read -r group_pid; do
      [[ "$group_pid" =~ ^[0-9]+$ ]] || continue
      is_pid_running "$group_pid" && return 0
    done < <(process_group_pids "$child_pid")
    is_pid_running "$child_pid" && return 0
  done <<< "$child_pids"
  return 1
}

wait_for_child_pid_list_exit() {
  local child_pids="$1"
  local waited=0
  while child_pid_list_has_running "$child_pids"; do
    if [[ "$waited" -ge "$START_FAILURE_STOP_TIMEOUT_SECONDS" ]]; then
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

pid_matches_connector() {
  local pid="$1"
  pid_matches_metadata "$pid"
}

pid_matches_connector_hint() {
  local pid="$1"
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
  if ! pid="$(pid_from_file)"; then
    return 0
  fi
  if ! is_pid_running "$pid"; then
    rm -f "$PID_FILE" "$PID_META_FILE"
    return 0
  fi
  if pid_matches_connector "$pid" || pid_matches_connector_hint "$pid"; then
    return 0
  fi
  rm -f "$PID_FILE" "$PID_META_FILE"
}

print_status() {
  normalise_paths
  ensure_state_safety
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
    if pid_matches_connector_hint "$pid"; then
      printf 'status=pid-file-points-to-unmanaged-connector-like-process\n'
    else
      printf 'status=pid-file-points-to-other-process\n'
    fi
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

  local run_token
  run_token="$(new_run_token)"
  ensure_safe_state_files
  CHAOP_DOGFOOD_RUN_TOKEN="$run_token" nohup "$agent_bin" --config "$CONFIG_PATH" --connect >> "$LOG_FILE" 2>&1 &
  pid="$!"
  STARTED_CHILD_PID="$pid"
  if ! write_started_child_state "$pid" "$agent_bin" "$run_token"; then
    printf 'could not write connector state for pid %s; stopping child\n' "$pid" >&2
    stop_start_failure_child "$pid"
    rm -f "$PID_FILE" "$PID_META_FILE"
    STARTED_CHILD_PID=""
    exit 1
  fi
  STARTED_CHILD_PID=""
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
  ensure_state_safety
  local pid
  if pid="$(pid_from_file)" && is_pid_running "$pid" && ! pid_matches_connector "$pid"; then
    if ! is_pid_running "$pid"; then
      rm -f "$PID_FILE" "$PID_META_FILE"
      printf 'connector is not running\n'
      return 0
    fi
    die "pid file points to an unmanaged running process; refusing to stop pid $pid"
  fi
  if ! pid="$(current_pid)"; then
    remove_stale_pid_file
    printf 'connector is not running\n'
    return 0
  fi

  printf 'stopping connector pid %s\n' "$pid"
  if ! kill -TERM "$pid" 2>/dev/null; then
    if ! is_pid_running "$pid"; then
      rm -f "$PID_FILE" "$PID_META_FILE"
      printf 'connector stopped\n'
      return 0
    fi
    die "could not signal connector pid $pid"
  fi
  local waited=0
  while is_pid_running "$pid"; do
    if ! pid_matches_connector "$pid"; then
      if ! is_pid_running "$pid"; then
        break
      fi
      die "connector pid no longer matches metadata; refusing to signal pid $pid"
    fi
    if [[ "$waited" -ge "$STOP_TIMEOUT_SECONDS" ]]; then
      if [[ "$FORCE_STOP" -eq 1 ]]; then
        printf 'force killing connector pid %s after %s seconds\n' "$pid" "$STOP_TIMEOUT_SECONDS"
        local child_pids
        child_pids="$(child_pids_of "$pid")"
        signal_child_pid_list "$child_pids" TERM
        kill -KILL "$pid" 2>/dev/null || true
        local kill_waited=0
        while is_pid_running "$pid"; do
          if [[ "$kill_waited" -ge "$START_FAILURE_STOP_TIMEOUT_SECONDS" ]]; then
            signal_child_pid_list "$child_pids" KILL
            die "connector remained running after SIGKILL"
          fi
          sleep 1
          kill_waited=$((kill_waited + 1))
        done
        signal_child_pid_list "$child_pids" KILL
        wait_for_child_pid_list_exit "$child_pids" || die "connector child process remained running after SIGKILL"
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
  ensure_state_safety
  if current_pid >/dev/null; then
    print_status
    return 0
  fi
  remove_stale_pid_file
  start_connector
}

restart_connector() {
  stop_connector
  start_connector
}

show_logs() {
  normalise_paths
  ensure_state_safety
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
  ensure_state_dirs
  local pid
  if pid="$(pid_from_file)"; then
    if ! is_pid_running "$pid"; then
      rm -f "$PID_FILE" "$PID_META_FILE"
    else
      die "pid file points to a running process; refusing to start one-shot connector"
    fi
  fi
  if current_pid >/dev/null; then
    die "pid file points to a running process; refusing to start one-shot connector"
  fi
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
    with_state_lock start_connector
    ;;
  stop)
    with_state_lock stop_connector
    ;;
  restart)
    with_state_lock restart_connector
    ;;
  recover)
    with_state_lock recover_connector
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
    with_state_lock run_once
    ;;
  schedule-upgrade)
    schedule_upgrade
    ;;
esac
