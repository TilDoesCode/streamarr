# Shared settings of the embedded-server build scripts (sourced, not executed).
set -euo pipefail

EMBEDDED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$EMBEDDED_DIR/../.." && pwd)"
# Big downloads, build trees and outputs stay outside the repository.
WORK="${STREAMARR_EMBEDDED_WORK:-/Volumes/DevSSD/Development/streamarr-work/embedded-server}"
SRC="$WORK/src"
BUILD="$WORK/build"
PREFIX="$WORK/sysroot"
DIST="$EMBEDDED_DIR/dist"

ANDROID_API=29
ANDROID_ABI=arm64-v8a
TRIPLE=aarch64-linux-android
ANDROID_SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
NDK_VERSION="${STREAMARR_NDK_VERSION:-27.1.12297006}"
NDK="${ANDROID_NDK_ROOT:-$ANDROID_SDK/ndk/$NDK_VERSION}"
HOST_TAG=linux-x86_64
[ "$(uname -s)" = Darwin ] && HOST_TAG=darwin-x86_64
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc)}"

# Pinned sources (version, URL, sha256).
OPENSSL_VERSION=3.5.9
OPENSSL_URL="https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz"
OPENSSL_SHA256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a
FFMPEG_VERSION=9.0.2
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
X264_URL="https://code.videolan.org/videolan/x264/-/archive/$X264_COMMIT/x264-$X264_COMMIT.tar.bz2"
X264_SHA256=6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224
X265_VERSION=4.1
X265_URL="https://bitbucket.org/multicoreware/x265_git/downloads/x265_$X265_VERSION.tar.gz"
X265_SHA256=a31699c6a89806b74b0151e5e6a7df65de4b49050482fe5ebf8a4379d7af8f29
ZIMG_VERSION=3.0.6
ZIMG_COMMIT=f819b14e8f39d1282400b0d9543e8ef73c1b2bbd
ZIMG_REPO=https://github.com/sekrit-twc/zimg.git

export PATH="$TOOLCHAIN/bin:$PATH"
export CC="$TOOLCHAIN/bin/${TRIPLE}${ANDROID_API}-clang"
export CXX="$TOOLCHAIN/bin/${TRIPLE}${ANDROID_API}-clang++"
export AR="$TOOLCHAIN/bin/llvm-ar"
export RANLIB="$TOOLCHAIN/bin/llvm-ranlib"
export STRIP="$TOOLCHAIN/bin/llvm-strip"
export NM="$TOOLCHAIN/bin/llvm-nm"
# 16 KB pages (Android 15+ devices) and a fixed sysroot for every component.
export LDFLAGS="-Wl,-z,max-page-size=16384 -L$PREFIX/lib"
export CFLAGS="-O2 -fPIC -I$PREFIX/include"
export CXXFLAGS="$CFLAGS"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"

log() { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }

require_ndk() {
  [ -x "$CC" ] || { echo "NDK $NDK_VERSION not found at $NDK (set ANDROID_NDK_ROOT or STREAMARR_NDK_VERSION)" >&2; exit 1; }
  mkdir -p "$SRC" "$BUILD" "$PREFIX"
}

# fetch <url> <sha256> <file>: downloads once and verifies the checksum every time.
fetch() {
  local url="$1" sha="$2" file="$SRC/$3"
  [ -f "$file" ] || { log "download $url"; curl -fsSL --retry 3 -o "$file.part" "$url" && mv "$file.part" "$file"; }
  local actual; actual="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  [ "$actual" = "$sha" ] || { echo "checksum mismatch for $file: $actual != $sha" >&2; exit 1; }
}

# extract <archive> <dir>: fresh extraction into $BUILD/<dir> (strips the top-level folder).
extract() {
  local archive="$SRC/$1" dir="$BUILD/$2"
  rm -rf "$dir" && mkdir -p "$dir"
  tar xf "$archive" -C "$dir" --strip-components=1
}
