#!/usr/bin/env bash
# Cross-compiles ffmpeg/ffprobe for Android arm64 with the NDK: MediaCodec (NDK API, no JavaVM needed), x264/x265 software
# fallbacks and zimg (zscale CPU tone mapping). Shared libav* libraries with unversioned sonames, as the APK needs them.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_ndk
OUT="$PREFIX/ffmpeg"
STAMP="$PREFIX/.ffmpeg-$FFMPEG_VERSION-x264-${X264_COMMIT:0:8}-x265-$X265_VERSION-zimg-$ZIMG_VERSION"
if [ -f "$STAMP" ] && [ "${FORCE:-0}" != 1 ]; then log "ffmpeg $FFMPEG_VERSION already built"; exit 0; fi
START=$(date +%s)

build_x264() {
  [ -f "$PREFIX/.x264-$X264_COMMIT" ] && return
  fetch "$X264_URL" "$X264_SHA256" "x264-$X264_COMMIT.tar.bz2"
  extract "x264-$X264_COMMIT.tar.bz2" x264
  cd "$BUILD/x264"
  log "configure x264"
  ./configure --prefix="$PREFIX" --host=$TRIPLE --cross-prefix="$TOOLCHAIN/bin/llvm-" --sysroot="$TOOLCHAIN/sysroot" \
    --enable-static --enable-pic --disable-cli --disable-opencl --disable-avs --disable-swscale --disable-lavf \
    --disable-ffms --disable-gpac --disable-lsmash > "$BUILD/x264-configure.log" 2>&1
  log "build x264"
  make -j"$JOBS" > "$BUILD/x264-build.log" 2>&1 && make install >> "$BUILD/x264-build.log" 2>&1
  touch "$PREFIX/.x264-$X264_COMMIT"
}

# 8-bit and 10-bit x265 in one static library (the capability probe generates HEVC 10-bit HDR test clips).
build_x265() {
  [ -f "$PREFIX/.x265-$X265_VERSION" ] && return
  fetch "$X265_URL" "$X265_SHA256" "x265_$X265_VERSION.tar.gz"
  extract "x265_$X265_VERSION.tar.gz" x265
  # CMake 4 no longer accepts the OLD behaviour x265 4.1 requests for CMP0025/CMP0054.
  sed -i.bak -E 's/cmake_policy\(SET (CMP0025|CMP0054) OLD\)/cmake_policy(SET \1 NEW)/' "$BUILD/x265/source/CMakeLists.txt"
  local common=(-DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" -DANDROID_ABI=$ANDROID_ABI
    -DANDROID_PLATFORM=android-$ANDROID_API -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED=OFF -DENABLE_CLI=OFF
    -DENABLE_SVE=OFF -DENABLE_SVE2=OFF -DENABLE_SVE2_BITPERM=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON
    -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_POLICY_VERSION_MINIMUM=3.5)
  log "build x265 10-bit"
  cmake -S "$BUILD/x265/source" -B "$BUILD/x265/build10" "${common[@]}" -DHIGH_BIT_DEPTH=ON -DEXPORT_C_API=OFF \
    > "$BUILD/x265-configure10.log" 2>&1
  cmake --build "$BUILD/x265/build10" -j "$JOBS" > "$BUILD/x265-build10.log" 2>&1
  log "build x265 8-bit (+10-bit linked)"
  cmake -S "$BUILD/x265/source" -B "$BUILD/x265/build8" "${common[@]}" -DHIGH_BIT_DEPTH=OFF -DLINKED_10BIT=ON \
    -DEXTRA_LIB="$BUILD/x265/build10/libx265.a" -DEXTRA_LINK_FLAGS="-L$BUILD/x265/build10" > "$BUILD/x265-configure8.log" 2>&1
  cmake --build "$BUILD/x265/build8" -j "$JOBS" > "$BUILD/x265-build8.log" 2>&1
  cmake --install "$BUILD/x265/build8" > "$BUILD/x265-install.log" 2>&1
  "$AR" -M > "$BUILD/x265-merge.log" 2>&1 <<MRI
CREATE $PREFIX/lib/libx265.a
ADDLIB $BUILD/x265/build8/libx265.a
ADDLIB $BUILD/x265/build10/libx265.a
SAVE
END
MRI
  "$RANLIB" "$PREFIX/lib/libx265.a"
  touch "$PREFIX/.x265-$X265_VERSION"
}

