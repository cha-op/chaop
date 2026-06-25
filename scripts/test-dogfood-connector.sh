#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/chaop-dogfood-connector-test.XXXXXX")"
CONFIG_FILE="$WORK_DIR/config/connector.toml"
FAKE_AGENT="$WORK_DIR/bin/fake-chaop-agent"
FAKE_AGENT_SRC="$WORK_DIR/bin/fake-chaop-agent.c"
ZOMBIE_HELPER="$WORK_DIR/bin/zombie-helper"
ZOMBIE_HELPER_SRC="$WORK_DIR/bin/zombie-helper.c"
FAKE_CARGO="$WORK_DIR/bin/cargo"
FAKE_CARGO_TARGET_DIR="$WORK_DIR/custom-target"
FAKE_PS="$WORK_DIR/bin/ps"
STATE_DIR="$WORK_DIR/state"
PID_FILE="$STATE_DIR/pids/connector.pid"
PID_META_FILE="$STATE_DIR/pids/connector.pid.meta"
LOG_FILE="$STATE_DIR/logs/connector.log"
FAKE_AGENT_STARTED_FILE="$WORK_DIR/agent-started.log"
FAKE_AGENT_CHILD_PID_FILE="$WORK_DIR/agent-child.pid"
FAKE_AGENT_DESCENDANT_PID_FILE="$WORK_DIR/agent-descendant.pid"
FAKE_PS_LSTART="Thu Jun 25 00:00:00 2026"
FAKE_PS_COMMAND=""
FAKE_PS_KILL_ON_COMMAND=0
FAKE_PS_KILL_ON_LSTART=0
FAKE_PS_KILL_ON_LSTART_PID=""
RECORDED_FAKE_AGENT=""
RECORDED_CONFIG_FILE=""
FOREIGN_PID=""
ZOMBIE_PARENT_PID=""

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
  if [[ -n "$ZOMBIE_PARENT_PID" ]] && kill -0 "$ZOMBIE_PARENT_PID" 2>/dev/null; then
    kill "$ZOMBIE_PARENT_PID" 2>/dev/null || true
    wait "$ZOMBIE_PARENT_PID" 2>/dev/null || true
  fi
  if [[ -f "$FAKE_AGENT_CHILD_PID_FILE" ]]; then
    local child_pid
    child_pid="$(tr -d '[:space:]' < "$FAKE_AGENT_CHILD_PID_FILE")"
    if [[ "$child_pid" =~ ^[0-9]+$ ]] && kill -0 "$child_pid" 2>/dev/null; then
      kill -KILL "$child_pid" 2>/dev/null || true
      wait "$child_pid" 2>/dev/null || true
    fi
  fi
  if [[ -f "$FAKE_AGENT_DESCENDANT_PID_FILE" ]]; then
    local descendant_pid
    descendant_pid="$(tr -d '[:space:]' < "$FAKE_AGENT_DESCENDANT_PID_FILE")"
    if [[ "$descendant_pid" =~ ^[0-9]+$ ]] && kill -0 "$descendant_pid" 2>/dev/null; then
      kill -KILL "$descendant_pid" 2>/dev/null || true
      wait "$descendant_pid" 2>/dev/null || true
    fi
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

