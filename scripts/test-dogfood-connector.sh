#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/chaop-dogfood-connector-test.XXXXXX")"
CONFIG_FILE="$WORK_DIR/config/connector.toml"
FAKE_AGENT="$WORK_DIR/bin/fake-chaop-agent"
FAKE_PS="$WORK_DIR/bin/ps"
STATE_DIR="$WORK_DIR/state"
PID_FILE="$WORK_DIR/nested/pids/connector.pid"
PID_META_FILE="$WORK_DIR/nested/pids/connector.pid.meta"
LOG_FILE="$WORK_DIR/nested/logs/connector.log"
FAKE_AGENT_STARTED_FILE="$WORK_DIR/agent-started.log"
FAKE_PS_LSTART="Thu Jun 25 00:00:00 2026"
FAKE_PS_COMMAND=""
RECORDED_FAKE_AGENT=""
RECORDED_CONFIG_FILE=""
FOREIGN_PID=""

cleanup() {
  "$REPO_ROOT/scripts/dogfood-connector.sh" \
    --config "$CONFIG_FILE" \
    --agent-bin "$FAKE_AGENT" \
    --state-dir "$STATE_DIR" \
    --pid-file "$PID_FILE" \
    --pid-meta-file "$PID_META_FILE" \
    --log-file "$LOG_FILE" \
    stop --force >/dev/null 2>&1 || true
  if [[ -n "$FOREIGN_PID" ]] && kill -0 "$FOREIGN_PID" 2>/dev/null; then
    kill "$FOREIGN_PID" 2>/dev/null || true
    wait "$FOREIGN_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

resolve_test_path() {
  local path_value="$1"
  local parent_dir base_name resolved_parent
  parent_dir="$(dirname "$path_value")"
  base_name="$(basename "$path_value")"
  resolved_parent="$(cd "$parent_dir" && pwd -P)"
  printf '%s/%s\n' "$resolved_parent" "$base_name"
}

mkdir -p "$(dirname "$CONFIG_FILE")" "$(dirname "$FAKE_AGENT")"
cat > "$CONFIG_FILE" <<'CONFIG'
control_plane_url = "https://example.invalid"
workspace_id = "workspace-test"
connector_token = "connector-test"
hostname = "host-test"
CONFIG
cat > "$FAKE_AGENT" <<'AGENT'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$*" != *"--connect"* ]]; then
  printf 'doctor ok\n'
  exit 0
fi

printf '%s %s\n' "$$" "$*" >> "${FAKE_AGENT_STARTED_FILE:?}"
trap 'exit 0' TERM INT
while true; do
  sleep 5 &
  wait "$!"
done
AGENT
cat > "$FAKE_PS" <<'PS'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-p" && "${3:-}" == "-o" ]]; then
  case "${4:-}" in
    lstart=)
      printf '%s\n' "${FAKE_PS_LSTART:?}"
      ;;
    command=)
      printf '%s\n' "${FAKE_PS_COMMAND:?}"
      ;;
    *)
      exit 1
      ;;
  esac
  exit 0
fi

exit 1
PS
chmod +x "$FAKE_AGENT"
chmod +x "$FAKE_PS"
touch "$FAKE_AGENT_STARTED_FILE"
RECORDED_FAKE_AGENT="$(resolve_test_path "$FAKE_AGENT")"
RECORDED_CONFIG_FILE="$(resolve_test_path "$CONFIG_FILE")"
FAKE_PS_COMMAND="$RECORDED_FAKE_AGENT --config $RECORDED_CONFIG_FILE --connect"
export FAKE_AGENT_STARTED_FILE
export FAKE_PS_LSTART
export FAKE_PS_COMMAND
export PATH="$WORK_DIR/bin:$PATH"

connector() {
  "$REPO_ROOT/scripts/dogfood-connector.sh" \
    --config "$CONFIG_FILE" \
    --agent-bin "$FAKE_AGENT" \
    --state-dir "$STATE_DIR" \
    --pid-file "$PID_FILE" \
    --pid-meta-file "$PID_META_FILE" \
    --log-file "$LOG_FILE" \
    "$@"
}

connector start
first_pid="$(tr -d '[:space:]' < "$PID_FILE")"

connector start
second_pid="$(tr -d '[:space:]' < "$PID_FILE")"
if [[ "$first_pid" != "$second_pid" ]]; then
  printf 'expected repeated start to keep pid %s, got %s\n' "$first_pid" "$second_pid" >&2
  exit 1
