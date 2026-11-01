#!/usr/bin/env bash
# Publishes an EAS Update on channel production. Android release APKs are TV builds, so their runtime needs EXPO_TV=1.
set -euo pipefail

cd "$(dirname "$0")/.."
message="${1:?usage: publish-ota.sh <message> [ios|android|all]}"
platform="${2:-all}"

publish() {
  eas update --channel production --environment production --message "$message" --non-interactive "$@"
}

if [[ "$platform" == ios || "$platform" == all ]]; then EXPO_TV=0 publish --platform ios; fi
if [[ "$platform" == android || "$platform" == all ]]; then EXPO_TV=1 publish --platform android; fi
