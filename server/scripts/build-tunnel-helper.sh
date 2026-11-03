#!/usr/bin/env bash
# Builds the streamarr-tunnel helper for this machine into server/tunnel/dist/host/. The server and
# test projects copy that file next to their assemblies on every `dotnet build`, so run this once
# after cloning (and after changing server/tunnel/) to get working VPN tunnels in dev and tests.
# Requires Go (see server/tunnel/go.mod for the version).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v go >/dev/null 2>&1; then
  echo "go is not installed; see https://go.dev/dl/ (or: brew install go)" >&2
  exit 1
fi
exec "$SCRIPT_DIR/../tunnel/build.sh" host
