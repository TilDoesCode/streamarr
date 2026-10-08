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

## Local proof (2026-10-08)

Node 24.14.0, JDK 17, clean TV prebuild and the documented arm64 release command
passed. Final APK: `$SB_WORK/streamarr-release/streamarr-android-tv-0.16.0.apk`,
105,758,968 bytes, versionName `0.16.0`, versionCode `16000`, SHA-256
`ec9f61e7f1deba40e777e09b13ada4c52946dd5826c8ac9a9ea51638fe6b8f5c`.
Apksigner matched the committed certificate pin, and aapt2 verified the package,
arm64 ABI, leanback activity and application banner. The same-signature
`install -r` replacement launched on assigned emulator-5560 without Metro;
screenshots/readbacks are under `$SB_WORK/screens/streamarr-release/`.
The former debug-signed installation's APK and CE/DE files were backed up in
`$SB_WORK/streamarr-release/emulator-original/` before its necessary removal;
this is not a backup of Android Keystore entries. The release app remains installed.

An unsigned-credentials release dry run failed with the required clear signing
message. An arm64 debug build without release credentials passed. Typecheck,
Expo lint, explicit ESLint on the touched plugin/config, both plugin Jest suites
(13 tests), actionlint and diff checks passed. A universal release build also
passed after moving only this worktree's ignored `node_modules`/native build
scratch onto DevSSD; the first universal attempt filled the internal disk and
failed. The universal APK stays outside Git as a diagnostic artifact and is not
the chosen release payload. Its ~340 MB size motivated the arm64 CI/image policy.
No push, tag, release, secret configuration or physical-device access occurred.
