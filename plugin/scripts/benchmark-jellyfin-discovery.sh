#!/usr/bin/env bash
set -euo pipefail

image="jellyfin/jellyfin:10.11.11@sha256:aefb67e6a7ff1debdd154a78a7bbb780fd0c873d8639210a7f6a2016ad2b35db"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
core_url="${STREAMARR_BENCHMARK_CORE_URL:-http://host.docker.internal:8080}"
core_api_key="${STREAMARR_BENCHMARK_API_KEY:-}"
query="${STREAMARR_BENCHMARK_QUERY:-Greys Anatomy}"
season_number="${STREAMARR_BENCHMARK_SEASON:-21}"
artifact_root="${STREAMARR_BENCHMARK_ARTIFACT_ROOT:-$repo_root/artifacts}"
keep_artifacts="${STREAMARR_BENCHMARK_KEEP_ARTIFACTS:-1}"
name="streamarr-jellyfin-benchmark-${RANDOM}"
uid="$(id -u)"
gid="$(id -g)"
tmp_dir="$(mktemp -d "$artifact_root/jellyfin-discovery.XXXXXX")"
plugin_install="$tmp_dir/plugin"
config_dir="$tmp_dir/config"
data_dir="$tmp_dir/data"
plugin_config_dir="$tmp_dir/plugin-configurations"
admin_password="streamarr-benchmark-admin"
user_password="streamarr-benchmark-user"

mkdir -p "$plugin_install" "$config_dir" "$data_dir" "$plugin_config_dir"
chmod 0700 "$plugin_install" "$config_dir" "$data_dir" "$plugin_config_dir"

cleanup() {
  status=$?
  docker logs "$name" >"$tmp_dir/jellyfin.log" 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -f \
    "$tmp_dir/plugin-config.json" \
    "$tmp_dir/plugin-config-write.json" \
    "$tmp_dir/user.json" \
    "$tmp_dir/user-policy.json"
  rm -rf \
    "$tmp_dir/config" \
    "$tmp_dir/data" \
    "$tmp_dir/plugin" \
    "$tmp_dir/plugin-configurations"
  if [[ "$status" -eq 0 && "$keep_artifacts" != "1" ]]; then
    rm -rf "$tmp_dir"
  else
    echo "artifacts=$tmp_dir"
  fi
}
trap cleanup EXIT

fail() {
  echo "$1" >&2
  exit 1
}

[[ -n "$core_api_key" ]] || fail "STREAMARR_BENCHMARK_API_KEY is required."
mkdir -p "$artifact_root"
dotnet build "$repo_root/plugin/Streamarr.Plugin/Streamarr.Plugin.csproj" -c Release >/dev/null
cp -R "$repo_root/plugin/Streamarr.Plugin/bin/Release/net9.0/." "$plugin_install/"

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
  --volume "$config_dir:/config/config" \
  --volume "$data_dir:/config/data" \
  --volume "$plugin_config_dir:/config/plugins/configurations" \
  --volume "$plugin_install:/config/plugins/Streamarr" \
  "$image" >/dev/null

jellyfin_port="$(docker port "$name" 8096/tcp | head -n 1 | awk -F: '{print $NF}')"
base_url="http://127.0.0.1:$jellyfin_port"
for _ in $(seq 1 90); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name")"
  if [[ "$health" == "healthy" ]] && curl -fsS "$base_url/System/Info/Public" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "$base_url/System/Info/Public" >/dev/null

curl -fsS "$base_url/Startup/User" >/dev/null
for setup in \
  'Configuration|{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}' \
  "User|{\"Name\":\"streamarr-benchmark-admin\",\"Password\":\"$admin_password\"}" \
  'RemoteAccess|{"EnableRemoteAccess":false,"EnableAutomaticPortMapping":false}' \
  'Complete|{}'; do
  endpoint="${setup%%|*}"
  body="${setup#*|}"
  curl -fsS -X POST "$base_url/Startup/$endpoint" -H 'Content-Type: application/json' --data "$body" >/dev/null
done

admin_auth='MediaBrowser Client="StreamarrBenchmark", Device="CLI", DeviceId="streamarr-benchmark-admin", Version="1.0"'
admin_token="$(curl -fsS -X POST "$base_url/Users/AuthenticateByName" \
  -H 'Content-Type: application/json' \
  -H "Authorization: $admin_auth" \
  --data "{\"Username\":\"streamarr-benchmark-admin\",\"Pw\":\"$admin_password\"}" | jq -er '.AccessToken')"
admin_header="Authorization: $admin_auth, Token=\"$admin_token\""
plugin_id="6f8d5c7a-9b2e-4a1f-8c3d-2e5a7b9c0d11"

curl -fsS "$base_url/Plugins/$plugin_id/Configuration" -H "$admin_header" -o "$tmp_dir/plugin-config.json"
jq --arg server "$core_url" --arg key "$core_api_key" '
  .ServerUrl = $server
  | .ApiKey = $key
  | .InterceptionEnabled = true
  | .LibraryEnabled = true
' "$tmp_dir/plugin-config.json" >"$tmp_dir/plugin-config-write.json"
curl -fsS -X POST "$base_url/Plugins/$plugin_id/Configuration" \
  -H "$admin_header" -H 'Content-Type: application/json' \
  --data-binary "@$tmp_dir/plugin-config-write.json" >/dev/null

