# Signed Android TV releases

The generated Android project stays ignored. `with-release-signing` replaces the
release signing configuration after prebuild; a release task fails if credentials
are missing. Debug tasks keep Expo's debug key. Never publish a debug APK.

Android `versionName` uses `STREAMARR_ANDROID_VERSION` (an optional `v` prefix is
removed), defaulting to `client/package.json` locally. `versionCode` is
`major * 1,000,000 + minor * 1,000 + patch`: minor and patch must be 0–999,
and the result must be 1–2,100,000,000. Only increasing stable versions can update
an installed app. The existing Expo/iOS `version: 0.1.0` remains unchanged;
Android package release versions follow the server release tag independently.

## Key custody and GitHub setup

The dedicated RSA 4096 PKCS12 Streamarr key is separate from Streamybox's key:
`/Volumes/DevSSD/Development/streamybox-work/keys/streamarr-release.p12`, with a
mode-600 `.properties` companion. It is valid for 12,000 days, through August 2059.
Back up both files together to at least two encrypted, independently stored
locations. Test restoring them before publishing. Never commit the key, passwords
or APKs. Once an APK is published, this signing identity cannot change: losing it
prevents updates to existing installations. Restore backups instead of generating
a replacement. The public certificate pin is `client/release/android-cert.sha256`.

Before tagging, the operator adds these four repository Actions secrets in GitHub:

- `STREAMARR_ANDROID_KEYSTORE_B64`: base64 of the binary `.p12` (single line).
- `STREAMARR_ANDROID_KEYSTORE_PASSWORD`: the companion file's store password.
- `STREAMARR_ANDROID_KEY_ALIAS`: `streamarr-release`.
- `STREAMARR_ANDROID_KEY_PASSWORD`: the companion file's key password.

Merge this branch, update existing server/plugin release metadata as usual, and
create/push the next stable `vMAJOR.MINOR.PATCH` tag (for example `v0.16.0`). The
existing release workflow runs validation, builds the TV APK with Node 24/JDK 17,
verifies its signer, attests it, adds its hash to `SHA256SUMS`, and publishes
`streamarr-android-tv-<version>.apk` alongside the existing archives.
The current release APK targets arm64 Android TV devices, including ROCK 4D.
A universal APK is about 340 MB and exceeds the factory image space budget; the
arm64 APK is about 105 MB. Other architectures need a separately reviewed asset
policy. Workflow dispatch builds artifacts without publishing. No Android secrets skips
Android packaging; partial secrets or invalid signing fail the Android job.
Server/plugin publication remains independent and warns if the APK was omitted.
Review the Android job before expecting an APK on a release.

## Local reproduction

Use Node 24, JDK 17 and an installed Android SDK. Load the protected companion
file with `set -a; source /path/to/streamarr-release.properties; set +a` (no shell
tracing). Its four fields can instead be supplied as Gradle properties with the
same names. Environment variables take precedence.

```sh
cd client
npm ci
export STREAMARR_ANDROID_VERSION=0.16.0
EXPO_TV=1 npx expo prebuild --platform android --clean
cd android
EXPO_TV=1 ./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs app/build/outputs/apk/release/app-release.apk
```

Keep output APKs in `$SB_WORK/streamarr-release/`, outside Git. The Streamybox
coordinator can pin only an actually published, verified APK, then rebuild the
image; local proof APKs are never production catalog fallbacks.
