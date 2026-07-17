#!/usr/bin/env bash
set -euo pipefail

image="jellyfin/jellyfin:10.11.11@sha256:aefb67e6a7ff1debdd154a78a7bbb780fd0c873d8639210a7f6a2016ad2b35db"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
name="streamarr-jellyfin-plugin-ci-${RANDOM}"
uid="$(id -u)"
gid="$(id -g)"
artifact_root="${STREAMARR_SMOKE_ARTIFACT_ROOT:-$repo_root/artifacts}"
keep_artifacts="${STREAMARR_SMOKE_KEEP_ARTIFACTS:-0}"
mkdir -p "$artifact_root"
tmp_dir="$(mktemp -d "$artifact_root/jellyfin-smoke.XXXXXX")"
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
movie_name="Streamarr CI Smoke Movie"
series_name="Streamarr CI Smoke Series"
movie_release_id="ci-smoke-release"
movie_release_name="1080p WEB-DL x264 · EN · 1 MiB"
movie_alt_release_id="ci-smoke-release-alt"
movie_alt_release_name="2160p WEB-DL x265 HDR10 · DDP5.1 · DE/EN · 3 MiB"
episode_release_id="ci-smoke-tv-release"
episode_release_name="1080p WEB-DL x264 · EN · 2 MiB"
episode_alt_release_id="ci-smoke-tv-release-alt"
episode_alt_release_name="720p WEB-DL x264 · DE · 1 MiB"

# Official clients treat multi-version media-source ids as item ids (Jellyfin Web fetches them
# via /Users/{uid}/Items/{id}; Android TV parses them as UUIDs), so the plugin exposes
# GUID-shaped source ids derived from (workId, releaseId). Mirror that derivation here.
release_source_id() {
  python3 - "$1" "$2" <<'PY'
import hashlib
import sys
import uuid

digest = hashlib.md5(f"streamarr-release:{sys.argv[1]}:{sys.argv[2]}".encode("utf-16-le")).digest()
print(uuid.UUID(bytes_le=digest).hex)
PY
}
movie_source_id="$(release_source_id ci-smoke-work "$movie_release_id")"
movie_alt_source_id="$(release_source_id ci-smoke-work "$movie_alt_release_id")"
episode_source_id="$(release_source_id ci-smoke-series-s01e01 "$episode_release_id")"
episode_alt_source_id="$(release_source_id ci-smoke-series-s01e01 "$episode_alt_release_id")"

redact_diagnostics() {
  sed -E \
    -e 's/(Bearer )[[:graph:]]+/\1<redacted>/g' \
    -e 's/(Token="?)[^",[:space:]]+/\1<redacted>/g' \
    -e 's/(ApiKey[^[:alnum:]]+)[^",<[:space:]]+/\1<redacted>/g'
}

