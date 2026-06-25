#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/chaop-dogfood-connector-test.XXXXXX")"
CONFIG_FILE="$WORK_DIR/config/connector.toml"
FAKE_AGENT="$WORK_DIR/bin/fake-chaop-agent"
STATE_DIR="$WORK_DIR/state"
PID_FILE="$WORK_DIR/nested/pids/connector.pid"
PID_META_FILE="$WORK_DIR/nested/pids/connector.pid.meta"
LOG_FILE="$WORK_DIR/nested/logs/connector.log"
FAKE_AGENT_STARTED_FILE="$WORK_DIR/agent-started.log"
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
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

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
chmod +x "$FAKE_AGENT"
touch "$FAKE_AGENT_STARTED_FILE"
export FAKE_AGENT_STARTED_FILE

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
FOREIGN_PID=""
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
if [[ "$started_count_after_collision" != "2" ]]; then
  printf 'expected path collision to avoid starting another connector\n' >&2
  exit 1
fi

printf 'dogfood connector script smoke passed\n'
