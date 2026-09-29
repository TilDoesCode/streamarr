#!/usr/bin/env bash
# Streamarr Dev World control script (see server/tests/Streamarr.DevWorld/README.md).
#
#   devworld.sh publish                 build + publish the working tree's Dev World into
#                                       ~/.cache/streamarr-devworld/current (atomic swap after the staged
#                                       build generated/validated the media, booted on a scratch port and
#                                       resolved every release as its fixture health)
#   devworld.sh start [port] [--tree]   run the published snapshot (or, with --tree, the working tree)
#                                       in the background, wait until ready, log to /tmp/devworld-<port>.log
#   devworld.sh stop [port]             stop the instance on <port> (default 39300)
#   devworld.sh status                  published snapshot + running instances (pid, readiness, RSS)
#   devworld.sh run [port]              foreground run of the snapshot (Codecraft action)
#   devworld.sh verify [port]           end-to-end check of a running instance (curl flow + ffprobe)
#   devworld.sh totp [port]             current TOTP code for the seeded viewer 'ben'
#
# Ports: client work 39300 (Android emulator: http://10.0.2.2:39300), backend self-tests 39310.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$ROOT/server/tests/Streamarr.DevWorld"
PROJECT="$PROJECT_DIR/Streamarr.DevWorld.csproj"
CACHE_DIR="${DEVWORLD_CACHE_DIR:-$PROJECT_DIR/cache}"
SNAP_ROOT="${DEVWORLD_SNAPSHOT_ROOT:-$HOME/.cache/streamarr-devworld}"
START_TIMEOUT="${DEVWORLD_START_TIMEOUT:-1200}"
PUBLISH_PORT="${DEVWORLD_PUBLISH_PORT:-39319}"
PUB_STAGE=""
PUB_BOOT_PID=""

if [ -f "$ROOT/docs/client/env.sh" ]; then
  # shellcheck source=/dev/null
  source "$ROOT/docs/client/env.sh"
fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
DOTNET="$(command -v dotnet || echo "$HOME/.dotnet/dotnet")"

die() { echo "devworld: $*" >&2; exit 1; }
pidfile() { echo "/tmp/devworld-$1.pid"; }
logfile() { echo "/tmp/devworld-$1.log"; }
pid_of() { cat "$(pidfile "$1")" 2>/dev/null || true; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
base_url() {
  local host="${DEVWORLD_HOST:-0.0.0.0}"
  case "$host" in
    0.0.0.0 | :: | '[::]' | '*' | + | localhost) host=127.0.0.1 ;;
    \[*) ;;
    *:*) host="[$host]" ;;
  esac
  echo "http://$host:$1"
}
ready() { curl -fsS -m 2 "$(base_url "$1")/devworld/ready" >/dev/null 2>&1; }
listener() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true; }
rss_mb() { ps -o rss= -p "$1" 2>/dev/null | awk '{printf "%.0f MB", $1/1024}'; }
port_arg() { local p="${1:-${DEVWORLD_PORT:-39300}}"; [[ "$p" =~ ^[0-9]+$ ]] || die "invalid port '$p'"; echo "$p"; }

swap_link() {
  if [ "$(uname)" = "Darwin" ]; then mv -fh "$1" "$2"; else mv -fT "$1" "$2"; fi
}

stop_pid() {
  kill -TERM "$1" 2>/dev/null || true
  for _ in $(seq 1 30); do alive "$1" || return 0; sleep 0.5; done
  kill -KILL "$1" 2>/dev/null || true
}

publish_cleanup() {
  if [ -n "$PUB_BOOT_PID" ]; then
    stop_pid "$PUB_BOOT_PID"
    rm -f "$CACHE_DIR/devworld-$PUBLISH_PORT.json"
  fi
  if [ -n "$PUB_STAGE" ]; then rm -rf "$PUB_STAGE"; fi
}

