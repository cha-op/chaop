#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/chaop-dogfood-connector-test.XXXXXX")"
CONFIG_FILE="$WORK_DIR/config/connector.toml"
FAKE_AGENT="$WORK_DIR/bin/fake-chaop-agent"
FAKE_AGENT_SRC="$WORK_DIR/bin/fake-chaop-agent.c"
FAKE_PS="$WORK_DIR/bin/ps"
STATE_DIR="$WORK_DIR/state"
PID_FILE="$STATE_DIR/pids/connector.pid"
PID_META_FILE="$STATE_DIR/pids/connector.pid.meta"
LOG_FILE="$STATE_DIR/logs/connector.log"
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

mode_test_path() {
  local path_value="$1"
  case "$(uname -s)" in
    Darwin|FreeBSD|OpenBSD|NetBSD)
      stat -f '%Lp' "$path_value"
      ;;
    *)
      stat -c '%a' "$path_value"
      ;;
  esac
}

mkdir -p "$(dirname "$CONFIG_FILE")" "$(dirname "$FAKE_AGENT")"
cat > "$CONFIG_FILE" <<'CONFIG'
control_plane_url = "https://example.invalid"
workspace_id = "workspace-test"
connector_token = "connector-test"
hostname = "host-test"
CONFIG
cat > "$FAKE_AGENT_SRC" <<'AGENT'
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  int has_connect = 0;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--connect") == 0) {
      has_connect = 1;
    }
  }

  if (!has_connect) {
    puts("doctor ok");
    return 0;
  }

  if (strcmp(getenv("FAKE_AGENT_IGNORE_TERM") ? getenv("FAKE_AGENT_IGNORE_TERM") : "0", "1") == 0) {
    signal(SIGTERM, SIG_IGN);
    signal(SIGINT, SIG_IGN);
  }

  const char *started_file = getenv("FAKE_AGENT_STARTED_FILE");
  if (started_file == NULL || started_file[0] == '\0') {
    fputs("FAKE_AGENT_STARTED_FILE is not set\n", stderr);
    return 1;
  }

  FILE *file = fopen(started_file, "a");
  if (file == NULL) {
    perror("fopen");
    return 1;
  }
  fprintf(file, "%ld", (long)getpid());
  for (int i = 1; i < argc; i++) {
    fprintf(file, " %s", argv[i]);
  }
  fputc('\n', file);
  fclose(file);

  for (;;) {
    sleep(5);
  }
}
AGENT
cc "$FAKE_AGENT_SRC" -o "$FAKE_AGENT"
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
chmod +x "$FAKE_PS"
touch "$FAKE_AGENT_STARTED_FILE"
RECORDED_FAKE_AGENT="$(resolve_test_path "$FAKE_AGENT")"
RECORDED_CONFIG_FILE="$(resolve_test_path "$CONFIG_FILE")"
FAKE_PS_COMMAND="$RECORDED_FAKE_AGENT --config $RECORDED_CONFIG_FILE --connect"
export FAKE_AGENT_STARTED_FILE
export FAKE_AGENT_IGNORE_TERM=0
export FAKE_PS_LSTART
export FAKE_PS_COMMAND
export CHAOP_DOGFOOD_START_FAILURE_STOP_TIMEOUT_SECONDS=1
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

mkdir -p "$STATE_DIR/connector.lock"
printf '999999\n' > "$STATE_DIR/connector.lock/owner.pid"
started_count_before_stale_lock="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
connector recover
started_count_after_stale_lock="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_stale_lock" != "$((started_count_before_stale_lock + 1))" ]]; then
  printf 'expected recover to remove a stale lock and start one connector\n' >&2
  exit 1
fi
stale_lock_recovery_pid="$(tr -d '[:space:]' < "$PID_FILE")"
connector stop
if kill -0 "$stale_lock_recovery_pid" 2>/dev/null; then
  printf 'expected stale-lock-recovery pid %s to stop\n' "$stale_lock_recovery_pid" >&2
  exit 1
fi

started_count_before_concurrent="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
connector start >"$WORK_DIR/concurrent-start-a.out" &
start_a_pid="$!"
connector start >"$WORK_DIR/concurrent-start-b.out" &
start_b_pid="$!"
wait "$start_a_pid"
wait "$start_b_pid"
concurrent_pid="$(tr -d '[:space:]' < "$PID_FILE")"
concurrent_started_count="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$concurrent_started_count" != "$((started_count_before_concurrent + 1))" ]]; then
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
FAKE_PS_COMMAND="$RECORDED_FAKE_AGENT --config $RECORDED_CONFIG_FILE --connect --spoofed"
export FAKE_PS_COMMAND
if connector stop >/dev/null 2>"$WORK_DIR/suffix-command-stop.err"; then
  printf 'expected stop to reject connector-looking argv with extra suffix\n' >&2
  exit 1
fi
if ! kill -0 "$FOREIGN_PID" 2>/dev/null; then
  printf 'expected suffix-command pid %s to remain running\n' "$FOREIGN_PID" >&2
  exit 1
fi
kill "$FOREIGN_PID" 2>/dev/null || true
wait "$FOREIGN_PID" 2>/dev/null || true
FOREIGN_PID=""
FAKE_PS_COMMAND="$RECORDED_FAKE_AGENT --config $RECORDED_CONFIG_FILE --connect"
export FAKE_PS_COMMAND
rm -f "$PID_FILE" "$PID_META_FILE"

