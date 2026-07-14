#!/usr/bin/env bash
set -euo pipefail

image="jellyfin/jellyfin:10.11.11@sha256:aefb67e6a7ff1debdd154a78a7bbb780fd0c873d8639210a7f6a2016ad2b35db"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
name="streamarr-jellyfin-plugin-ci-${RANDOM}"
uid="$(id -u)"
gid="$(id -g)"
tmp_dir="$(mktemp -d "$repo_root/.streamarr-jellyfin-smoke.XXXXXX")"
log_file="$tmp_dir/jellyfin.log"
fake_core_log="$tmp_dir/fake-core.log"
fake_core_ready="$tmp_dir/fake-core.port"
persistent_config="$tmp_dir/config"
persistent_data="$tmp_dir/data"
persistent_plugin_config="$tmp_dir/plugin-configurations"
plugin_install="$tmp_dir/plugin"
fake_core_pid=""
machine_key="ci-smoke-machine-key"
admin_password="ci-smoke-admin-password"
user_password="ci-smoke-user-password"

cleanup() {
  status=$?
  docker logs "$name" >"$log_file" 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  if [[ -n "$fake_core_pid" ]]; then
    kill "$fake_core_pid" >/dev/null 2>&1 || true
    wait "$fake_core_pid" >/dev/null 2>&1 || true
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "---- Jellyfin smoke log ----" >&2
    cat "$log_file" >&2 || true
    echo "---- fake Core smoke log ----" >&2
    cat "$fake_core_log" >&2 || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

fail() {
  echo "$1" >&2
  exit 1
}

expect_code() {
  local expected="$1"
  local actual="$2"
  local description="$3"
  [[ "$actual" == "$expected" ]] || fail "$description returned HTTP $actual; expected $expected."
}

auth_token() {
  local username="$1"
  local password="$2"
  local authorization="$3"
  local output="$4"
  curl -fsS -X POST "$base_url/Users/AuthenticateByName" \
    -H 'Content-Type: application/json' \
    -H "Authorization: $authorization" \
    --data "{\"Username\":\"$username\",\"Pw\":\"$password\"}" \
    -o "$output"
  jq -er '.AccessToken' "$output"
}

post_plugin_config() {
  local file="$1"
  local code
  code="$(curl -sS -o "$tmp_dir/plugin-config-result.json" -w '%{http_code}' \
    -X POST "$base_url/Plugins/$plugin_id/Configuration" \
    -H "$admin_header" \
    -H 'Content-Type: application/json' \
    --data-binary "@$file")"
  expect_code 204 "$code" "Plugin configuration update"
}

assert_item_absent() {
  local file="$1"
  local collection="$2"
  jq -e --arg id "$item_id" --arg collection "$collection" '
    def normalized: ascii_downcase | gsub("-"; "");
    def values: if type == "array" then . else (.[$collection] // []) end;
    [values[]? |
      select(((.Id // "") | normalized) == ($id | normalized)
        or .Name == "Streamarr (Usenet)")] | length == 0
  ' "$file" >/dev/null
}

assert_item_present() {
  local file="$1"
  local collection="$2"
  jq -e --arg id "$item_id" --arg collection "$collection" '
    def normalized: ascii_downcase | gsub("-"; "");
    def values: if type == "array" then . else (.[$collection] // []) end;
    [values[]? |
      select(((.Id // "") | normalized) == ($id | normalized))] | length == 1
  ' "$file" >/dev/null
}

command -v curl >/dev/null || fail "curl is required."
command -v docker >/dev/null || fail "docker is required."
command -v jq >/dev/null || fail "jq is required."
command -v python3 >/dev/null || fail "python3 is required."
plugin_build="$repo_root/plugin/Streamarr.Plugin/bin/Release/net9.0"
[[ -f "$plugin_build/Streamarr.Plugin.dll" ]] \
  || fail "Build the Release plugin before running the Jellyfin smoke."
mkdir -p "$persistent_config" "$persistent_data" "$persistent_plugin_config" "$plugin_install"
chmod 0700 "$persistent_config" "$persistent_data" "$persistent_plugin_config" "$plugin_install"
# Jellyfin writes its manifest beside the plugin assembly. Copy the build to an isolated install
# directory so the non-root container cannot mutate repository build artifacts.
cp -R "$plugin_build/." "$plugin_install/"

STREAMARR_FAKE_CORE_API_KEY="$machine_key" \
  python3 "$script_dir/fake-core.py" --ready-file "$fake_core_ready" \
  >"$fake_core_log" 2>&1 &
fake_core_pid=$!

for _ in $(seq 1 100); do
  [[ -s "$fake_core_ready" ]] && break
  kill -0 "$fake_core_pid" >/dev/null 2>&1 || fail "The fake Core process exited during startup."
  sleep 0.1
done
[[ -s "$fake_core_ready" ]] || fail "The fake Core did not publish its listening port."
fake_core_port="$(cat "$fake_core_ready")"
curl -fsS "http://127.0.0.1:$fake_core_port/api/v1/health" >/dev/null

docker run -d --name "$name" \
  --user "$uid:$gid" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --add-host host.docker.internal:host-gateway \
  --publish 127.0.0.1::8096 \
  --tmpfs "/tmp:rw,noexec,nosuid,nodev,uid=$uid,gid=$gid,size=128m" \
  --tmpfs "/config:rw,nosuid,nodev,uid=$uid,gid=$gid,mode=0700,size=3g" \
  --tmpfs "/config/plugins:rw,noexec,nosuid,nodev,uid=$uid,gid=$gid,mode=0700,size=32m" \
  --tmpfs "/cache:rw,noexec,nosuid,nodev,uid=$uid,gid=$gid,mode=0700,size=3g" \
  --tmpfs "/media:rw,noexec,nosuid,nodev,uid=$uid,gid=$gid,mode=0700,size=16m" \
  --env HOME=/config \
  --volume "$persistent_config:/config/config" \
  --volume "$persistent_data:/config/data" \
  --volume "$persistent_plugin_config:/config/plugins/configurations" \
  --volume "$plugin_install:/config/plugins/Streamarr" \
  "$image" >/dev/null

port_mapping="$(docker port "$name" 8096/tcp | head -n 1)"
jellyfin_port="${port_mapping##*:}"
base_url="http://127.0.0.1:$jellyfin_port"

healthy=false
for _ in $(seq 1 60); do
  state="$(docker inspect --format '{{.State.Status}}' "$name")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name")"
  if [[ "$state" != "running" ]]; then
    break
  fi
  if [[ "$health" == "healthy" ]] && curl -fsS "$base_url/System/Info/Public" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done

docker logs "$name" >"$log_file" 2>&1 || true
[[ "$healthy" == "true" ]] || fail "Jellyfin did not become healthy."

for expected in \
  "Loaded assembly Streamarr.Plugin" \
  "Loaded plugin: Streamarr" \
  "Streamarr playback event reporter attached" \
  "Core startup complete"; do
  grep -Fq "$expected" "$log_file" \
    || fail "Missing expected Jellyfin/plugin log entry: $expected"
done

# Jellyfin 10.11 does not create its initial user until Startup/User is first read.
curl -fsS "$base_url/Startup/User" >/dev/null
for setup in \
  'Configuration|{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}' \
  "User|{\"Name\":\"streamarr-smoke-admin\",\"Password\":\"$admin_password\"}" \
  'RemoteAccess|{"EnableRemoteAccess":false,"EnableAutomaticPortMapping":false}' \
  'Complete|{}'; do
  endpoint="${setup%%|*}"
  body="${setup#*|}"
  code="$(curl -sS -o "$tmp_dir/setup-$endpoint.json" -w '%{http_code}' \
    -X POST "$base_url/Startup/$endpoint" \
    -H 'Content-Type: application/json' \
    --data "$body")"
  expect_code 204 "$code" "Startup/$endpoint"
done
jq -e '.StartupWizardCompleted == true' < <(curl -fsS "$base_url/System/Info/Public") >/dev/null

admin_auth='MediaBrowser Client="StreamarrSmoke", Device="CI", DeviceId="streamarr-admin-ci", Version="1.0"'
admin_token="$(auth_token streamarr-smoke-admin "$admin_password" "$admin_auth" "$tmp_dir/admin-auth.json")"
admin_header="Authorization: $admin_auth, Token=\"$admin_token\""
plugin_id="6f8d5c7a-9b2e-4a1f-8c3d-2e5a7b9c0d11"

curl -fsS "$base_url/Plugins/$plugin_id/Configuration" \
  -H "$admin_header" \
  -o "$tmp_dir/plugin-config-original.json"
jq --arg server "http://host.docker.internal:$fake_core_port" --arg key "$machine_key" '
  .ServerUrl = $server
  | .ApiKey = $key
  | .PinnedWorkQuery = "CI Smoke Movie"
  | .InterceptionEnabled = false
' "$tmp_dir/plugin-config-original.json" >"$tmp_dir/plugin-config-valid.json"
post_plugin_config "$tmp_dir/plugin-config-valid.json"

code="$(curl -sS -o "$tmp_dir/connection-valid.json" -w '%{http_code}' \
  "$base_url/Streamarr/TestConnection" -H "$admin_header")"
expect_code 200 "$code" "Valid-key TestConnection"
jq -e '.Ok == true and .Version == "ci-fake-core" and .Error == null' \
  "$tmp_dir/connection-valid.json" >/dev/null

jq '.ApiKey = "wrong-machine-key"' \
  "$tmp_dir/plugin-config-valid.json" >"$tmp_dir/plugin-config-wrong-key.json"
post_plugin_config "$tmp_dir/plugin-config-wrong-key.json"
curl -fsS "$base_url/Streamarr/TestConnection" \
  -H "$admin_header" \
  -o "$tmp_dir/connection-wrong-key.json"
jq -e '.Ok == false and .Error == "connection_failed"' \
  "$tmp_dir/connection-wrong-key.json" >/dev/null
post_plugin_config "$tmp_dir/plugin-config-valid.json"

docker exec "$name" mkdir -p /media/movies
code="$(curl -sS -o "$tmp_dir/library-create.json" -w '%{http_code}' \
  -X POST "$base_url/Library/VirtualFolders?name=SmokeMovies&collectionType=movies&paths=%2Fmedia%2Fmovies&refreshLibrary=false" \
  -H "$admin_header" \
  -H 'Content-Type: application/json' \
  --data '{}')"
expect_code 204 "$code" "Movie library creation"
curl -fsS "$base_url/Library/VirtualFolders" -H "$admin_header" -o "$tmp_dir/libraries.json"
library_id="$(jq -er '.[] | select(.Name == "SmokeMovies") | .ItemId' "$tmp_dir/libraries.json")"

for username in streamarr-allowed streamarr-denied; do
  curl -fsS -X POST "$base_url/Users/New" \
    -H "$admin_header" \
    -H 'Content-Type: application/json' \
    --data "{\"Name\":\"$username\",\"Password\":\"$user_password\"}" \
    -o "$tmp_dir/$username.json"
done
allowed_id="$(jq -er '.Id' "$tmp_dir/streamarr-allowed.json")"
denied_id="$(jq -er '.Id' "$tmp_dir/streamarr-denied.json")"
jq --arg folder "$library_id" '
  .Policy
  | .EnableAllFolders = false
  | .EnabledFolders = [$folder]
  | .BlockedMediaFolders = []
' "$tmp_dir/streamarr-allowed.json" >"$tmp_dir/allowed-policy.json"
jq '
  .Policy
  | .EnableAllFolders = false
  | .EnabledFolders = []
  | .BlockedMediaFolders = []
' "$tmp_dir/streamarr-denied.json" >"$tmp_dir/denied-policy.json"
for assignment in \
  "$allowed_id:$tmp_dir/allowed-policy.json" \
  "$denied_id:$tmp_dir/denied-policy.json"; do
  user_id="${assignment%%:*}"
  policy_file="${assignment#*:}"
  code="$(curl -sS -o "$tmp_dir/policy-result.json" -w '%{http_code}' \
    -X POST "$base_url/Users/$user_id/Policy" \
    -H "$admin_header" \
    -H 'Content-Type: application/json' \
    --data-binary "@$policy_file")"
  expect_code 204 "$code" "User policy update"
done

code="$(curl -sS -o "$tmp_dir/materialize.json" -w '%{http_code}' \
  -X POST "$base_url/Streamarr/SyncPinnedWork" \
  -H "$admin_header")"
expect_code 200 "$code" "Pinned work materialization"
jq -e '.Ok == true and .WorkId == "ci-smoke-work"' "$tmp_dir/materialize.json" >/dev/null
item_id="$(jq -er '.ItemId' "$tmp_dir/materialize.json")"

# Restart the actual Jellyfin container. Only narrowly scoped configuration/data directories
# persist; the read-only root and bounded tmpfs mounts are recreated. This proves the plugin's
# release cache survives a host restart rather than being an in-memory-only happy path.
docker restart "$name" >/dev/null
# Docker may allocate a new host port for an anonymous (`::8096`) binding on restart.
port_mapping="$(docker port "$name" 8096/tcp | head -n 1)"
jellyfin_port="${port_mapping##*:}"
base_url="http://127.0.0.1:$jellyfin_port"
restarted=false
for _ in $(seq 1 60); do
  state="$(docker inspect --format '{{.State.Status}}' "$name")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name")"
  if [[ "$state" != "running" ]]; then
    break
  fi
  if [[ "$health" == "healthy" ]] && curl -fsS "$base_url/System/Info/Public" >/dev/null 2>&1; then
    restarted=true
    break
  fi
  sleep 1
done
[[ "$restarted" == "true" ]] || fail "Jellyfin did not become healthy after restart."
docker exec "$name" mkdir -p /media/movies
admin_token="$(auth_token streamarr-smoke-admin "$admin_password" "$admin_auth" "$tmp_dir/admin-reauth.json")"
admin_header="Authorization: $admin_auth, Token=\"$admin_token\""
curl -fsS "$base_url/Streamarr/TestConnection" \
  -H "$admin_header" \
  -o "$tmp_dir/connection-after-restart.json"
jq -e '.Ok == true and .Version == "ci-fake-core"' \
  "$tmp_dir/connection-after-restart.json" >/dev/null

allowed_auth='MediaBrowser Client="StreamarrSmoke", Device="CI", DeviceId="streamarr-allowed-ci", Version="1.0"'
denied_auth='MediaBrowser Client="StreamarrSmoke", Device="CI", DeviceId="streamarr-denied-ci", Version="1.0"'
allowed_token="$(auth_token streamarr-allowed "$user_password" "$allowed_auth" "$tmp_dir/allowed-auth.json")"
denied_token="$(auth_token streamarr-denied "$user_password" "$denied_auth" "$tmp_dir/denied-auth.json")"
allowed_header="Authorization: $allowed_auth, Token=\"$allowed_token\""
denied_header="Authorization: $denied_auth, Token=\"$denied_token\""

allowed_code="$(curl -sS -o "$tmp_dir/allowed-playback.json" -w '%{http_code}' \
  "$base_url/Items/$item_id/PlaybackInfo" -H "$allowed_header")"
denied_code="$(curl -sS -o "$tmp_dir/denied-playback.json" -w '%{http_code}' \
  "$base_url/Items/$item_id/PlaybackInfo" -H "$denied_header")"
expect_code 200 "$allowed_code" "Compatible-user PlaybackInfo"
expect_code 404 "$denied_code" "Restricted-user PlaybackInfo"
jq -e '.MediaSources | length == 1' "$tmp_dir/allowed-playback.json" >/dev/null
open_token="$(jq -er '.MediaSources[0].OpenToken' "$tmp_dir/allowed-playback.json")"
release_id="$(jq -er '.MediaSources[0].Id' "$tmp_dir/allowed-playback.json")"
[[ "$open_token" != "$release_id" ]] || fail "Jellyfin exposed the raw release id as OpenToken."

provider_prefix="${open_token%%_*}"
forged_token="${provider_prefix}_${release_id}"
jq -n --arg token "$forged_token" --arg uid "$allowed_id" --arg item "$item_id" '
  {OpenToken:$token, UserId:$uid, ItemId:$item, PlaySessionId:"forged-ci"}
' >"$tmp_dir/forged-open.json"
code="$(curl -sS -o "$tmp_dir/forged-open-result.json" -w '%{http_code}' \
  -X POST "$base_url/LiveStreams/Open" \
  -H "$allowed_header" \
  -H 'Content-Type: application/json' \
  --data-binary "@$tmp_dir/forged-open.json")"
expect_code 403 "$code" "Forged release-id OpenToken"

jq -n --arg token "$open_token" --arg uid "$denied_id" --arg item "$item_id" '
  {OpenToken:$token, UserId:$uid, ItemId:$item, PlaySessionId:"cross-user-ci"}
' >"$tmp_dir/cross-user-open.json"
code="$(curl -sS -o "$tmp_dir/cross-user-open-result.json" -w '%{http_code}' \
  -X POST "$base_url/LiveStreams/Open" \
  -H "$denied_header" \
  -H 'Content-Type: application/json' \
  --data-binary "@$tmp_dir/cross-user-open.json")"
expect_code 403 "$code" "Cross-user OpenToken"

jq -n --arg token "$open_token" --arg uid "$allowed_id" --arg item "$item_id" '
  {OpenToken:$token, UserId:$uid, ItemId:$item, PlaySessionId:"allowed-ci"}
' >"$tmp_dir/allowed-open.json"
code="$(curl -sS -o "$tmp_dir/allowed-open-result.json" -w '%{http_code}' \
  -X POST "$base_url/LiveStreams/Open" \
  -H "$allowed_header" \
  -H 'Content-Type: application/json' \
  --data-binary "@$tmp_dir/allowed-open.json")"
expect_code 200 "$code" "Authorized opaque OpenToken"

code="$(curl -sS -o "$tmp_dir/replayed-open-result.json" -w '%{http_code}' \
  -X POST "$base_url/LiveStreams/Open" \
  -H "$allowed_header" \
  -H 'Content-Type: application/json' \
  --data-binary "@$tmp_dir/allowed-open.json")"
expect_code 403 "$code" "Replayed OpenToken"

live_stream_id="$(jq -er '.MediaSource.LiveStreamId' "$tmp_dir/allowed-open-result.json")"
code="$(curl -sS -o "$tmp_dir/close-result.json" -w '%{http_code}' \
  -X POST --get "$base_url/LiveStreams/Close" \
  -H "$allowed_header" \
  --data-urlencode "liveStreamId=$live_stream_id")"
expect_code 204 "$code" "Live stream close"

for _ in $(seq 1 50); do
  close_count="$(curl -fsS "http://127.0.0.1:$fake_core_port/__smoke/state" | jq -er '.close')"
  [[ "$close_count" -ge 1 ]] && break
  sleep 0.1
done
[[ "${close_count:-0}" -ge 1 ]] || fail "The queued Core session close was not delivered."
resolve_count="$(curl -fsS "http://127.0.0.1:$fake_core_port/__smoke/state" | jq -er '.resolve')"
[[ "$resolve_count" -eq 1 ]] \
  || fail "Forged, cross-user, or replayed offers reached Core resolve (count=$resolve_count)."

curl -fsS --get "$base_url/Items" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode 'recursive=true' \
  --data-urlencode 'limit=100' \
  -o "$tmp_dir/root-items.json"
curl -fsS --get "$base_url/Items/Latest" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode 'limit=100' \
  -o "$tmp_dir/latest-items.json"
assert_item_absent "$tmp_dir/root-items.json" Items
assert_item_absent "$tmp_dir/latest-items.json" Items

# Disabled interception must be a pure native pass-through and must not contact Core.
search_before="$(curl -fsS "http://127.0.0.1:$fake_core_port/__smoke/state" | jq -er '.search')"
curl -fsS --get "$base_url/Items" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode 'recursive=true' \
  --data-urlencode 'searchTerm=ci-search-canary' \
  -o "$tmp_dir/items-disabled.json"
curl -fsS --get "$base_url/Search/Hints" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode 'searchTerm=ci-search-canary' \
  -o "$tmp_dir/hints-disabled.json"
search_after="$(curl -fsS "http://127.0.0.1:$fake_core_port/__smoke/state" | jq -er '.search')"
[[ "$search_before" -eq "$search_after" ]] || fail "Disabled search interception contacted Core."

# Prove the 10.11 action-filter binding by injecting through both response shapes while reachable.
jq '.InterceptionEnabled = true' \
  "$tmp_dir/plugin-config-valid.json" >"$tmp_dir/plugin-config-interception.json"
post_plugin_config "$tmp_dir/plugin-config-interception.json"
curl -fsS --get "$base_url/Items" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode 'recursive=true' \
  --data-urlencode 'searchTerm=ci-search-canary' \
  -o "$tmp_dir/items-reachable.json"
curl -fsS --get "$base_url/Search/Hints" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode 'searchTerm=ci-search-canary' \
  -o "$tmp_dir/hints-reachable.json"
assert_item_present "$tmp_dir/items-reachable.json" Items
assert_item_present "$tmp_dir/hints-reachable.json" SearchHints

# Point interception at a closed loopback port inside the container. Native Jellyfin responses
# must still succeed and the Core-only synthetic result must disappear from both endpoints.
jq '.ServerUrl = "http://127.0.0.1:1" | .InterceptionEnabled = true' \
  "$tmp_dir/plugin-config-valid.json" >"$tmp_dir/plugin-config-unreachable.json"
post_plugin_config "$tmp_dir/plugin-config-unreachable.json"
items_code="$(curl -sS -o "$tmp_dir/items-unreachable.json" -w '%{http_code}' --get "$base_url/Items" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode 'recursive=true' \
  --data-urlencode 'searchTerm=ci-search-canary')"
hints_code="$(curl -sS -o "$tmp_dir/hints-unreachable.json" -w '%{http_code}' --get "$base_url/Search/Hints" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode 'searchTerm=ci-search-canary')"
expect_code 200 "$items_code" "Native /Items fall-through"
expect_code 200 "$hints_code" "Native /Search/Hints fall-through"
assert_item_absent "$tmp_dir/items-unreachable.json" Items
assert_item_absent "$tmp_dir/hints-unreachable.json" SearchHints

echo "Jellyfin 10.11.11 plugin integration smoke passed."