pid_is_live_non_zombie() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null || return 1
  if [[ -r "/proc/$pid/stat" ]]; then
    local stat_line stat_tail
    stat_line="$(< "/proc/$pid/stat")" || return 1
    stat_tail="${stat_line##*) }"
    [[ "${stat_tail%% *}" != "Z" ]] || return 1
  else
    local state
    state="$(ps -p "$pid" -o stat= 2>/dev/null | awk 'NR == 1 { print substr($1, 1, 1) }')" || return 1
    [[ "$state" != "Z" ]] || return 1
  fi
  return 0
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
  int run_once = 0;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--connect") == 0) {
      has_connect = 1;
    }
    if (strcmp(argv[i], "--run-once") == 0) {
      run_once = 1;
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

  const char *child_pid_file = getenv("FAKE_AGENT_CHILD_PID_FILE");
  if (child_pid_file != NULL && child_pid_file[0] != '\0') {
    pid_t child = fork();
    if (child < 0) {
      perror("fork");
      return 1;
    }
    if (child == 0) {
      if (strcmp(getenv("FAKE_AGENT_CHILD_OWN_PROCESS_GROUP") ? getenv("FAKE_AGENT_CHILD_OWN_PROCESS_GROUP") : "0", "1") == 0) {
        if (setpgid(0, 0) != 0) {
          perror("setpgid");
          return 1;
        }
      }
      if (strcmp(getenv("FAKE_AGENT_CHILD_IGNORE_TERM") ? getenv("FAKE_AGENT_CHILD_IGNORE_TERM") : "0", "1") == 0) {
        signal(SIGTERM, SIG_IGN);
        signal(SIGINT, SIG_IGN);
      }
      const char *descendant_pid_file = getenv("FAKE_AGENT_DESCENDANT_PID_FILE");
      if (descendant_pid_file != NULL && descendant_pid_file[0] != '\0') {
        pid_t descendant = fork();
        if (descendant < 0) {
          perror("fork descendant");
          return 1;
        }
        if (descendant == 0) {
          if (strcmp(getenv("FAKE_AGENT_DESCENDANT_IGNORE_TERM") ? getenv("FAKE_AGENT_DESCENDANT_IGNORE_TERM") : "0", "1") == 0) {
            signal(SIGTERM, SIG_IGN);
            signal(SIGINT, SIG_IGN);
          }
          for (;;) {
            sleep(5);
          }
        }
        FILE *descendant_file = fopen(descendant_pid_file, "w");
        if (descendant_file == NULL) {
          perror("fopen descendant pid");
          return 1;
        }
        fprintf(descendant_file, "%ld\n", (long)descendant);
        fclose(descendant_file);
      }
      for (;;) {
        sleep(5);
      }
    }
    FILE *child_file = fopen(child_pid_file, "w");
    if (child_file == NULL) {
      perror("fopen child pid");
      return 1;
    }
    fprintf(child_file, "%ld\n", (long)child);
    fclose(child_file);
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

  if (run_once) {
    return 0;
  }

  for (;;) {
    sleep(5);
  }
}
AGENT
cc "$FAKE_AGENT_SRC" -o "$FAKE_AGENT"
cat > "$ZOMBIE_HELPER_SRC" <<'ZOMBIE'
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) {
    return 2;
  }
  pid_t child = fork();
  if (child < 0) {
    return 3;
  }
  if (child == 0) {
    _exit(0);
  }
  FILE *file = fopen(argv[1], "w");
  if (file == NULL) {
    return 4;
  }
  fprintf(file, "%ld\n", (long)child);
  fclose(file);
  sleep(30);
  return 0;
}
ZOMBIE
cc "$ZOMBIE_HELPER_SRC" -o "$ZOMBIE_HELPER"
mkdir -p "$FAKE_CARGO_TARGET_DIR/debug"
cp "$FAKE_AGENT" "$FAKE_CARGO_TARGET_DIR/debug/chaop-agent"
cat > "$FAKE_CARGO" <<'CARGO'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  metadata)
    if [[ -n "${FAKE_CARGO_EXPECT_CWD:-}" && "$(pwd -P)" != "$FAKE_CARGO_EXPECT_CWD" ]]; then
      printf 'expected fake cargo cwd %s, got %s\n' "$FAKE_CARGO_EXPECT_CWD" "$(pwd -P)" >&2
      exit 1
    fi
    printf '{"target_directory":"%s"}\n' "${FAKE_CARGO_TARGET_DIR:?}"
    ;;
  build)
    if [[ -n "${FAKE_CARGO_EXPECT_CWD:-}" && "$(pwd -P)" != "$FAKE_CARGO_EXPECT_CWD" ]]; then
      printf 'expected fake cargo cwd %s, got %s\n' "$FAKE_CARGO_EXPECT_CWD" "$(pwd -P)" >&2
      exit 1
    fi
    ;;
  *)
    printf 'unexpected fake cargo command: %s\n' "$*" >&2
    exit 1
    ;;
