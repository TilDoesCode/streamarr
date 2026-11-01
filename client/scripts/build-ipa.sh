#!/usr/bin/env bash
# Builds an unsigned Release IPA for sideloading (AltStore/Sideloadly re-sign it on install). Runs locally and on EAS.
set -euo pipefail

cd "$(dirname "$0")/.."
root="$PWD"
derived="$root/ios/build/ipa-dd"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

CI=1 node scripts/prebuild-ios.mjs ios

if [[ -n "${STREAMARR_IOS_BUILD_NUMBER:-}" ]]; then
  [[ "$STREAMARR_IOS_BUILD_NUMBER" =~ ^[0-9]+$ ]] || { echo "Invalid build number: $STREAMARR_IOS_BUILD_NUMBER" >&2; exit 1; }
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $STREAMARR_IOS_BUILD_NUMBER" ios/Streamarr/Info.plist
fi

echo "› xcodebuild (Release, iphoneos, unsigned)"
xcodebuild \
  -workspace ios/Streamarr.xcworkspace \
  -scheme Streamarr \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$derived" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build | { command -v xcbeautify >/dev/null && xcbeautify || cat; }

app="$derived/Build/Products/Release-iphoneos/Streamarr.app"
version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Info.plist")"
build="$(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$app/Info.plist")"
out="${STREAMARR_IPA_OUT:-$root/release/Streamarr-$version-$build-unsigned.ipa}"

mkdir -p "$stage/Payload" "$(dirname "$out")"
cp -R "$app" "$stage/Payload/"
(cd "$stage" && zip -qry app.ipa Payload)
cp "$stage/app.ipa" "$out"

echo "✔ $out ($(du -h "$out" | cut -f1))"