fi
started_count="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count" != "1" ]]; then
  printf 'expected one fake connector start, got %s\n' "$started_count" >&2
  exit 1
fi

connector stop
if kill -0 "$first_pid" 2>/dev/null; then
  printf 'expected managed pid %s to stop\n' "$first_pid" >&2
  exit 1
fi

connector start >"$WORK_DIR/concurrent-start-a.out" &
start_a_pid="$!"
connector start >"$WORK_DIR/concurrent-start-b.out" &
start_b_pid="$!"
wait "$start_a_pid"
wait "$start_b_pid"
concurrent_pid="$(tr -d '[:space:]' < "$PID_FILE")"
concurrent_started_count="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$concurrent_started_count" != "2" ]]; then
  printf 'expected concurrent start to launch one additional connector, got %s total starts\n' "$concurrent_started_count" >&2
  exit 1
fi
connector stop
if kill -0 "$concurrent_pid" 2>/dev/null; then
  printf 'expected concurrent-managed pid %s to stop\n' "$concurrent_pid" >&2
  exit 1
fi

"$FAKE_AGENT" --config "$CONFIG_FILE" --connect &
FOREIGN_PID="$!"
printf '%s\n' "$FOREIGN_PID" > "$PID_FILE"
rm -f "$PID_META_FILE"
if connector stop >/dev/null 2>"$WORK_DIR/foreign-stop.err"; then
  printf 'expected stop to reject a foreign pid file\n' >&2
  exit 1
fi
if ! kill -0 "$FOREIGN_PID" 2>/dev/null; then
  printf 'expected foreign pid %s to remain running\n' "$FOREIGN_PID" >&2
  exit 1
fi
kill "$FOREIGN_PID" 2>/dev/null || true
wait "$FOREIGN_PID" 2>/dev/null || true
FOREIGN_PID=""
rm -f "$PID_FILE" "$PID_META_FILE"

"$FAKE_AGENT" --config "$CONFIG_FILE" --connect &
FOREIGN_PID="$!"
printf '%s\n' "$FOREIGN_PID" > "$PID_FILE"
{
  printf 'pid=%s\n' "$FOREIGN_PID"
  printf 'run_token=fake-token\n'
  printf 'started_at=\n'
  printf 'agent_bin=%s\n' "$RECORDED_FAKE_AGENT"
  printf 'config=%s\n' "$RECORDED_CONFIG_FILE"
} > "$PID_META_FILE"
if connector stop >/dev/null 2>"$WORK_DIR/empty-started-at-stop.err"; then
  printf 'expected stop to reject metadata without a process start time\n' >&2
  exit 1
fi
if ! kill -0 "$FOREIGN_PID" 2>/dev/null; then
  printf 'expected metadata-without-start-time pid %s to remain running\n' "$FOREIGN_PID" >&2
  exit 1
fi
kill "$FOREIGN_PID" 2>/dev/null || true
wait "$FOREIGN_PID" 2>/dev/null || true
FOREIGN_PID=""
rm -f "$PID_FILE" "$PID_META_FILE"

sleep 30 &
FOREIGN_PID="$!"
printf '%s\n' "$FOREIGN_PID" > "$PID_FILE"
{
  printf 'pid=%s\n' "$FOREIGN_PID"
  printf 'run_token=fake-token\n'
  printf 'started_at=%s\n' "$FAKE_PS_LSTART"
  printf 'agent_bin=%s\n' "$RECORDED_FAKE_AGENT"
  printf 'config=%s\n' "$RECORDED_CONFIG_FILE"
} > "$PID_META_FILE"
FAKE_PS_COMMAND="sleep 30"
export FAKE_PS_COMMAND
if connector stop >/dev/null 2>"$WORK_DIR/wrong-command-stop.err"; then
  printf 'expected stop to reject metadata when the process command does not match the connector\n' >&2
  exit 1
fi
if ! kill -0 "$FOREIGN_PID" 2>/dev/null; then
  printf 'expected wrong-command pid %s to remain running\n' "$FOREIGN_PID" >&2
  exit 1
fi
kill "$FOREIGN_PID" 2>/dev/null || true
wait "$FOREIGN_PID" 2>/dev/null || true
FOREIGN_PID=""
FAKE_PS_COMMAND="$RECORDED_FAKE_AGENT --config $RECORDED_CONFIG_FILE --connect"
export FAKE_PS_COMMAND
rm -f "$PID_FILE" "$PID_META_FILE"