esac
CARGO
chmod +x "$FAKE_CARGO"
cat > "$FAKE_PS" <<'PS'
#!/usr/bin/env bash
set -euo pipefail

wide_output=0
if [[ "${1:-}" == "-ww" ]]; then
  wide_output=1
  shift
fi

if [[ "${1:-}" == "-p" && "$#" -eq 2 ]]; then
  kill -0 "${2:?}" 2>/dev/null
  exit $?
fi

if [[ "${1:-}" == "-p" && "${3:-}" == "-o" ]]; then
  case "${4:-}" in
    lstart=)
      printf '%s\n' "${FAKE_PS_LSTART:?}"
      if [[ "${FAKE_PS_KILL_ON_LSTART:-0}" == "1" ]]; then
        if [[ -z "${FAKE_PS_KILL_ON_LSTART_PID:-}" || "${FAKE_PS_KILL_ON_LSTART_PID:-}" == "${2:?}" ]]; then
          kill -KILL "${2:?}" 2>/dev/null || true
          sleep 0.2
        fi
      fi
      ;;
    command=)
      if [[ "$wide_output" -eq 1 ]]; then
        printf '%s\n' "${FAKE_PS_COMMAND:?}"
      else
        printf '%.40s\n' "${FAKE_PS_COMMAND:?}"
      fi
      if [[ "${FAKE_PS_KILL_ON_COMMAND:-0}" == "1" ]]; then
        kill -KILL "${2:?}" 2>/dev/null || true
        sleep 0.2
      fi
      ;;
    stat=)
      /bin/ps -p "${2:?}" -o stat= 2>/dev/null
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
export FAKE_AGENT_CHILD_PID_FILE=""
export FAKE_AGENT_CHILD_IGNORE_TERM=0
export FAKE_AGENT_CHILD_OWN_PROCESS_GROUP=0
export FAKE_AGENT_DESCENDANT_PID_FILE=""
export FAKE_AGENT_DESCENDANT_IGNORE_TERM=0
export FAKE_AGENT_IGNORE_TERM=0
export FAKE_PS_LSTART
export FAKE_PS_COMMAND
export FAKE_PS_KILL_ON_COMMAND
export FAKE_PS_KILL_ON_LSTART
export FAKE_PS_KILL_ON_LSTART_PID
export FAKE_CARGO_TARGET_DIR
export FAKE_CARGO_EXPECT_CWD
export CHAOP_DOGFOOD_START_FAILURE_STOP_TIMEOUT_SECONDS=1
export PATH="$WORK_DIR/bin:$PATH"

if ! env -u HOME -u XDG_STATE_HOME "$REPO_ROOT/scripts/dogfood-connector.sh" --help >/dev/null; then
  printf 'expected --help to work when HOME and XDG_STATE_HOME are unset\n' >&2
  exit 1
fi

if env -u HOME -u XDG_STATE_HOME "$REPO_ROOT/scripts/dogfood-connector.sh" status >/dev/null 2>"$WORK_DIR/no-home-state.err"; then
  printf 'expected status without HOME, XDG_STATE_HOME, or --state-dir to fail\n' >&2
  exit 1
fi

shared_state_dir="$WORK_DIR/shared-state"
mkdir -p "$shared_state_dir"
chmod 755 "$shared_state_dir"
if "$REPO_ROOT/scripts/dogfood-connector.sh" \
  --config "$CONFIG_FILE" \
  --agent-bin "$FAKE_AGENT" \
  --state-dir "$shared_state_dir" \
  status >/dev/null 2>"$WORK_DIR/shared-state.err"; then
  printf 'expected existing shared state root to be rejected\n' >&2
  exit 1
fi
shared_state_mode="$(mode_test_path "$shared_state_dir")"
if [[ "$shared_state_mode" != "755" ]]; then
  printf 'expected shared state root mode to remain 755, got %s\n' "$shared_state_mode" >&2
  exit 1