docker exec "$name" mkdir -p /media/tv
curl -fsS -X POST "$base_url/Library/VirtualFolders?name=BenchmarkTV&collectionType=tvshows&paths=%2Fmedia%2Ftv&refreshLibrary=false" \
  -H "$admin_header" -H 'Content-Type: application/json' --data '{}' >/dev/null
tv_library_id="$(curl -fsS "$base_url/Library/VirtualFolders" -H "$admin_header" | jq -er '.[] | select(.Name == "BenchmarkTV") | .ItemId')"

curl -fsS -X POST "$base_url/Users/New" -H "$admin_header" -H 'Content-Type: application/json' \
  --data "{\"Name\":\"streamarr-benchmark-user\",\"Password\":\"$user_password\"}" \
  -o "$tmp_dir/user.json"
user_id="$(jq -er '.Id' "$tmp_dir/user.json")"
jq --arg folder "$tv_library_id" '.Policy | .EnableAllFolders=false | .EnabledFolders=[$folder] | .BlockedMediaFolders=[]' \
  "$tmp_dir/user.json" >"$tmp_dir/user-policy.json"
curl -fsS -X POST "$base_url/Users/$user_id/Policy" -H "$admin_header" -H 'Content-Type: application/json' \
  --data-binary "@$tmp_dir/user-policy.json" >/dev/null

user_auth='MediaBrowser Client="StreamarrBenchmark", Device="CLI", DeviceId="streamarr-benchmark-user", Version="1.0"'
user_token="$(curl -fsS -X POST "$base_url/Users/AuthenticateByName" \
  -H 'Content-Type: application/json' -H "Authorization: $user_auth" \
  --data "{\"Username\":\"streamarr-benchmark-user\",\"Pw\":\"$user_password\"}" | jq -er '.AccessToken')"
user_header="Authorization: $user_auth, Token=\"$user_token\""

timed_get() {
  label="$1"
  output="$2"
  shift 2
  seconds="$(curl -fsS -o "$output" -w '%{time_total}' --get "$@")"
  jq -n --arg label "$label" --argjson seconds "$seconds" '{label:$label,milliseconds:($seconds*1000)}'
}

timed_get search "$tmp_dir/search.json" "$base_url/Items" \
  -H "$user_header" \
  --data-urlencode "userId=$user_id" \
  --data-urlencode 'recursive=true' \
  --data-urlencode "searchTerm=$query" \
  --data-urlencode 'includeItemTypes=Series' \
  --data-urlencode 'limit=20' >"$tmp_dir/timing-search.json"
series_id="$(jq -er --arg query "$query" '[.Items[] | select(.Type == "Series")][0].Id' "$tmp_dir/search.json")"

timed_get seasons_cold "$tmp_dir/seasons-cold.json" "$base_url/Shows/$series_id/Seasons" \
  -H "$user_header" --data-urlencode "userId=$user_id" >"$tmp_dir/timing-seasons-cold.json"
season_id="$(jq -er --argjson number "$season_number" '.Items[] | select(.IndexNumber == $number) | .Id' "$tmp_dir/seasons-cold.json")"
for run in 1 2 3 4 5; do
  timed_get "seasons_warm_$run" "$tmp_dir/seasons-warm-$run.json" "$base_url/Shows/$series_id/Seasons" \
    -H "$user_header" --data-urlencode "userId=$user_id" >"$tmp_dir/timing-seasons-warm-$run.json"
done

timed_get episodes_recursive_unloaded "$tmp_dir/episodes-recursive-unloaded.json" \
  "$base_url/Shows/$series_id/Episodes" \
  -H "$user_header" \
  --data-urlencode "userId=$user_id" \
  --data-urlencode 'recursive=true' \
  --data-urlencode 'isMissing=false' >"$tmp_dir/timing-episodes-recursive-unloaded.json"
[[ "$(jq -er '.Items | length' "$tmp_dir/episodes-recursive-unloaded.json")" == "0" ]] \
  || fail "The unloaded recursive episode request unexpectedly expanded seasons."

timed_get episodes_cold "$tmp_dir/episodes-cold.json" "$base_url/Shows/$series_id/Episodes" \
  -H "$user_header" \
  --data-urlencode "userId=$user_id" \
  --data-urlencode "seasonId=$season_id" >"$tmp_dir/timing-episodes-cold.json"
for run in 1 2 3 4 5; do
  timed_get "episodes_warm_$run" "$tmp_dir/episodes-warm-$run.json" "$base_url/Shows/$series_id/Episodes" \
    -H "$user_header" \
    --data-urlencode "userId=$user_id" \
    --data-urlencode "seasonId=$season_id" >"$tmp_dir/timing-episodes-warm-$run.json"
done

jq -s --arg query "$query" --argjson season "$season_number" \
  --argjson seasons "$(jq '.Items | length' "$tmp_dir/seasons-cold.json")" \
  --argjson recursive "$(jq '.Items | length' "$tmp_dir/episodes-recursive-unloaded.json")" \
  --argjson episodes "$(jq '.Items | length' "$tmp_dir/episodes-cold.json")" '
  {
    query:$query,
    season:$season,
    seasonsReturned:$seasons,
    episodesReturned:$episodes,
    recursiveUnloadedEpisodes:$recursive,
    timings:.,
    seasonsWarmMedianMs:([.[] | select(.label|startswith("seasons_warm_")) | .milliseconds] | sort | .[2]),
    episodesWarmMedianMs:([.[] | select(.label|startswith("episodes_warm_")) | .milliseconds] | sort | .[2])
  }
' "$tmp_dir"/timing-*.json | tee "$tmp_dir/result.json"
