#!/usr/bin/env bash
# Regenerate the frozen OpenAPI spec (server/openapi/v1.json) from the running server.
# Used by developers after changing the API and by CI's drift check. The spec is the
# cross-interface contract (BRIEF §3.1) — it must always match the code.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$SERVER_DIR/openapi/v1.json"
PORT="${OPENAPI_PORT:-5199}"
URL="http://127.0.0.1:$PORT"

TMP="$(mktemp -d)"
cleanup() { kill "${SV_PID:-}" 2>/dev/null || true; wait "${SV_PID:-}" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

export Streamarr__ConnectionString="Data Source=$TMP/streamarr.db"
export Streamarr__DataProtectionKeysPath="$TMP/keys"
export ASPNETCORE_ENVIRONMENT=Development

dotnet run --project "$SERVER_DIR/src/Streamarr.Server/Streamarr.Server.csproj" \
  --no-launch-profile --urls "$URL" > "$TMP/server.log" 2>&1 &
SV_PID=$!

ready=false
# A cold GitHub runner can spend more than 30 seconds restoring and compiling the
# server before it starts listening. Keep the wait bounded, but allow enough time
# for a clean SDK cache instead of relying on developer-machine build artifacts.
for _ in $(seq 1 240); do
  if curl -sf "$URL/api/v1/health?deep=false" >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$SV_PID" 2>/dev/null; then
    echo "server exited before OpenAPI endpoint became ready"
    tail -100 "$TMP/server.log"
    exit 1
  fi
  sleep 0.5
done

if [[ "$ready" != true ]]; then
  echo "server did not become ready within 120 seconds"
  tail -100 "$TMP/server.log"
  exit 1
fi

mkdir -p "$SERVER_DIR/openapi"
curl -sf "$URL/openapi/v1.json" -o "$TMP/raw.json" || { echo "failed to fetch spec"; tail -100 "$TMP/server.log"; exit 1; }

# Deterministic formatting (2-space indent, trailing newline) so diffs are stable.
python3 -c "import json,sys; json.dump(json.load(open('$TMP/raw.json')), open('$OUT','w'), indent=2, ensure_ascii=False); open('$OUT','a').write('\n')"

echo "Wrote $OUT"