fi

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

custom_target_output="$WORK_DIR/custom-target-doctor.out"
FAKE_CARGO_EXPECT_CWD="$(resolve_test_path "$REPO_ROOT")"
external_cwd="$WORK_DIR/external-cwd"
mkdir -p "$external_cwd"
if ! (
  cd "$external_cwd"
  "$REPO_ROOT/scripts/dogfood-connector.sh" \
  --config "$CONFIG_FILE" \
  --state-dir "$STATE_DIR" \
  --pid-file "$PID_FILE" \
  --pid-meta-file "$PID_META_FILE" \
  --log-file "$LOG_FILE" \
  --no-build \
  --build-profile debug \
    doctor > "$custom_target_output"
); then
  printf 'expected doctor to use Cargo metadata target_directory when --agent-bin is omitted\n' >&2
  exit 1
fi
FAKE_CARGO_EXPECT_CWD=""
if ! grep -q 'doctor ok' "$custom_target_output"; then
  printf 'expected custom target-dir doctor output, got:\n' >&2
  cat "$custom_target_output" >&2
  exit 1
fi

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

if connector once >/dev/null 2>"$WORK_DIR/once-while-running.err"; then
  printf 'expected once to reject while the persistent connector is already running\n' >&2
  exit 1
fi
started_count_after_rejected_once="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_rejected_once" != "$started_count" ]]; then
  printf 'expected rejected once to avoid starting another connector, got %s starts\n' "$started_count_after_rejected_once" >&2
  exit 1
fi

connector stop
if pid_is_live_non_zombie "$first_pid"; then
  printf 'expected managed pid %s to stop\n' "$first_pid" >&2
  exit 1
fi

"$FAKE_AGENT" --config "$CONFIG_FILE" --connect &
FOREIGN_PID="$!"
printf '%s\n' "$FOREIGN_PID" > "$PID_FILE"
rm -f "$PID_META_FILE"
started_count_before_rejected_once_corrupt_meta="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if connector start >/dev/null 2>"$WORK_DIR/start-corrupt-meta.err"; then
  printf 'expected start to reject a live connector-like pid with corrupt metadata\n' >&2
  exit 1
fi
started_count_after_rejected_start_corrupt_meta="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_rejected_start_corrupt_meta" != "$started_count_before_rejected_once_corrupt_meta" ]]; then
  printf 'expected rejected corrupt-metadata start to avoid starting another connector, got %s starts\n' "$started_count_after_rejected_start_corrupt_meta" >&2
  exit 1
fi
if connector once >/dev/null 2>"$WORK_DIR/once-corrupt-meta.err"; then
  printf 'expected once to reject a live connector-like pid with corrupt metadata\n' >&2
  exit 1
fi
started_count_after_rejected_once_corrupt_meta="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_rejected_once_corrupt_meta" != "$started_count_before_rejected_once_corrupt_meta" ]]; then
  printf 'expected rejected corrupt-metadata once to avoid starting another connector, got %s starts\n' "$started_count_after_rejected_once_corrupt_meta" >&2
  exit 1
fi
if ! kill -0 "$FOREIGN_PID" 2>/dev/null; then
  printf 'expected corrupt-metadata once pid %s to remain running\n' "$FOREIGN_PID" >&2
  exit 1
fi
kill -KILL "$FOREIGN_PID" 2>/dev/null || true
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
started_count_before_reused_pid="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
connector start
started_count_after_reused_pid="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_reused_pid" != "$((started_count_before_reused_pid + 1))" ]]; then
  printf 'expected start to clear a stale pid file reused by a non-connector process\n' >&2
  exit 1
fi
if ! kill -0 "$FOREIGN_PID" 2>/dev/null; then
  printf 'expected reused foreign pid %s to remain running\n' "$FOREIGN_PID" >&2
  exit 1