build_zimg() {
  [ -f "$PREFIX/.zimg-$ZIMG_VERSION" ] && return
  local dir="$SRC/zimg-$ZIMG_VERSION"
  [ -d "$dir/.git" ] || { log "clone zimg"; git clone -q --recursive --branch "release-$ZIMG_VERSION" "$ZIMG_REPO" "$dir"; }
  [ "$(git -C "$dir" rev-parse HEAD)" = "$ZIMG_COMMIT" ] || { echo "zimg checkout is not $ZIMG_COMMIT" >&2; exit 1; }
  rm -rf "$BUILD/zimg" && cp -R "$dir" "$BUILD/zimg" && cd "$BUILD/zimg"
  log "build zimg"
  ./autogen.sh > "$BUILD/zimg-autogen.log" 2>&1
  ./configure --prefix="$PREFIX" --host=$TRIPLE --enable-static --disable-shared --with-pic > "$BUILD/zimg-configure.log" 2>&1
  make -j"$JOBS" > "$BUILD/zimg-build.log" 2>&1 && make install >> "$BUILD/zimg-build.log" 2>&1
  touch "$PREFIX/.zimg-$ZIMG_VERSION"
}

build_ffmpeg() {
  fetch "$FFMPEG_URL" "$FFMPEG_SHA256" "ffmpeg-$FFMPEG_VERSION.tar.xz"
  extract "ffmpeg-$FFMPEG_VERSION.tar.xz" ffmpeg
  cd "$BUILD/ffmpeg"
  log "configure ffmpeg"
  ./configure --prefix="$OUT" --target-os=android --arch=aarch64 --cpu=armv8-a --enable-cross-compile \
    --cc="$CC" --cxx="$CXX" --ar="$AR" --ranlib="$RANLIB" --strip="$STRIP" --nm="$NM" --sysroot="$TOOLCHAIN/sysroot" \
    --pkg-config=pkg-config --pkg-config-flags=--static \
    --enable-gpl --enable-version3 --enable-shared --disable-static --enable-pic \
    --disable-doc --disable-debug --disable-ffplay --disable-avdevice --disable-postproc \
    --enable-mediacodec --enable-jni --enable-libx264 --enable-libx265 --enable-libzimg \
    --disable-vulkan --disable-opencl \
    --extra-cflags="-O2 -fPIC" --extra-ldflags="-Wl,-z,max-page-size=16384" \
    --extra-ldexeflags="-pie -Wl,-rpath,\$ORIGIN" --extra-ldsoflags="-Wl,-rpath,\$ORIGIN" \
    --extra-libs="-lc++_static -lc++abi -lm -ldl" > "$BUILD/ffmpeg-configure.log" 2>&1 \
    || { tail -30 "$BUILD/ffmpeg-configure.log"; tail -40 ffbuild/config.log; exit 1; }
  log "build ffmpeg"
  make -j"$JOBS" > "$BUILD/ffmpeg-build.log" 2>&1 || { tail -40 "$BUILD/ffmpeg-build.log"; exit 1; }
  rm -rf "$OUT" && make install > "$BUILD/ffmpeg-install.log" 2>&1
  "$STRIP" --strip-unneeded "$OUT"/lib/*.so "$OUT"/bin/ffmpeg "$OUT"/bin/ffprobe
}

build_x264
build_x265
build_zimg
build_ffmpeg
touch "$STAMP"
log "ffmpeg done in $(( ($(date +%s) - START) / 60 )) min: $(du -sh "$OUT" | cut -f1); $(ls "$OUT/lib" | grep '\.so$' | tr '\n' ' ')"
