#!/usr/bin/env bash
# Builds the complete embedded-server bundle for the Android TV app into dist/<version>/ (git-ignored):
#   management UI (web/) + viewer web app (client/) + Core Server published for linux-bionic-arm64 → assets/server.zip
#   native host + ffmpeg/ffprobe + WireGuard tunnel helper (server/tunnel, Go)                  → jniLibs/arm64-v8a
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_ndk
START=$(date +%s)
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
SERVER_PROJECT="$REPO_ROOT/server/src/Streamarr.Server/Streamarr.Server.csproj"
VERSION="${STREAMARR_VERSION:-$(grep -o '"version": *"[0-9]*\.[0-9]*\.[0-9]*' "$REPO_ROOT/plugin/Streamarr.Plugin/meta.json" | grep -o '[0-9.]*$')}"
[ -n "$VERSION" ] || { echo "cannot determine the server version (set STREAMARR_VERSION)" >&2; exit 1; }
OUT="$DIST/$VERSION"
PUBLISH="$BUILD/publish"
STAGE="$BUILD/stage"
# Tunnel helper: unset = built here from server/tunnel with Go; a path = use that prebuilt libstreamarr-tunnel.so; "none" = no helper.
TUNNEL_HELPER="${STREAMARR_TUNNEL_HELPER:-}"

csproj_version() { grep -o "Include=\"$1\" Version=\"[^\"]*\"" "$SERVER_PROJECT" | grep -o 'Version="[^"]*"' | cut -d'"' -f2; }

# nupkg_native <package id> <version> <path inside the package> <target>: fetches a nuget package once and extracts one file.
nupkg_native() {
  local id="$1" version="$2" inner="$3" target="$4" lower file
  lower="$(echo "$id" | tr '[:upper:]' '[:lower:]')"
  file="$SRC/nupkg/$lower.$version.nupkg"
  mkdir -p "$SRC/nupkg"
  [ -f "$file" ] || { log "download $id $version"; curl -fsSL --retry 3 -o "$file" "https://api.nuget.org/v3-flatcontainer/$lower/$version/$lower.$version.nupkg"; }
  unzip -p "$file" "$inner" > "$target"
  [ -s "$target" ] || { echo "$inner missing in $id $version" >&2; exit 1; }
}

build_tunnel_helper() {
  case "$TUNNEL_HELPER" in
    none) TUNNEL_HELPER=""; log "tunnel helper left out (STREAMARR_TUNNEL_HELPER=none)"; return ;;
    ?*) [ -f "$TUNNEL_HELPER" ] || { echo "STREAMARR_TUNNEL_HELPER points to a missing file: $TUNNEL_HELPER" >&2; exit 1; }; return ;;
  esac
  command -v go >/dev/null 2>&1 \
    || { echo "go is required to build the tunnel helper (see server/tunnel/go.mod); install it or set STREAMARR_TUNNEL_HELPER=<libstreamarr-tunnel.so>|none" >&2; exit 1; }
  log "build tunnel helper for android-arm64 ($(go version | cut -d' ' -f3))"
  STREAMARR_TUNNEL_VERSION="$VERSION" "$REPO_ROOT/server/tunnel/build.sh" android-arm64 > "$BUILD/tunnel.log" 2>&1 || { tail -20 "$BUILD/tunnel.log"; exit 1; }
  TUNNEL_HELPER="$REPO_ROOT/server/tunnel/dist/android-arm64/libstreamarr-tunnel.so"
}

log "embedded server bundle $VERSION (ffmpeg $FFMPEG_VERSION, openssl $OPENSSL_VERSION)"
"$EMBEDDED_DIR/build-openssl.sh"
"$EMBEDDED_DIR/build-ffmpeg.sh"
build_tunnel_helper

# ---- web assets, exactly like server/Dockerfile ---------------------------------------
if [ "${SKIP_WEB:-0}" != 1 ]; then
  log "build management UI"
  (cd "$REPO_ROOT/web" && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run build) > "$BUILD/web.log" 2>&1
  rm -rf "$REPO_ROOT/server/src/Streamarr.Server/wwwroot"
  cp -R "$REPO_ROOT/web/dist" "$REPO_ROOT/server/src/Streamarr.Server/wwwroot"
  log "export viewer web app"
  rm -rf "$BUILD/viewer-web"
  (cd "$REPO_ROOT/client" && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && EXPO_BASE_URL=/watch npx expo export --platform web --output-dir "$BUILD/viewer-web") > "$BUILD/viewer-web.log" 2>&1
fi
[ -f "$REPO_ROOT/server/src/Streamarr.Server/wwwroot/index.html" ] || { echo "wwwroot is missing (run without SKIP_WEB)" >&2; exit 1; }
[ -f "$BUILD/viewer-web/index.html" ] || { echo "viewer web export is missing (run without SKIP_WEB)" >&2; exit 1; }

# ---- server -----------------------------------------------------------------------------
log "publish Streamarr.Server for linux-bionic-arm64"
rm -rf "$PUBLISH"
dotnet publish "$SERVER_PROJECT" -c Release -r linux-bionic-arm64 -p:Version="$VERSION" -o "$PUBLISH" > "$BUILD/publish.log" 2>&1 \
  || { tail -20 "$BUILD/publish.log"; exit 1; }