fi
kill "$FOREIGN_PID" 2>/dev/null || true
wait "$FOREIGN_PID" 2>/dev/null || true
FOREIGN_PID=""
FAKE_PS_COMMAND="$RECORDED_FAKE_AGENT --config $RECORDED_CONFIG_FILE --connect"
export FAKE_PS_COMMAND
reused_pid_connector_pid="$(tr -d '[:space:]' < "$PID_FILE")"
connector stop
if pid_is_live_non_zombie "$reused_pid_connector_pid"; then
  printf 'expected reused-pid recovery connector pid %s to stop\n' "$reused_pid_connector_pid" >&2
  exit 1
fi

if [[ -d "/proc" ]]; then
  zombie_pid_file="$WORK_DIR/zombie.pid"
  "$ZOMBIE_HELPER" "$zombie_pid_file" &
  ZOMBIE_PARENT_PID="$!"
  for _ in {1..20}; do
    if [[ -s "$zombie_pid_file" ]]; then
      zombie_pid="$(tr -d '[:space:]' < "$zombie_pid_file")"
      if [[ -r "/proc/$zombie_pid/stat" ]]; then
        zombie_stat="$(< "/proc/$zombie_pid/stat")"
        zombie_tail="${zombie_stat##*) }"
        if [[ "${zombie_tail%% *}" == "Z" ]]; then
          break
        fi
      fi
    fi
    sleep 0.1
  done
  zombie_pid="$(tr -d '[:space:]' < "$zombie_pid_file")"
  if [[ ! -r "/proc/$zombie_pid/stat" ]]; then
    printf 'expected zombie pid %s to exist for liveness test\n' "$zombie_pid" >&2
    exit 1
  fi
  zombie_stat="$(< "/proc/$zombie_pid/stat")"
  zombie_tail="${zombie_stat##*) }"
  if [[ "${zombie_tail%% *}" != "Z" ]]; then
    printf 'expected helper child pid %s to be a zombie, got state %s\n' "$zombie_pid" "${zombie_tail%% *}" >&2
    exit 1
  fi
  printf '%s\n' "$zombie_pid" > "$PID_FILE"
  {
    printf 'pid=%s\n' "$zombie_pid"
    printf 'run_token=fake-token\n'
    printf 'started_at=%s\n' "$FAKE_PS_LSTART"
    printf 'agent_bin=%s\n' "$RECORDED_FAKE_AGENT"
    printf 'config=%s\n' "$RECORDED_CONFIG_FILE"
  } > "$PID_META_FILE"
  FAKE_PS_COMMAND="$RECORDED_FAKE_AGENT --config $RECORDED_CONFIG_FILE --connect"
  export FAKE_PS_COMMAND
  started_count_before_zombie_pid="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
  connector start
  started_count_after_zombie_pid="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
  if [[ "$started_count_after_zombie_pid" != "$((started_count_before_zombie_pid + 1))" ]]; then
    printf 'expected start to clear a stale pid file pointing at a zombie\n' >&2
    exit 1
  fi
  zombie_recovery_connector_pid="$(tr -d '[:space:]' < "$PID_FILE")"
  connector stop
  if pid_is_live_non_zombie "$zombie_recovery_connector_pid"; then
    printf 'expected zombie-pid recovery connector pid %s to stop\n' "$zombie_recovery_connector_pid" >&2
    exit 1
  fi
  kill "$ZOMBIE_PARENT_PID" 2>/dev/null || true
  wait "$ZOMBIE_PARENT_PID" 2>/dev/null || true
  ZOMBIE_PARENT_PID=""
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
if pid_is_live_non_zombie "$stale_lock_recovery_pid"; then
  printf 'expected stale-lock-recovery pid %s to stop\n' "$stale_lock_recovery_pid" >&2
  exit 1
fi

sleep 30 &
FOREIGN_PID="$!"
mkdir -p "$STATE_DIR/connector.lock"
printf '%s\n' "$FOREIGN_PID" > "$STATE_DIR/connector.lock/owner.pid"
printf 'Wed Jun 24 00:00:00 2026\n' > "$STATE_DIR/connector.lock/owner.started_at"
started_count_before_reused_lock_owner="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
connector recover
started_count_after_reused_lock_owner="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_reused_lock_owner" != "$((started_count_before_reused_lock_owner + 1))" ]]; then
  printf 'expected recover to clear a stale lock whose owner pid was reused\n' >&2
  exit 1