boot_check() {
  local stage="$1" log="$1/boot-check.log" waited=0
  [ -z "$(listener "$PUBLISH_PORT")" ] || die "boot-check port $PUBLISH_PORT is in use (set DEVWORLD_PUBLISH_PORT)"
  echo "devworld: boot check of the staged build on 127.0.0.1:$PUBLISH_PORT (resolves every release)"
  DEVWORLD_PORT="$PUBLISH_PORT" DEVWORLD_HOST=127.0.0.1 DEVWORLD_PRIMARY=0 DEVWORLD_CACHE_DIR="$CACHE_DIR" DEVWORLD_CHECK_RELEASES=1 \
    DEVWORLD_STATE_DIR="$stage/boot-state" DEVWORLD_SNAPSHOT_INFO="$stage/snapshot.json" \
    "$DOTNET" "$stage/app/Streamarr.DevWorld.dll" > "$log" 2>&1 < /dev/null &
  PUB_BOOT_PID=$!
  until curl -fsS -m 2 "http://127.0.0.1:$PUBLISH_PORT/devworld/ready" >/dev/null 2>&1; do
    if ! alive "$PUB_BOOT_PID"; then
      grep -vF "GET /devworld/ready completed 503" "$log" | tail -n 40 >&2
      die "the staged build failed its boot check (log above); the published snapshot is unchanged"
    fi
    [ "$waited" -lt 300 ] || die "the staged build was not ready after 300s; the published snapshot is unchanged"
    sleep 1
    waited=$((waited + 1))
  done
  stop_pid "$PUB_BOOT_PID"
  PUB_BOOT_PID=""
  grep -F "release check:" "$log" | sed 's/^\[devworld\] /devworld: /' || true
  rm -rf "$stage/boot-state" "$log" "$CACHE_DIR/devworld-$PUBLISH_PORT.json"
  echo "devworld: staged build booted and passed its warm-up and release checks (${waited}s)"
}

cmd_publish() {
  mkdir -p "$SNAP_ROOT/releases"
  local stamp stage
  [ -z "$(listener "$PUBLISH_PORT")" ] || die "boot-check port $PUBLISH_PORT is in use (set DEVWORLD_PUBLISH_PORT)"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  stage="$SNAP_ROOT/releases/.staging-$stamp"
  PUB_STAGE="$stage"
  trap publish_cleanup EXIT
  echo "devworld: publishing $PROJECT"
  # No lingering MSBuild worker nodes or compiler server (8 GB machine).
  "$DOTNET" publish "$PROJECT" -c Release -o "$stage/app" --nologo -v q --disable-build-servers
  local commit dirty
  commit="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  dirty="$(git -C "$ROOT" status --porcelain 2>/dev/null | grep -c . || true)"
  cat > "$stage/snapshot.json" <<EOF
{ "publishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "gitCommit": "$commit", "uncommittedFiles": $dirty, "repoRoot": "$ROOT", "cacheDir": "$CACHE_DIR" }
EOF
  echo "devworld: generating/validating media with the staged build (cold run can take minutes)"
  DEVWORLD_CACHE_DIR="$CACHE_DIR" "$DOTNET" "$stage/app/Streamarr.DevWorld.dll" --generate-only
  boot_check "$stage"
  mv "$stage" "$SNAP_ROOT/releases/$stamp"
  PUB_STAGE=""
  trap - EXIT
  ln -s "releases/$stamp" "$SNAP_ROOT/current.new.$$"
  swap_link "$SNAP_ROOT/current.new.$$" "$SNAP_ROOT/current"
  # Keep the three newest snapshots plus any a running instance still loads assemblies from.
  local running
  running="$(ps -axo command= 2>/dev/null | grep -F "Streamarr.DevWorld.dll" || true)"
  ls -1d "$SNAP_ROOT"/releases/2* 2>/dev/null | sort -r | tail -n +4 | while read -r old; do
    if grep -qF "/releases/$(basename "$old")/app/" <<<"$running"; then
      echo "devworld: keeping $(basename "$old") (a running instance uses it)"
    else
      rm -rf "$old"
    fi
  done
  echo "devworld: published $SNAP_ROOT/current -> releases/$stamp (commit ${commit:0:10}, $dirty uncommitted file(s))"
}

snapshot_dir() {
  [ -e "$SNAP_ROOT/current" ] || die "no published snapshot; run 'scripts/devworld.sh publish' first"
  (cd -P "$SNAP_ROOT/current" && pwd)
}

cmd_start() {
  local port="" tree=0
  for arg in "$@"; do
    case "$arg" in
      --tree) tree=1 ;;
      *) port="$arg" ;;
    esac
  done
  port="$(port_arg "$port")"
  local pid log dll snapinfo="" label="working tree"
  pid="$(pid_of "$port")"
  log="$(logfile "$port")"
  if alive "$pid"; then
    if ready "$port"; then echo "devworld: already running on $port (pid $pid)"; return 0; fi
    die "an instance (pid $pid) is starting or unhealthy on $port; see $log or run 'stop $port'"
  fi
  local holder
  holder="$(listener "$port")"
  [ -z "$holder" ] || die "port $port is in use by pid $holder ($(ps -o command= -p "$holder" | cut -c1-80))"

  if [ "$tree" = 1 ]; then
    echo "devworld: building the working tree"
    "$DOTNET" build "$PROJECT" -c Debug --nologo -v q --disable-build-servers
    dll="$PROJECT_DIR/bin/Debug/net8.0/Streamarr.DevWorld.dll"
  else
    local snap
    snap="$(snapshot_dir)"
    dll="$snap/app/Streamarr.DevWorld.dll"
    snapinfo="$snap/snapshot.json"
    label="snapshot $(basename "$snap")"
  fi
  [ -f "$dll" ] || die "missing $dll"

  echo "devworld: starting on $port ($label); log $log"
  DEVWORLD_PORT="$port" DEVWORLD_CACHE_DIR="$CACHE_DIR" DEVWORLD_SNAPSHOT_INFO="$snapinfo" \
    nohup "$DOTNET" "$dll" > "$log" 2>&1 < /dev/null &
  pid=$!
  echo "$pid" > "$(pidfile "$port")"

  local waited=0
  until ready "$port"; do
    if ! alive "$pid"; then
      tail -n 40 "$log" >&2
      rm -f "$(pidfile "$port")"
      die "Dev World exited during startup (see $log)"
    fi
    if [ "$waited" -ge "$START_TIMEOUT" ]; then
      die "not ready after ${START_TIMEOUT}s (pid $pid still running; see $log)"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  sed -n '/^=====/,/^=====/p' "$log"
  echo "devworld: ready on $(base_url "$port") (pid $pid, $(rss_mb "$pid"), ${waited}s)"
}