RUNTIME_VERSION="$(grep -o '"version": *"[0-9.]*"' "$PUBLISH/Streamarr.Server.runtimeconfig.json" | head -1 | grep -o '[0-9.]*')"
HOST_PACK="$NUGET_DIR/microsoft.netcore.app.host.linux-bionic-arm64/$RUNTIME_VERSION/runtimes/linux-bionic-arm64/native"
[ -f "$HOST_PACK/hostfxr.h" ] || { echo "hostfxr.h not found in $HOST_PACK" >&2; exit 1; }

# The RID graph resolved glibc natives for SQLite and Skia; swap in the packages' android-arm64 builds of the same versions.
SQLITE_VERSION="$(csproj_version SQLitePCLRaw.lib.e_sqlite3)"
SKIA_VERSION="$(csproj_version SkiaSharp)"
cp "$NUGET_DIR/sqlitepclraw.lib.e_sqlite3/$SQLITE_VERSION/runtimes/android-arm64/native/libe_sqlite3.so" "$PUBLISH/libe_sqlite3.so"
nupkg_native SkiaSharp.NativeAssets.Android "$SKIA_VERSION" runtimes/android-arm64/native/libSkiaSharp.so "$PUBLISH/libSkiaSharp.so"
rm -f "$PUBLISH/libe_sqlite3.a"
cp "$PREFIX/lib/libssl.so" "$PREFIX/lib/libcrypto.so" "$PUBLISH/"
rm -f "$PUBLISH/Streamarr.Server" "$PUBLISH/appsettings.Development.json" "$PUBLISH"/*.pdb
rm -rf "$PUBLISH/viewer-web" && cp -R "$BUILD/viewer-web" "$PUBLISH/viewer-web"

log "compile native host"
mkdir -p "$BUILD/host"
"$CC" -O2 -fPIE -pie -Wall -Wno-visibility -Wl,-z,max-page-size=16384 -I"$HOST_PACK" \
  -o "$BUILD/host/libstreamarr-host.so" "$EMBEDDED_DIR/host/streamarr-host.c" -ldl
"$STRIP" "$BUILD/host/libstreamarr-host.so"

# ---- bundle -----------------------------------------------------------------------------
log "assemble dist/$VERSION"
rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE/assets" "$STAGE/jniLibs/$ANDROID_ABI"
# Stored, not deflated: the APK compresses assets itself and the app streams the archive out once per bundle version.
(cd "$PUBLISH" && zip -0 -r -X -q "$STAGE/assets/server.zip" .)
cp "$BUILD/host/libstreamarr-host.so" "$STAGE/jniLibs/$ANDROID_ABI/"
cp "$PREFIX/ffmpeg/bin/ffmpeg" "$STAGE/jniLibs/$ANDROID_ABI/libffmpeg.so"
cp "$PREFIX/ffmpeg/bin/ffprobe" "$STAGE/jniLibs/$ANDROID_ABI/libffprobe.so"
cp "$PREFIX"/ffmpeg/lib/*.so "$STAGE/jniLibs/$ANDROID_ABI/"
[ -z "$TUNNEL_HELPER" ] || cp "$TUNNEL_HELPER" "$STAGE/jniLibs/$ANDROID_ABI/libstreamarr-tunnel.so"

ZIP_SHA="$(sha256 "$STAGE/assets/server.zip")"
BUNDLE_VERSION="$VERSION+${ZIP_SHA:0:8}"
{
  echo "{"
  echo "  \"serverVersion\": \"$VERSION\","
  echo "  \"bundleVersion\": \"$BUNDLE_VERSION\","
  echo "  \"runtimeVersion\": \"$RUNTIME_VERSION\","
  echo "  \"ffmpegVersion\": \"$FFMPEG_VERSION\","
  echo "  \"opensslVersion\": \"$OPENSSL_VERSION\","
  echo "  \"x264Commit\": \"$X264_COMMIT\","
  echo "  \"x265Version\": \"$X265_VERSION\","
  echo "  \"zimgVersion\": \"$ZIMG_VERSION\","
  echo "  \"tunnelHelper\": $([ -n "$TUNNEL_HELPER" ] && echo true || echo false),"
  echo "  \"builtAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"files\": {"
  first=1
  while IFS= read -r file; do
    rel="${file#"$STAGE/"}"
    [ $first = 1 ] || echo ","
    first=0
    printf '    "%s": { "size": %s, "sha256": "%s" }' "$rel" "$(file_size "$file")" "$(sha256 "$file")"
  done < <(find "$STAGE" -type f | sort)
  echo
  echo "  }"
  echo "}"
} > "$STAGE/manifest.json"
cp "$STAGE/manifest.json" "$STAGE/assets/manifest.json"
mkdir -p "$DIST" && mv "$STAGE" "$OUT"
ln -sfn "$VERSION" "$DIST/current"
log "done in $(( ($(date +%s) - START) / 60 )) min: $OUT ($BUNDLE_VERSION)"
du -sh "$OUT/assets/server.zip" "$OUT/jniLibs/$ANDROID_ABI" | sed 's/^/  /'