sleep 30 &
FOREIGN_PID="$!"
printf '%s\n' "$FOREIGN_PID" > "$PID_FILE"
{
  printf 'pid=%s\n' "$FOREIGN_PID"
  printf 'run_token=fake-token\n'
  printf 'started_at=%s\n' "$FAKE_PS_LSTART"
  printf 'agent_bin=%s\n' "$RECORDED_FAKE_AGENT"
  printf 'config=%s\n' "$RECORDED_CONFIG_FILE"
} > "$PID_META_FILE"
FAKE_PS_COMMAND="bash -c loop $RECORDED_FAKE_AGENT --config $RECORDED_CONFIG_FILE --connect"
export FAKE_PS_COMMAND
if connector stop >/dev/null 2>"$WORK_DIR/spoofed-command-stop.err"; then
  printf 'expected stop to reject metadata when a non-connector process spoofs connector argv\n' >&2
  exit 1
fi
if ! kill -0 "$FOREIGN_PID" 2>/dev/null; then
  printf 'expected spoofed-command pid %s to remain running\n' "$FOREIGN_PID" >&2
  exit 1
fi
kill "$FOREIGN_PID" 2>/dev/null || true
wait "$FOREIGN_PID" 2>/dev/null || true
FOREIGN_PID=""
FAKE_PS_COMMAND="$RECORDED_FAKE_AGENT --config $RECORDED_CONFIG_FILE --connect"
export FAKE_PS_COMMAND
rm -f "$PID_FILE" "$PID_META_FILE"

if "$REPO_ROOT/scripts/dogfood-connector.sh" \
  --config "$CONFIG_FILE" \
  --agent-bin "$FAKE_AGENT" \
  --state-dir "$STATE_DIR" \
  --pid-file "$PID_FILE" \
  --pid-meta-file "$PID_FILE" \
  --log-file "$LOG_FILE" \
  start >/dev/null 2>"$WORK_DIR/path-collision.err"; then
  printf 'expected start to reject pid and metadata path collision\n' >&2
  exit 1
fi

started_count_after_collision="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_collision" != "4" ]]; then
  printf 'expected path collision to avoid starting another connector\n' >&2
  exit 1
fi

rm -f "$LOG_FILE"
ln -s "$WORK_DIR/symlink-target.log" "$LOG_FILE"
if connector start >/dev/null 2>"$WORK_DIR/symlink-log.err"; then
  printf 'expected start to reject symlinked log file\n' >&2
  exit 1
fi
rm -f "$LOG_FILE"
started_count_after_symlink="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_symlink" != "4" ]]; then
  printf 'expected symlink state file rejection to avoid starting another connector\n' >&2
  exit 1
fi

ln -s "$WORK_DIR/symlink-target.log" "$LOG_FILE"
if connector logs >/dev/null 2>"$WORK_DIR/symlink-logs.err"; then
  printf 'expected logs to reject symlinked log file\n' >&2
  exit 1
fi
if connector status >/dev/null 2>"$WORK_DIR/symlink-status.err"; then
  printf 'expected status to reject symlinked log file\n' >&2
  exit 1
fi
if connector stop >/dev/null 2>"$WORK_DIR/symlink-stop.err"; then
  printf 'expected stop to reject symlinked log file\n' >&2
  exit 1
fi
rm -f "$LOG_FILE"

started_count_before_metadata_failure="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
FAKE_PS_LSTART=""
export FAKE_PS_LSTART
if connector start >/dev/null 2>"$WORK_DIR/metadata-failure-start.err"; then
  printf 'expected start to fail when process start time cannot be read\n' >&2
  exit 1
fi
started_count_after_metadata_failure="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_metadata_failure" != "$((started_count_before_metadata_failure + 1))" ]]; then
  printf 'expected metadata failure test to start exactly one child before cleanup\n' >&2
  exit 1
fi
metadata_failure_pid="$(tail -n 1 "$FAKE_AGENT_STARTED_FILE" | awk '{print $1}')"
if kill -0 "$metadata_failure_pid" 2>/dev/null; then
  printf 'expected metadata-failure child pid %s to be stopped\n' "$metadata_failure_pid" >&2
  exit 1
fi
if [[ -e "$PID_FILE" || -e "$PID_META_FILE" ]]; then
  printf 'expected metadata failure to clean pid state files\n' >&2
  exit 1
fi
FAKE_PS_LSTART="Thu Jun 25 00:00:00 2026"
export FAKE_PS_LSTART

printf 'dogfood connector script smoke passed\n'