fi
if ! kill -0 "$FOREIGN_PID" 2>/dev/null; then
  printf 'expected reused lock owner pid %s to remain running\n' "$FOREIGN_PID" >&2
  exit 1
fi
kill "$FOREIGN_PID" 2>/dev/null || true
wait "$FOREIGN_PID" 2>/dev/null || true
FOREIGN_PID=""
reused_lock_owner_pid="$(tr -d '[:space:]' < "$PID_FILE")"
connector stop
if pid_is_live_non_zombie "$reused_lock_owner_pid"; then
  printf 'expected reused-lock-owner recovery pid %s to stop\n' "$reused_lock_owner_pid" >&2
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
if pid_is_live_non_zombie "$concurrent_pid"; then
  printf 'expected concurrent-managed pid %s to stop\n' "$concurrent_pid" >&2
  exit 1
fi

FAKE_AGENT_IGNORE_TERM=1
FAKE_AGENT_CHILD_PID_FILE="$WORK_DIR/force-stop-child.pid"
FAKE_AGENT_CHILD_IGNORE_TERM=0
FAKE_AGENT_CHILD_OWN_PROCESS_GROUP=1
FAKE_AGENT_DESCENDANT_PID_FILE="$WORK_DIR/force-stop-descendant.pid"
FAKE_AGENT_DESCENDANT_IGNORE_TERM=1
rm -f "$FAKE_AGENT_CHILD_PID_FILE" "$FAKE_AGENT_DESCENDANT_PID_FILE"
export FAKE_AGENT_IGNORE_TERM
export FAKE_AGENT_CHILD_PID_FILE
export FAKE_AGENT_CHILD_IGNORE_TERM
export FAKE_AGENT_CHILD_OWN_PROCESS_GROUP
export FAKE_AGENT_DESCENDANT_PID_FILE
export FAKE_AGENT_DESCENDANT_IGNORE_TERM
connector start
force_stop_pid="$(tr -d '[:space:]' < "$PID_FILE")"
force_stop_child_pid="$(tr -d '[:space:]' < "$FAKE_AGENT_CHILD_PID_FILE")"
force_stop_descendant_pid="$(tr -d '[:space:]' < "$FAKE_AGENT_DESCENDANT_PID_FILE")"
CHAOP_DOGFOOD_STOP_TIMEOUT_SECONDS=0 connector stop --force
if pid_is_live_non_zombie "$force_stop_pid"; then
  printf 'expected force-stopped pid %s to stop\n' "$force_stop_pid" >&2
  exit 1
fi
if pid_is_live_non_zombie "$force_stop_child_pid"; then
  printf 'expected force-stopped child pid %s to stop\n' "$force_stop_child_pid" >&2
  exit 1
fi
if pid_is_live_non_zombie "$force_stop_descendant_pid"; then
  printf 'expected force-stopped descendant pid %s to stop\n' "$force_stop_descendant_pid" >&2
  exit 1
fi
if [[ -e "$PID_FILE" || -e "$PID_META_FILE" ]]; then
  printf 'expected force stop to remove pid state only after the pid exits\n' >&2
  exit 1
fi
FAKE_AGENT_IGNORE_TERM=0
FAKE_AGENT_CHILD_PID_FILE=""
FAKE_AGENT_CHILD_IGNORE_TERM=0
FAKE_AGENT_CHILD_OWN_PROCESS_GROUP=0
FAKE_AGENT_DESCENDANT_PID_FILE=""
FAKE_AGENT_DESCENDANT_IGNORE_TERM=0
export FAKE_AGENT_IGNORE_TERM
export FAKE_AGENT_CHILD_PID_FILE
export FAKE_AGENT_CHILD_IGNORE_TERM
export FAKE_AGENT_CHILD_OWN_PROCESS_GROUP
export FAKE_AGENT_DESCENDANT_PID_FILE
export FAKE_AGENT_DESCENDANT_IGNORE_TERM

