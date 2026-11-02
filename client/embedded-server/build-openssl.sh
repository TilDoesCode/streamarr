#!/usr/bin/env bash
# Cross-compiles OpenSSL for Android arm64 with the NDK; the .NET bionic runtime's crypto shim dlopens libssl.so / libcrypto.so.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_ndk
STAMP="$PREFIX/.openssl-$OPENSSL_VERSION"
if [ -f "$STAMP" ] && [ "${FORCE:-0}" != 1 ]; then log "openssl $OPENSSL_VERSION already built"; exit 0; fi

fetch "$OPENSSL_URL" "$OPENSSL_SHA256" "openssl-$OPENSSL_VERSION.tar.gz"
extract "openssl-$OPENSSL_VERSION.tar.gz" openssl
cd "$BUILD/openssl"
export ANDROID_NDK_ROOT="$NDK"
# OpenSSL's android targets emit unversioned sonames (libssl.so), which is what the APK's native library directory needs.
log "configure openssl"
./Configure android-arm64 -D__ANDROID_API__=$ANDROID_API --prefix="$PREFIX" --openssldir=/system/etc/security \
  shared no-tests no-apps no-docs no-legacy no-module no-ssl3 no-comp no-engine \
  -Wl,-z,max-page-size=16384 > "$BUILD/openssl-configure.log" 2>&1
log "build openssl (libraries only)"
make -j"$JOBS" build_libs > "$BUILD/openssl-build.log" 2>&1
make install_dev > "$BUILD/openssl-install.log" 2>&1
"$STRIP" --strip-unneeded "$PREFIX/lib/libssl.so" "$PREFIX/lib/libcrypto.so"
touch "$STAMP"
log "openssl done: $(ls -la "$PREFIX/lib/libssl.so" "$PREFIX/lib/libcrypto.so" | awk '{print $5, $9}' | tr '\n' ' ')"
