#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <MAJOR.MINOR.PATCH> [output-directory]" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
version="${1#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
output_dir="${2:-$repo_root/artifacts/release}"
plugin_meta="$repo_root/plugin/Streamarr.Plugin/meta.json"
source_plugin_version="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)\.0",?[[:space:]]*$/\1/p' "$plugin_meta")"

[[ "$source_plugin_version" == "$version" ]] || {
  echo "Release $version does not match plugin/meta.json version ${source_plugin_version:-unknown}." >&2
  echo "Update the plugin project and manifest versions before releasing." >&2
  exit 1
}

for command in dotnet zip tar; do
  command -v "$command" >/dev/null || {
    echo "$command is required." >&2
    exit 1
  }
done

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/streamarr-release.XXXXXX")"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

rm -rf "$output_dir"
mkdir -p "$output_dir" "$tmp_dir/publish" "$tmp_dir/plugin" "$tmp_dir/home/plugin"
output_dir="$(cd -- "$output_dir" && pwd)"

dotnet publish "$repo_root/plugin/Streamarr.Plugin/Streamarr.Plugin.csproj" \
  --configuration Release \
  --output "$tmp_dir/publish" \
  -p:ContinuousIntegrationBuild=true \
  -p:Version="$version.0"

for file in Streamarr.Plugin.dll Streamarr.Plugin.deps.json Streamarr.Plugin.pdb meta.json; do
  [[ -f "$tmp_dir/publish/$file" ]] && cp "$tmp_dir/publish/$file" "$tmp_dir/plugin/$file"
done
[[ -f "$tmp_dir/plugin/Streamarr.Plugin.dll" && -f "$tmp_dir/plugin/meta.json" ]] || {
  echo "Plugin publish did not produce the required DLL and manifest." >&2
  exit 1
}

(
  cd "$tmp_dir/plugin"
  zip -q -9 "$output_dir/streamarr-jellyfin-$version.zip" ./*
)

cp "$repo_root/deploy/compose.yml" "$tmp_dir/home/compose.yml"
cp "$repo_root/deploy/compose.proxy.yml" "$tmp_dir/home/compose.proxy.yml"
cp "$repo_root/deploy/.env.example" "$tmp_dir/home/.env.example"
cp "$repo_root/deploy/README.md" "$tmp_dir/home/README.md"
cp -R "$tmp_dir/plugin/." "$tmp_dir/home/plugin/"
sed -i.bak \
  "s|^STREAMARR_IMAGE=.*$|STREAMARR_IMAGE=ghcr.io/tildoescode/streamarr:$version|" \
  "$tmp_dir/home/.env.example"
rm -f "$tmp_dir/home/.env.example.bak"

tar -C "$tmp_dir/home" -czf "$output_dir/streamarr-home-$version.tar.gz" .

(
  cd "$output_dir"
  if command -v sha256sum >/dev/null; then
    sha256sum streamarr-jellyfin-"$version".zip streamarr-home-"$version".tar.gz > SHA256SUMS
  else
    shasum -a 256 streamarr-jellyfin-"$version".zip streamarr-home-"$version".tar.gz > SHA256SUMS
  fi
)

echo "Created release artifacts in $output_dir"
