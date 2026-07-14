#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 ]] || {
  echo "Usage: $0 <MAJOR.MINOR.PATCH> <artifact-directory>" >&2
  exit 2
}

version="${1#v}"
artifact_dir="$(cd -- "$2" && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/streamarr-verify.XXXXXX")"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

(
  cd "$artifact_dir"
  if command -v sha256sum >/dev/null; then
    sha256sum --check SHA256SUMS
  else
    shasum -a 256 --check SHA256SUMS
  fi
)

unzip -q "$artifact_dir/streamarr-jellyfin-$version.zip" -d "$tmp_dir/plugin"
for file in Streamarr.Plugin.dll meta.json; do
  test -s "$tmp_dir/plugin/$file"
done

mkdir "$tmp_dir/home"
tar -xzf "$artifact_dir/streamarr-home-$version.tar.gz" -C "$tmp_dir/home"
for file in compose.yml compose.proxy.yml .env.example README.md plugin/Streamarr.Plugin.dll plugin/meta.json; do
  test -s "$tmp_dir/home/$file"
done
grep -Fq "STREAMARR_IMAGE=ghcr.io/tildoescode/streamarr:$version" "$tmp_dir/home/.env.example"

STREAMARR_API_KEY=verify-only-machine-key-0123456789abcdef \
STREAMARR_ADMIN_PASSWORD=verify-only-admin-password \
  docker compose --env-file "$tmp_dir/home/.env.example" \
    -f "$tmp_dir/home/compose.yml" config --quiet

STREAMARR_API_KEY=verify-only-machine-key-0123456789abcdef \
STREAMARR_ADMIN_PASSWORD=verify-only-admin-password \
  docker compose --env-file "$tmp_dir/home/.env.example" \
    -f "$tmp_dir/home/compose.yml" --profile jellyfin config --quiet

STREAMARR_API_KEY=verify-only-machine-key-0123456789abcdef \
STREAMARR_ADMIN_PASSWORD=verify-only-admin-password \
STREAMARR_TRUSTED_PROXY=172.18.0.2 \
STREAMARR_TRUSTED_ORIGIN=https://streamarr.home.example \
  docker compose --env-file "$tmp_dir/home/.env.example" \
    -f "$tmp_dir/home/compose.yml" -f "$tmp_dir/home/compose.proxy.yml" config --quiet

echo "Verified release artifacts for $version"
