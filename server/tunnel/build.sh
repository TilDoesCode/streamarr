#!/usr/bin/env bash
# Cross-builds the streamarr-tunnel helper (pure Go, CGO_ENABLED=0, stripped, reproducible).
#   ./build.sh                     -> host build into dist/host/
#   ./build.sh linux-amd64 ...     -> one or more targets into dist/<target>/
#   ./build.sh all                 -> every target below
# Targets: host, linux-amd64, linux-arm64, android-arm64 (output libstreamarr-tunnel.so for the
# Android app bundle), darwin-arm64, darwin-amd64, windows-amd64.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

VERSION="${STREAMARR_TUNNEL_VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
LDFLAGS="-s -w -buildid= -X main.version=${VERSION}"
ALL=(linux-amd64 linux-arm64 android-arm64 darwin-arm64 darwin-amd64 windows-amd64)

build() {
  local target="$1" goos goarch out name=streamarr-tunnel
  case "$target" in
    host) goos="$(go env GOOS)"; goarch="$(go env GOARCH)" ;;
    *) goos="${target%-*}"; goarch="${target#*-}" ;;
  esac
  [[ "$goos" == windows ]] && name=streamarr-tunnel.exe
  [[ "$goos" == android ]] && name=libstreamarr-tunnel.so
  out="dist/${target}/${name}"
  mkdir -p "$(dirname "$out")"
  echo "building $target -> $out"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" GOFLAGS=-mod=mod \
    go build -trimpath -ldflags "$LDFLAGS" -o "$out" .
}

if [[ $# -eq 0 ]]; then
  build host
elif [[ "$1" == all ]]; then
  for t in "${ALL[@]}"; do build "$t"; done
else
  for t in "$@"; do build "$t"; done
fi