cmd_stop() {
  local port pid
  port="$(port_arg "${1:-}")"
  pid="$(pid_of "$port")"
  if ! alive "$pid"; then
    pid="$(listener "$port")"
    if [ -n "$pid" ] && ! ps -o command= -p "$pid" | grep -q "Streamarr.DevWorld"; then
      die "port $port is held by a non-Dev-World process ($pid); not stopping it"
    fi
  fi
  if ! alive "$pid"; then
    rm -f "$(pidfile "$port")"
    echo "devworld: nothing running on $port"
    return 0
  fi
  stop_pid "$pid"
  rm -f "$(pidfile "$port")"
  echo "devworld: stopped $port (pid $pid)"
}

cmd_status() {
  if [ -e "$SNAP_ROOT/current" ]; then
    echo "snapshot: $(snapshot_dir)"
    sed 's/^/  /' "$(snapshot_dir)/snapshot.json"
  else
    echo "snapshot: none (run 'scripts/devworld.sh publish')"
  fi
  local any=0
  for f in /tmp/devworld-*.pid; do
    [ -e "$f" ] || continue
    any=1
    local port pid state source
    port="$(basename "$f" .pid)"; port="${port#devworld-}"
    pid="$(cat "$f")"
    if ! alive "$pid"; then state="dead (stale pidfile)"
    elif ready "$port"; then state="ready, $(rss_mb "$pid")"
    else state="starting"; fi
    source="$(ps -o command= -p "$pid" 2>/dev/null | grep -o '[^ ]*Streamarr.DevWorld.dll' || true)"
    echo "port $port: pid $pid, $state ${source:+($source)}  log $(logfile "$port")"
  done
  [ "$any" = 1 ] || echo "instances: none"
}

cmd_run() {
  local port snap
  port="$(port_arg "${1:-}")"
  snap="$(snapshot_dir)"
  DEVWORLD_PORT="$port" DEVWORLD_CACHE_DIR="$CACHE_DIR" DEVWORLD_SNAPSHOT_INFO="$snap/snapshot.json" \
    exec "$DOTNET" "$snap/app/Streamarr.DevWorld.dll"
}

cmd_verify() {
  local port
  port="$(port_arg "${1:-}")"
  python3 "$PROJECT_DIR/tools/verify_devworld.py" "$(base_url "$port")"
}

cmd_totp() {
  local port
  port="$(port_arg "${1:-}")"
  curl -fsS "$(base_url "$port")/devworld/totp/ben"
  echo
}

case "${1:-}" in
  publish) shift; cmd_publish "$@" ;;
  start) shift; cmd_start "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  status) shift; cmd_status "$@" ;;
  run) shift; cmd_run "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  totp) shift; cmd_totp "$@" ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
