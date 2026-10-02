#!/usr/bin/env bash
# Siri Remote for the tvOS simulator via WebDriverAgent (XCUIRemote); argent's HID input does not work on tvOS 27.
# Usage: tv-remote.sh build|start|stop|status|press <buttons...>|long <button>|type <text>|source|focus
set -euo pipefail
UDID="${TV_UDID:-F66EF5E2-F5D9-4F46-B6B9-34B685F5B289}"
WDA="${WDA_DIR:-$HOME/.cache/streamarr-wda}"
PORT="${WDA_PORT:-8100}"
BUNDLE="${TV_BUNDLE:-dev.streamarr.app}"
URL="http://127.0.0.1:$PORT"
SESSION_FILE="/tmp/streamarr-wda-session-$PORT"
source "$(dirname "$0")/env.sh" >/dev/null

session() {
  if [[ -f "$SESSION_FILE" ]] && curl -sf "$URL/session/$(cat "$SESSION_FILE")" >/dev/null 2>&1; then
    cat "$SESSION_FILE"
    return
  fi
  curl -sf -X POST "$URL/session" -H 'Content-Type: application/json' \
    -d "{\"capabilities\":{\"alwaysMatch\":{\"bundleId\":\"$BUNDLE\",\"shouldWaitForQuiescence\":false}}}" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["value"]["sessionId"])' | tee "$SESSION_FILE"
}

post() { curl -sf -X POST "$URL/session/$(session)/$1" -H 'Content-Type: application/json' -d "$2" >/dev/null; }

case "${1:-}" in
  build)
    [[ -d "$WDA" ]] || git clone --depth 1 https://github.com/appium/WebDriverAgent "$WDA"
    xcodebuild build-for-testing -project "$WDA/WebDriverAgent.xcodeproj" -scheme WebDriverAgentRunner_tvOS \
      -destination "platform=tvOS Simulator,id=$UDID" -derivedDataPath "$WDA/dd" -jobs 4 CODE_SIGNING_ALLOWED=NO | tail -2
    ;;
  start)
    curl -sf "$URL/status" >/dev/null 2>&1 && { echo "already running"; exit 0; }
    xctestrun=$(ls "$WDA"/dd/Build/Products/WebDriverAgentRunner_tvOS_*.xctestrun | head -1)
    USE_PORT=$PORT nohup xcodebuild test-without-building -xctestrun "$xctestrun" \
      -destination "platform=tvOS Simulator,id=$UDID" >/tmp/streamarr-wda.log 2>&1 &
    for _ in $(seq 1 90); do curl -sf "$URL/status" >/dev/null 2>&1 && { echo "WDA up on $PORT"; exit 0; }; sleep 1; done
    echo "WDA did not start, see /tmp/streamarr-wda.log" >&2; exit 1
    ;;
  stop)
    pkill -f "test-without-building -xctestrun $WDA" || true
    rm -f "$SESSION_FILE"
    echo stopped
    ;;
  status) curl -s "$URL/status" ;;
  press)
    shift
    for b in "$@"; do post wda/pressButton "{\"name\":\"$b\"}"; sleep "${TV_PRESS_DELAY:-0.4}"; done
    ;;
  long) post wda/pressButton "{\"name\":\"$2\",\"duration\":${3:-1.5}}" ;;
  type) post wda/keys "$(python3 -c 'import json,sys; print(json.dumps({"value": list(sys.argv[1])}))' "$2")" ;;
  source) curl -sf "$URL/session/$(session)/source?format=description" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])' ;;
  focus) "$0" source | grep -n "Focused" || echo "no focused element" ;;
  *) sed -n '3p' "$0"; exit 2 ;;
esac