external_log_dir="$WORK_DIR/external-logs"
mkdir -p "$external_log_dir"
chmod 755 "$external_log_dir"
started_count_before_external_path="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if "$REPO_ROOT/scripts/dogfood-connector.sh" \
  --config "$CONFIG_FILE" \
  --agent-bin "$FAKE_AGENT" \
  --state-dir "$STATE_DIR" \
  --pid-file "$PID_FILE" \
  --pid-meta-file "$PID_META_FILE" \
  --log-file "$external_log_dir/connector.log" \
  start >/dev/null 2>"$WORK_DIR/external-log-path.err"; then
  printf 'expected start to reject state files outside state-dir\n' >&2
  exit 1
fi
external_mode="$(mode_test_path "$external_log_dir")"
if [[ "$external_mode" != "755" ]]; then
  printf 'expected external log directory mode to remain 755, got %s\n' "$external_mode" >&2
  exit 1
fi
started_count_after_external_path="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_external_path" != "$started_count_before_external_path" ]]; then
  printf 'expected external path rejection to avoid starting another connector\n' >&2
  exit 1
fi

traversal_log_dir="$WORK_DIR/traversal-logs"
mkdir -p "$traversal_log_dir"
chmod 755 "$traversal_log_dir"
started_count_before_traversal_path="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if "$REPO_ROOT/scripts/dogfood-connector.sh" \
  --config "$CONFIG_FILE" \
  --agent-bin "$FAKE_AGENT" \
  --state-dir "$STATE_DIR" \
  --pid-file "$PID_FILE" \
  --pid-meta-file "$PID_META_FILE" \
  --log-file "$STATE_DIR/../traversal-logs/connector.log" \
  start >/dev/null 2>"$WORK_DIR/traversal-log-path.err"; then
  printf 'expected start to reject state paths with parent traversal\n' >&2
  exit 1
fi
traversal_mode="$(mode_test_path "$traversal_log_dir")"
if [[ "$traversal_mode" != "755" ]]; then
  printf 'expected traversal log directory mode to remain 755, got %s\n' "$traversal_mode" >&2
  exit 1
fi
started_count_after_traversal_path="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_traversal_path" != "$started_count_before_traversal_path" ]]; then
  printf 'expected traversal path rejection to avoid starting another connector\n' >&2
  exit 1
fi

symlink_target_dir="$WORK_DIR/symlink-target-dir"
mkdir -p "$symlink_target_dir"
chmod 755 "$symlink_target_dir"
ln -s "$symlink_target_dir" "$STATE_DIR/link-out"
started_count_before_symlink_parent="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if "$REPO_ROOT/scripts/dogfood-connector.sh" \
  --config "$CONFIG_FILE" \
  --agent-bin "$FAKE_AGENT" \
  --state-dir "$STATE_DIR" \
  --pid-file "$PID_FILE" \
  --pid-meta-file "$PID_META_FILE" \
  --log-file "$STATE_DIR/link-out/connector.log" \
  start >/dev/null 2>"$WORK_DIR/symlink-parent-log-path.err"; then
  printf 'expected start to reject state paths through symlinked parents\n' >&2
  exit 1
fi
symlink_target_mode="$(mode_test_path "$symlink_target_dir")"
if [[ "$symlink_target_mode" != "755" ]]; then
  printf 'expected symlink target directory mode to remain 755, got %s\n' "$symlink_target_mode" >&2
  exit 1
fi
started_count_after_symlink_parent="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_symlink_parent" != "$started_count_before_symlink_parent" ]]; then
  printf 'expected symlink parent rejection to avoid starting another connector\n' >&2
  exit 1
fi

lock_traversal_dir="$WORK_DIR/traversal-locks"
mkdir -p "$lock_traversal_dir"
chmod 755 "$lock_traversal_dir"
started_count_before_lock_traversal="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if CHAOP_DOGFOOD_LOCK_DIR="$STATE_DIR/../traversal-locks/connector.lock" \
  "$REPO_ROOT/scripts/dogfood-connector.sh" \
    --config "$CONFIG_FILE" \
    --agent-bin "$FAKE_AGENT" \
    --state-dir "$STATE_DIR" \
    --pid-file "$PID_FILE" \
    --pid-meta-file "$PID_META_FILE" \
    --log-file "$LOG_FILE" \
    start >/dev/null 2>"$WORK_DIR/traversal-lock-path.err"; then
  printf 'expected start to reject lock paths with parent traversal\n' >&2
  exit 1
fi
lock_traversal_mode="$(mode_test_path "$lock_traversal_dir")"
if [[ "$lock_traversal_mode" != "755" ]]; then
  printf 'expected traversal lock directory mode to remain 755, got %s\n' "$lock_traversal_mode" >&2
  exit 1
fi
started_count_after_lock_traversal="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_lock_traversal" != "$started_count_before_lock_traversal" ]]; then
  printf 'expected lock traversal rejection to avoid starting another connector\n' >&2
  exit 1
fi

started_count_before_collision="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
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
if [[ "$started_count_after_collision" != "$started_count_before_collision" ]]; then
  printf 'expected path collision to avoid starting another connector\n' >&2
  exit 1
fi

started_count_before_symlink="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
rm -f "$LOG_FILE"
ln -s "$WORK_DIR/symlink-target.log" "$LOG_FILE"
if connector start >/dev/null 2>"$WORK_DIR/symlink-log.err"; then
  printf 'expected start to reject symlinked log file\n' >&2
  exit 1
fi
rm -f "$LOG_FILE"
started_count_after_symlink="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_symlink" != "$started_count_before_symlink" ]]; then
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
FAKE_AGENT_IGNORE_TERM=1
export FAKE_PS_LSTART
export FAKE_AGENT_IGNORE_TERM
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
FAKE_AGENT_IGNORE_TERM=0
export FAKE_PS_LSTART
export FAKE_AGENT_IGNORE_TERM

printf 'dogfood connector script smoke passed\n'