connector start
kill_race_pid="$(tr -d '[:space:]' < "$PID_FILE")"
FAKE_PS_KILL_ON_LSTART=1
FAKE_PS_KILL_ON_LSTART_PID="$kill_race_pid"
export FAKE_PS_KILL_ON_LSTART
export FAKE_PS_KILL_ON_LSTART_PID
if ! connector stop >"$WORK_DIR/kill-race-stop.out" 2>"$WORK_DIR/kill-race-stop.err"; then
  printf 'expected stop to tolerate a connector exiting before TERM\n' >&2
  exit 1
fi
FAKE_PS_KILL_ON_LSTART=0
FAKE_PS_KILL_ON_LSTART_PID=""
export FAKE_PS_KILL_ON_LSTART
export FAKE_PS_KILL_ON_LSTART_PID
if [[ -e "$PID_FILE" || -e "$PID_META_FILE" ]]; then
  printf 'expected stop race cleanup to remove pid state\n' >&2
  exit 1
fi
for _ in {1..20}; do
  if ! pid_is_live_non_zombie "$kill_race_pid"; then
    break
  fi
  sleep 0.05
done
if pid_is_live_non_zombie "$kill_race_pid"; then
  printf 'expected kill-race pid %s to be gone\n' "$kill_race_pid" >&2
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
kill -KILL "$FOREIGN_PID" 2>/dev/null || true
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

"$FAKE_AGENT" --config "$CONFIG_FILE" --connect --spoofed &
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

if [[ -d "/proc" ]]; then
  "$FAKE_AGENT" --config "$CONFIG_FILE" --connect &
  FOREIGN_PID="$!"
  printf '%s\n' "$FOREIGN_PID" > "$PID_FILE"
  {
    printf 'pid=%s\n' "$FOREIGN_PID"
    printf 'run_token=fake-token\n'
    printf 'started_at=%s\n' "$FAKE_PS_LSTART"
    printf 'agent_bin=%s\n' "$RECORDED_FAKE_AGENT"
    printf 'config=%s\n' "$RECORDED_CONFIG_FILE"
  } > "$PID_META_FILE"
  FAKE_PS_COMMAND="$RECORDED_FAKE_AGENT --config $RECORDED_CONFIG_FILE --connect"
  export FAKE_PS_COMMAND
  if connector stop >/dev/null 2>"$WORK_DIR/missing-token-stop.err"; then
    printf 'expected stop to reject a command-line spoof without the wrapper run token\n' >&2
    exit 1
  fi
  if ! kill -0 "$FOREIGN_PID" 2>/dev/null; then
    printf 'expected missing-token pid %s to remain running\n' "$FOREIGN_PID" >&2
    exit 1
  fi
  kill -KILL "$FOREIGN_PID" 2>/dev/null || true
  wait "$FOREIGN_PID" 2>/dev/null || true
  FOREIGN_PID=""
fi
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

printf '999999\n' > "$WORK_DIR/owner.pid"
started_count_before_lock_parent="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if CHAOP_DOGFOOD_LOCK_DIR="$STATE_DIR/.." \
  "$REPO_ROOT/scripts/dogfood-connector.sh" \
    --config "$CONFIG_FILE" \
    --agent-bin "$FAKE_AGENT" \
    --state-dir "$STATE_DIR" \
    --pid-file "$PID_FILE" \
    --pid-meta-file "$PID_META_FILE" \
    --log-file "$LOG_FILE" \
    start >/dev/null 2>"$WORK_DIR/parent-lock-path.err"; then
  printf 'expected start to reject lock paths ending with parent traversal\n' >&2
  exit 1
fi
if [[ ! -e "$WORK_DIR/owner.pid" ]]; then
  printf 'expected parent lock path rejection to preserve owner.pid outside state dir\n' >&2
  exit 1
fi
started_count_after_lock_parent="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_lock_parent" != "$started_count_before_lock_parent" ]]; then
  printf 'expected parent lock path rejection to avoid starting another connector\n' >&2
  exit 1