cleanup() {
  status=$?
  docker logs "$name" >"$log_file" 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  if [[ -n "$fake_core_pid" ]]; then
    kill "$fake_core_pid" >/dev/null 2>&1 || true
    wait "$fake_core_pid" >/dev/null 2>&1 || true
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "---- bounded Jellyfin/plugin diagnostics (last 250 matching lines) ----" >&2
    grep -Ei 'Streamarr\.Plugin|\[ERR\]|\[WRN\]|exception|failed|failure' "$log_file" \
      | tail -n 250 \
      | redact_diagnostics >&2 || true
    echo "---- bounded fake Core diagnostics (last 100 lines) ----" >&2
    tail -n 100 "$fake_core_log" | redact_diagnostics >&2 || true
    echo "Jellyfin smoke artifacts preserved at: $tmp_dir" >&2
  elif [[ "$keep_artifacts" == "1" ]]; then
    echo "Jellyfin smoke artifacts preserved at: $tmp_dir"
  else
    rm -rf "$tmp_dir"
  fi
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

assert_named_item() {
  local file="$1"
  local collection="$2"
  local name="$3"
  local kind="$4"
  local is_folder="$5"
  jq -e --arg collection "$collection" --arg name "$name" --arg kind "$kind" \
    --argjson isFolder "$is_folder" '
    def values: if type == "array" then . else (.[$collection] // []) end;
    [values[]? | select(.Name == $name)] as $matches
    | ($matches | length) == 1
      and $matches[0].Type == $kind
      and $matches[0].IsFolder == $isFolder
  ' "$file" >/dev/null
}

assert_named_item_absent() {
  local file="$1"
  local collection="$2"
  local name="$3"
  jq -e --arg collection "$collection" --arg name "$name" '
    def values: if type == "array" then . else (.[$collection] // []) end;
    [values[]? | select(.Name == $name)] | length == 0
  ' "$file" >/dev/null
}

named_item_id() {
  local file="$1"
  local collection="$2"
  local name="$3"
  local kind="$4"
  jq -er --arg collection "$collection" --arg name "$name" --arg kind "$kind" '
    def values: if type == "array" then . else (.[$collection] // []) end;
    [values[]? | select(.Name == $name and .Type == $kind)]
    | select(length == 1)
    | .[0].Id
  ' "$file"
}

core_count() {
  local key="$1"
  curl -fsS "http://127.0.0.1:$fake_core_port/__smoke/state" | jq -er --arg key "$key" '.[$key]'
}

assert_release_sources() {
  local file="$1"
  local expected_count="$2"
  local first_id="${3:-}"
  local first_name="${4:-}"
  local second_id="${5:-}"
  local second_name="${6:-}"
  jq -e \
    --argjson expectedCount "$expected_count" \
    --arg firstId "$first_id" \
    --arg firstName "$first_name" \
    --arg secondId "$second_id" \
    --arg secondName "$second_name" '
      (.MediaSourceCount == $expectedCount)
        and ((.MediaSources // []) | length) == $expectedCount
        and if $expectedCount == 0 then
          true
        else
          .MediaSources[0].Id == $firstId
            and .MediaSources[0].Name == $firstName
            and .MediaSources[0].RequiresOpening == true
            and (.MediaSources[0].OpenToken | type == "string" and length > 0)
            and .MediaSources[0].OpenToken != .MediaSources[0].Id
            and .MediaSources[1].Id == $secondId
            and .MediaSources[1].Name == $secondName
            and .MediaSources[1].RequiresOpening == true
            and (.MediaSources[1].OpenToken | type == "string" and length > 0)
            and .MediaSources[1].OpenToken != .MediaSources[1].Id
            and .MediaSources[0].OpenToken != .MediaSources[1].OpenToken
        end
    ' "$file" >/dev/null
}

assert_last_resolve() {
  local expected_release="$1"
  local expected_work="$2"
  curl -fsS "http://127.0.0.1:$fake_core_port/__smoke/state" \
    | jq -e --arg release "$expected_release" --arg work "$expected_work" '
        .lastResolve == {releaseId:$release, workId:$work, client:"jellyfin"}
      ' >/dev/null
}

close_live_stream() {
  local live_stream_id="$1"
  local output="$2"
  local code
  code="$(curl -sS -o "$output" -w '%{http_code}' \
    -X POST --get "$base_url/LiveStreams/Close" \
    -H "$allowed_header" \
    --data-urlencode "liveStreamId=$live_stream_id")"
  expect_code 204 "$code" "Live stream close"
}

assert_streamyfin_opened_source() {
  local file="$1"
  local expected_path="$2"
  jq -e --arg path "$expected_path" '
    (.PlaySessionId | type == "string" and length > 0)
      and (.MediaSources | length) == 1
      and (.MediaSources[0] as $source
        | $source.IsRemote == true
          and $source.Protocol == "Http"
          and $source.Path == $path
          and $source.TranscodingUrl == null
          and $source.RequiresOpening == false
          and ($source.LiveStreamId | type == "string" and length > 0)
          and (($source.RequiredHttpHeaders // {}) | length) == 0)
  ' "$file" >/dev/null

  # Streamyfin hands this Path directly to MPV and deliberately adds no Jellyfin auth header for
  # an HTTP remote source. Prove the advertised capability is reachable on exactly that basis.
  curl -fsS "$expected_path" >/dev/null
}

command -v curl >/dev/null || fail "curl is required."
command -v docker >/dev/null || fail "docker is required."
command -v jq >/dev/null || fail "jq is required."
command -v python3 >/dev/null || fail "python3 is required."
plugin_build="${STREAMARR_SMOKE_PLUGIN_BUILD:-$repo_root/plugin/Streamarr.Plugin/bin/Release/net9.0}"
[[ -f "$plugin_build/Streamarr.Plugin.dll" ]] \
  || fail "Build the Release plugin before running the Jellyfin smoke."
mkdir -p "$persistent_config" "$persistent_data" "$persistent_plugin_config" "$plugin_install"
chmod 0700 "$persistent_config" "$persistent_data" "$persistent_plugin_config" "$plugin_install"
# Keep host noise at Information/Warning while making the plugin's request classification,
# injection, and hierarchy decisions visible in the bounded console diagnostics.
jq -n '{
  Serilog: {
    MinimumLevel: {
      Default: "Information",
      Override: {
        Microsoft: "Warning",
        System: "Warning",
        "Streamarr.Plugin": "Debug"
      }
    },
    WriteTo: [
      {
        Name: "Console",
        Args: {
          outputTemplate: "[{Timestamp:HH:mm:ss}] [{Level:u3}] [{ThreadId}] {SourceContext}: {Message:lj}{NewLine}{Exception}"
        }
      },
      {
        Name: "Async",
        Args: {
          configure: [
            {
              Name: "File",
              Args: {
                path: "%JELLYFIN_LOG_DIR%//log_.log",
                rollingInterval: "Day",
                retainedFileCountLimit: 2,
                rollOnFileSizeLimit: true,
                fileSizeLimitBytes: 10000000,
                outputTemplate: "[{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz}] [{Level:u3}] [{ThreadId}] {SourceContext}: {Message}{NewLine}{Exception}"
              }
            }
          ]
        }
      }
    ],
    Enrich: ["FromLogContext", "WithThreadId"]
  }
}' >"$persistent_config/logging.default.json"
chmod 0600 "$persistent_config/logging.default.json"
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
jq \
  --arg server "http://host.docker.internal:$fake_core_port" \
  --arg publicStream "http://127.0.0.1:$fake_core_port" \
  --arg key "$machine_key" '
  .ServerUrl = $server
  | .PublicStreamUrl = $publicStream
  | .ApiKey = $key
  | .PinnedWorkQuery = "CI Smoke Movie"
  | .InterceptionEnabled = false
' "$tmp_dir/plugin-config-original.json" >"$tmp_dir/plugin-config-valid.json"
post_plugin_config "$tmp_dir/plugin-config-valid.json"
public_stream_base="http://127.0.0.1:$fake_core_port"

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

docker exec "$name" mkdir -p /media/movies /media/tv
code="$(curl -sS -o "$tmp_dir/movie-library-create.json" -w '%{http_code}' \
  -X POST "$base_url/Library/VirtualFolders?name=SmokeMovies&collectionType=movies&paths=%2Fmedia%2Fmovies&refreshLibrary=false" \
  -H "$admin_header" \
  -H 'Content-Type: application/json' \
  --data '{}')"
expect_code 204 "$code" "Movie library creation"
code="$(curl -sS -o "$tmp_dir/tv-library-create.json" -w '%{http_code}' \
  -X POST "$base_url/Library/VirtualFolders?name=SmokeTV&collectionType=tvshows&paths=%2Fmedia%2Ftv&refreshLibrary=false" \
  -H "$admin_header" \
  -H 'Content-Type: application/json' \
  --data '{}')"
expect_code 204 "$code" "TV library creation"
curl -fsS "$base_url/Library/VirtualFolders" -H "$admin_header" -o "$tmp_dir/libraries.json"
movie_library_id="$(jq -er '.[] | select(.Name == "SmokeMovies" and .CollectionType == "movies") | .ItemId' "$tmp_dir/libraries.json")"
tv_library_id="$(jq -er '.[] | select(.Name == "SmokeTV" and .CollectionType == "tvshows") | .ItemId' "$tmp_dir/libraries.json")"

for username in streamarr-allowed streamarr-denied; do
  curl -fsS -X POST "$base_url/Users/New" \
    -H "$admin_header" \
    -H 'Content-Type: application/json' \
    --data "{\"Name\":\"$username\",\"Password\":\"$user_password\"}" \
    -o "$tmp_dir/$username.json"
done
allowed_id="$(jq -er '.Id' "$tmp_dir/streamarr-allowed.json")"
denied_id="$(jq -er '.Id' "$tmp_dir/streamarr-denied.json")"
jq --arg movieFolder "$movie_library_id" --arg tvFolder "$tv_library_id" '
  .Policy
  | .EnableAllFolders = false
  | .EnabledFolders = [$movieFolder, $tvFolder]
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
docker exec "$name" mkdir -p /media/movies /media/tv
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
jq -e --arg first "$movie_source_id" --arg second "$movie_alt_source_id" '
  (.MediaSources | length) == 2
    and .MediaSources[0].Id == $first
    and .MediaSources[1].Id == $second
' "$tmp_dir/allowed-playback.json" >/dev/null

# Streamyfin's item page lazily requests full sources through /Items?ids=... rather than either
# single-item detail route. This must work independently of the discovery toggle (still off here).
curl -fsS --get "$base_url/Items" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode "ids=$item_id" \
  --data-urlencode 'fields=MediaSources,MediaSourceCount,MediaStreams' \
  -o "$tmp_dir/streamyfin-item-with-sources.json"
jq -e --arg id "${item_id//-/}" '
  (.Items | length) == 1 and .Items[0].Id == $id
' "$tmp_dir/streamyfin-item-with-sources.json" >/dev/null
jq -e '.Items[0]' "$tmp_dir/streamyfin-item-with-sources.json" \
  >"$tmp_dir/streamyfin-item-source.json"
assert_release_sources \
  "$tmp_dir/streamyfin-item-source.json" 2 \
  "$movie_source_id" "$movie_release_name" \
  "$movie_alt_source_id" "$movie_alt_release_name"

open_token="$(jq -er --arg id "$movie_source_id" '.MediaSources[] | select(.Id == $id) | .OpenToken' \
  "$tmp_dir/allowed-playback.json")"
release_id="$movie_source_id"
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
close_live_stream "$live_stream_id" "$tmp_dir/close-result.json"

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

# Exercise the exact Jellyfin Web grouped-search request, then follow the same detail,
# PlaybackInfo, season, and episode APIs used after clicking the injected results. This is the
# regression path that a host-load-only smoke cannot cover.
curl -fsS --get "$base_url/Items" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode 'recursive=true' \
  --data-urlencode 'searchTerm=ci-search-canary' \
  --data-urlencode 'includeItemTypes=Movie,Series,Episode,Playlist,MusicAlbum,Audio,TvChannel,PhotoAlbum,Photo,AudioBook,Book,BoxSet' \
  --data-urlencode 'isMissing=false' \
  --data-urlencode 'limit=800' \
  --data-urlencode 'fields=PrimaryImageAspectRatio,CanDelete,MediaSourceCount' \
  --data-urlencode 'enableTotalRecordCount=false' \
  --data-urlencode 'imageTypeLimit=1' \
  -o "$tmp_dir/grouped-search.json"
assert_named_item "$tmp_dir/grouped-search.json" Items "$movie_name" Movie false
assert_named_item "$tmp_dir/grouped-search.json" Items "$series_name" Series true
movie_id="$(named_item_id "$tmp_dir/grouped-search.json" Items "$movie_name" Movie)"
series_id="$(named_item_id "$tmp_dir/grouped-search.json" Items "$series_name" Series)"

curl -fsS --get "$base_url/Items/$movie_id" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  -o "$tmp_dir/movie-detail.json"
curl -fsS "$base_url/Users/$allowed_id/Items/$movie_id" \
  -H "$allowed_header" \
  -o "$tmp_dir/movie-detail-legacy.json"
jq -e --arg id "$movie_id" '
  .Id == $id
    and .Type == "Movie"
    and .LocationType == "Remote"
' "$tmp_dir/movie-detail.json" >/dev/null
assert_release_sources \
  "$tmp_dir/movie-detail.json" 2 \
  "$movie_source_id" "$movie_release_name" \
  "$movie_alt_source_id" "$movie_alt_release_name"
jq -e --arg id "$movie_id" '
  .Id == $id
    and .Type == "Movie"
    and .LocationType == "Remote"
' "$tmp_dir/movie-detail-legacy.json" >/dev/null
assert_release_sources \
  "$tmp_dir/movie-detail-legacy.json" 2 \
  "$movie_source_id" "$movie_release_name" \
  "$movie_alt_source_id" "$movie_alt_release_name"

# Jellyfin Web resolves a selected version by fetching its media-source id as an item id (and
# Android TV parses it as a UUID). The plugin must answer with the owning item's DTO, while a
# restricted user keeps getting Jellyfin's native 404.
curl -fsS "$base_url/Users/$allowed_id/Items/$movie_alt_source_id" \
  -H "$allowed_header" \
  -o "$tmp_dir/movie-release-item.json"
jq -e --arg id "$movie_id" '
  .Id == $id and .Type == "Movie" and (.MediaSources | length) == 2
' "$tmp_dir/movie-release-item.json" >/dev/null
denied_lookup_code="$(curl -sS -o /dev/null -w '%{http_code}' \
  "$base_url/Users/$denied_id/Items/$movie_alt_source_id" -H "$denied_header")"
expect_code 404 "$denied_lookup_code" "Restricted-user release-item lookup"

curl -fsS "$base_url/Items/$movie_id/PlaybackInfo" \
  -H "$allowed_header" \
  -o "$tmp_dir/search-movie-playback.json"
jq -e \
  --arg firstId "$movie_source_id" \
  --arg firstName "$movie_release_name" \
  --arg secondId "$movie_alt_source_id" \
  --arg secondName "$movie_alt_release_name" '
  (.MediaSources | length) == 2
    and .MediaSources[0].Id == $firstId
    and .MediaSources[0].Name == $firstName
    and .MediaSources[1].Id == $secondId
    and .MediaSources[1].Name == $secondName
' "$tmp_dir/search-movie-playback.json" >/dev/null

curl -fsS --get "$base_url/Items/$series_id" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  -o "$tmp_dir/series-detail.json"
jq -e --arg id "$series_id" '
  .Id == $id
    and .Type == "Series"
    and .LocationType == "Remote"
' "$tmp_dir/series-detail.json" >/dev/null

tv_series_before="$(core_count tv_series)"
curl -fsS --get "$base_url/Shows/$series_id/Seasons" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode 'fields=PrimaryImageAspectRatio,CanDelete,MediaSourceCount' \
  --data-urlencode 'isMissing=false' \
  --data-urlencode 'enableUserData=true' \
  --data-urlencode 'imageTypeLimit=1' \
  -o "$tmp_dir/series-seasons.json"
[[ "$(core_count tv_series)" -eq $((tv_series_before + 1)) ]] \
  || fail "Opening the series did not load its season catalog exactly once."
jq -e '
  (.Items | length) == 1
    and .Items[0].Type == "Season"
    and .Items[0].IndexNumber == 1
    and .Items[0].LocationType == "Remote"
' "$tmp_dir/series-seasons.json" >/dev/null
season_id="$(jq -er '.Items[0].Id' "$tmp_dir/series-seasons.json")"

tv_season_before="$(core_count tv_season)"
curl -fsS --get "$base_url/Shows/$series_id/Episodes" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode "seasonId=$season_id" \
  --data-urlencode 'fields=PrimaryImageAspectRatio,CanDelete,MediaSourceCount,MediaSources' \
  --data-urlencode 'isMissing=false' \
  --data-urlencode 'enableUserData=true' \
  --data-urlencode 'imageTypeLimit=1' \
  -o "$tmp_dir/season-episodes.json"
[[ "$(core_count tv_season)" -eq $((tv_season_before + 1)) ]] \
  || fail "Opening the season did not load its episode catalog exactly once."
jq -e '
  (.Items | length) == 2
    and all(.Items[]; .Type == "Episode" and .LocationType == "Remote")
' "$tmp_dir/season-episodes.json" >/dev/null
available_episode_id="$(jq -er '.Items[] | select(.IndexNumber == 1) | .Id' "$tmp_dir/season-episodes.json")"
unavailable_episode_id="$(jq -er '.Items[] | select(.IndexNumber == 2) | .Id' "$tmp_dir/season-episodes.json")"
jq -e --arg id "$available_episode_id" '.Items[] | select(.Id == $id)' \
  "$tmp_dir/season-episodes.json" >"$tmp_dir/available-episode-summary.json"
jq -e --arg id "$unavailable_episode_id" '.Items[] | select(.Id == $id)' \
  "$tmp_dir/season-episodes.json" >"$tmp_dir/unavailable-episode-summary.json"
assert_release_sources \
  "$tmp_dir/available-episode-summary.json" 2 \
  "$episode_source_id" "$episode_release_name" \
  "$episode_alt_source_id" "$episode_alt_release_name"
assert_release_sources "$tmp_dir/unavailable-episode-summary.json" 0

for detail_route in current legacy; do
  if [[ "$detail_route" == "current" ]]; then
    available_url="$base_url/Items/$available_episode_id?userId=$allowed_id"
    unavailable_url="$base_url/Items/$unavailable_episode_id?userId=$allowed_id"
  else
    available_url="$base_url/Users/$allowed_id/Items/$available_episode_id"
    unavailable_url="$base_url/Users/$allowed_id/Items/$unavailable_episode_id"
  fi

  curl -fsS "$available_url" -H "$allowed_header" \
    -o "$tmp_dir/available-episode-detail-$detail_route.json"
  curl -fsS "$unavailable_url" -H "$allowed_header" \
    -o "$tmp_dir/unavailable-episode-detail-$detail_route.json"
  jq -e --arg id "$available_episode_id" '
    .Id == $id and .Type == "Episode" and .LocationType == "Remote"
  ' "$tmp_dir/available-episode-detail-$detail_route.json" >/dev/null
  jq -e --arg id "$unavailable_episode_id" '
    .Id == $id and .Type == "Episode" and .LocationType == "Remote"
  ' "$tmp_dir/unavailable-episode-detail-$detail_route.json" >/dev/null
  assert_release_sources \
    "$tmp_dir/available-episode-detail-$detail_route.json" 2 \
    "$episode_source_id" "$episode_release_name" \
    "$episode_alt_source_id" "$episode_alt_release_name"
  assert_release_sources "$tmp_dir/unavailable-episode-detail-$detail_route.json" 0
done

# The same version-as-item lookup must work for episode releases.
curl -fsS "$base_url/Users/$allowed_id/Items/$episode_alt_source_id" \
  -H "$allowed_header" \
  -o "$tmp_dir/episode-release-item.json"
jq -e --arg id "$available_episode_id" '
  .Id == $id and .Type == "Episode" and (.MediaSources | length) == 2
' "$tmp_dir/episode-release-item.json" >/dev/null

# Jellyfin Web's episode-card play path first reloads the queue without a season filter. This
# exact request must return the clicked plugin episode before Web proceeds to PlaybackInfo.
tv_season_before_card_play="$(core_count tv_season)"
curl -fsS --get "$base_url/Shows/$series_id/Episodes" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode 'isMissing=false' \
  --data-urlencode 'limit=100' \
  --data-urlencode "startItemId=$available_episode_id" \
  --data-urlencode 'fields=Chapters,Trickplay' \
  -o "$tmp_dir/episode-card-play-queue.json"
[[ "$(core_count tv_season)" -eq "$tv_season_before_card_play" ]] \
  || fail "Episode-card queue reload fetched an already materialized season again."
jq -e --arg id "$available_episode_id" '
  (.Items | length) >= 1
    and .Items[0].Id == $id
    and .Items[0].Type == "Episode"
    and .Items[0].LocationType == "Remote"
' "$tmp_dir/episode-card-play-queue.json" >/dev/null

curl -fsS "$base_url/Items/$available_episode_id/PlaybackInfo" \
  -H "$allowed_header" \
  -o "$tmp_dir/available-episode-playback.json"
curl -fsS "$base_url/Items/$unavailable_episode_id/PlaybackInfo" \
  -H "$allowed_header" \
  -o "$tmp_dir/unavailable-episode-playback.json"
jq -e \
  --arg firstId "$episode_source_id" \
  --arg firstName "$episode_release_name" \
  --arg secondId "$episode_alt_source_id" \
  --arg secondName "$episode_alt_release_name" '
    (.MediaSources | length) == 2
      and .MediaSources[0].Id == $firstId
      and .MediaSources[0].Name == $firstName
      and .MediaSources[1].Id == $secondId
      and .MediaSources[1].Name == $secondName
  ' "$tmp_dir/available-episode-playback.json" >/dev/null
jq -e '(.MediaSources | length) == 0' "$tmp_dir/unavailable-episode-playback.json" >/dev/null

# Reproduce individual-card play: no MediaSourceId means Jellyfin must open the first ranked
# release instead of filtering against the synthetic item's old placeholder id.
jq -n --arg uid "$allowed_id" '{UserId:$uid, AutoOpenLiveStream:true}' \
  >"$tmp_dir/episode-card-playback-request.json"
code="$(curl -sS -o "$tmp_dir/episode-card-playback-result.json" -w '%{http_code}' \
  -X POST "$base_url/Items/$available_episode_id/PlaybackInfo" \
  -H "$allowed_header" \
  -H 'Content-Type: application/json' \
  --data-binary "@$tmp_dir/episode-card-playback-request.json")"
expect_code 200 "$code" "Episode-card PlaybackInfo"
jq -e '
  .ErrorCode == null
    and (.MediaSources | length) == 1
    and (.MediaSources[0] as $opened
      | ($opened.LiveStreamId | type == "string" and length > 0)
        and ($opened.LiveStreamId | endswith("_" + $opened.Id))
        and $opened.RequiresOpening == false)
' "$tmp_dir/episode-card-playback-result.json" >/dev/null
assert_streamyfin_opened_source \
  "$tmp_dir/episode-card-playback-result.json" \
  "$public_stream_base/api/v1/stream/ci-smoke-session-$episode_release_id"
assert_last_resolve "$episode_release_id" "ci-smoke-series-s01e01"
card_live_stream_id="$(jq -er '.MediaSources[0].LiveStreamId' \
  "$tmp_dir/episode-card-playback-result.json")"
close_live_stream "$card_live_stream_id" "$tmp_dir/episode-card-close-result.json"

# Reproduce Jellyfin Web's release selector: posting the second release id must auto-open that
# exact source, with Core receiving the episode work rather than silently taking rank 1.
jq -n \
  --arg uid "$allowed_id" \
  --arg source "$episode_alt_source_id" \
  '{UserId:$uid, MediaSourceId:$source, AutoOpenLiveStream:true}' \
  >"$tmp_dir/episode-selected-playback-request.json"
code="$(curl -sS -o "$tmp_dir/episode-selected-playback-result.json" -w '%{http_code}' \
  -X POST "$base_url/Items/$available_episode_id/PlaybackInfo" \
  -H "$allowed_header" \
  -H 'Content-Type: application/json' \
  --data-binary "@$tmp_dir/episode-selected-playback-request.json")"
expect_code 200 "$code" "Selected episode-release PlaybackInfo"
jq -e '
  .ErrorCode == null
    and (.MediaSources | length) == 1
    and (.MediaSources[0] as $opened
      | ($opened.LiveStreamId | type == "string" and length > 0)
        and ($opened.LiveStreamId | endswith("_" + $opened.Id))
        and $opened.RequiresOpening == false)
' "$tmp_dir/episode-selected-playback-result.json" >/dev/null
assert_streamyfin_opened_source \
  "$tmp_dir/episode-selected-playback-result.json" \
  "$public_stream_base/api/v1/stream/ci-smoke-session-$episode_alt_release_id"
assert_last_resolve "$episode_alt_release_id" "ci-smoke-series-s01e01"
selected_live_stream_id="$(jq -er '.MediaSources[0].LiveStreamId' \
  "$tmp_dir/episode-selected-playback-result.json")"
close_live_stream "$selected_live_stream_id" "$tmp_dir/episode-selected-close-result.json"

# Exercise Jellyfin's explicit two-step client flow with an offer taken from the projected item
# DTO rather than from PlaybackInfo: detail-route tokens bypass the host's provider-prefixing,
# so this open fails if the DTO projection ever stops emitting host-routable OpenTokens.
curl -fsS "$base_url/Items/$available_episode_id?userId=$allowed_id" \
  -H "$allowed_header" \
  -o "$tmp_dir/episode-explicit-detail.json"
explicit_open_token="$(jq -er --arg id "$episode_alt_source_id" '
  .MediaSources[] | select(.Id == $id) | .OpenToken
' "$tmp_dir/episode-explicit-detail.json")"
jq -n \
  --arg token "$explicit_open_token" \
  --arg uid "$allowed_id" \
  --arg item "$available_episode_id" '
  {OpenToken:$token, UserId:$uid, ItemId:$item, PlaySessionId:"episode-explicit-ci"}
' >"$tmp_dir/episode-explicit-open-request.json"
code="$(curl -sS -o "$tmp_dir/episode-explicit-open-result.json" -w '%{http_code}' \
  -X POST "$base_url/LiveStreams/Open" \
  -H "$allowed_header" \
  -H 'Content-Type: application/json' \
  --data-binary "@$tmp_dir/episode-explicit-open-request.json")"
expect_code 200 "$code" "Explicit selected episode release open"
jq -e '
  (.MediaSource as $opened
    | ($opened.LiveStreamId | type == "string" and length > 0)
      and ($opened.LiveStreamId | endswith("_" + $opened.Id))
      and $opened.RequiresOpening == false)
' "$tmp_dir/episode-explicit-open-result.json" >/dev/null
assert_last_resolve "$episode_alt_release_id" "ci-smoke-series-s01e01"
explicit_live_stream_id="$(jq -er '.MediaSource.LiveStreamId' \
  "$tmp_dir/episode-explicit-open-result.json")"
close_live_stream "$explicit_live_stream_id" "$tmp_dir/episode-explicit-close-result.json"

# Non-virtual season/episode rows are required for Jellyfin's native TV queries, but the private
# implementation hierarchy must still remain absent from ordinary root and Latest traversal.
curl -fsS --get "$base_url/Items" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode 'recursive=true' \
  --data-urlencode 'limit=100' \
  -o "$tmp_dir/root-items-after-hierarchy.json"
curl -fsS --get "$base_url/Items/Latest" \
  -H "$allowed_header" \
  --data-urlencode "userId=$allowed_id" \
  --data-urlencode 'limit=100' \
  -o "$tmp_dir/latest-items-after-hierarchy.json"
for expected_name in "$movie_name" "$series_name" "Season 1" "Available Episode" "Unavailable Episode"; do
  assert_named_item_absent "$tmp_dir/root-items-after-hierarchy.json" Items "$expected_name"
  assert_named_item_absent "$tmp_dir/latest-items-after-hierarchy.json" Items "$expected_name"
done

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