fi
rm -f "$WORK_DIR/owner.pid"

lock_symlink_target_dir="$WORK_DIR/lock-symlink-target"
mkdir -p "$lock_symlink_target_dir"
printf '999999\n' > "$lock_symlink_target_dir/owner.pid"
ln -s "$lock_symlink_target_dir" "$STATE_DIR/connector.lock"
started_count_before_lock_symlink="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if CHAOP_DOGFOOD_LOCK_TIMEOUT_SECONDS=0 connector start >/dev/null 2>"$WORK_DIR/symlink-lock-path.err"; then
  printf 'expected start to reject symlinked lock directory\n' >&2
  exit 1
fi
if [[ ! -e "$lock_symlink_target_dir/owner.pid" ]]; then
  printf 'expected symlinked lock rejection to preserve external owner.pid\n' >&2
  exit 1
fi
started_count_after_lock_symlink="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_lock_symlink" != "$started_count_before_lock_symlink" ]]; then
  printf 'expected symlinked lock rejection to avoid starting another connector\n' >&2
  exit 1
fi
rm -f "$STATE_DIR/connector.lock"

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

for unsafe_state_file in "$PID_FILE" "$PID_META_FILE" "$LOG_FILE"; do
  rm -f "$unsafe_state_file"
  mkfifo "$unsafe_state_file"
  if connector status >/dev/null 2>"$WORK_DIR/non-regular-state-file.err"; then
    printf 'expected status to reject non-regular state file: %s\n' "$unsafe_state_file" >&2
    exit 1
  fi
  rm -f "$unsafe_state_file"
done

started_count_before_signal="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
FAKE_PS_LSTART=""
FAKE_AGENT_IGNORE_TERM=1
export FAKE_PS_LSTART
export FAKE_AGENT_IGNORE_TERM
"$REPO_ROOT/scripts/dogfood-connector.sh" \
  --config "$CONFIG_FILE" \
  --agent-bin "$FAKE_AGENT" \
  --state-dir "$STATE_DIR" \
  --pid-file "$PID_FILE" \
  --pid-meta-file "$PID_META_FILE" \
  --log-file "$LOG_FILE" \
  start >"$WORK_DIR/signalled-start.out" 2>"$WORK_DIR/signalled-start.err" &
signalled_start_pid="$!"
for _ in {1..20}; do
  started_count_after_signal_start="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
  if [[ "$started_count_after_signal_start" == "$((started_count_before_signal + 1))" ]]; then
    break
  fi
  sleep 0.05
done
kill -TERM "$signalled_start_pid" 2>/dev/null || true
set +e
wait "$signalled_start_pid"
signalled_start_status="$?"
set -e
if [[ "$signalled_start_status" -ne 143 ]]; then
  printf 'expected signalled start to exit 143, got %s\n' "$signalled_start_status" >&2
  exit 1
fi
started_count_after_signal="$(wc -l < "$FAKE_AGENT_STARTED_FILE" | tr -d '[:space:]')"
if [[ "$started_count_after_signal" != "$((started_count_before_signal + 1))" ]]; then
  printf 'expected signalled start to launch exactly one child before cleanup\n' >&2
  exit 1
fi
signalled_child_pid="$(tail -n 1 "$FAKE_AGENT_STARTED_FILE" | awk '{print $1}')"
if pid_is_live_non_zombie "$signalled_child_pid"; then
  printf 'expected signal handler to stop child pid %s\n' "$signalled_child_pid" >&2
  exit 1
fi
if [[ -e "$STATE_DIR/connector.lock" || -e "$PID_FILE" || -e "$PID_META_FILE" ]]; then
  printf 'expected signal handler to release lock and clean pid state\n' >&2
  exit 1
fi
FAKE_PS_LSTART="Thu Jun 25 00:00:00 2026"
FAKE_AGENT_IGNORE_TERM=0
export FAKE_PS_LSTART
export FAKE_AGENT_IGNORE_TERM

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
if pid_is_live_non_zombie "$metadata_failure_pid"; then
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
