# Server on an Android TV box (embedded server)

The Android TV app can host the Streamarr Core Server itself. The user switches *use this
device as the server* on, the server starts as an Android foreground service that survives
closing the app, swiping it away and rebooting the box, and the app shows the address (and a
QR code) under which the normal management UI is reachable from a phone or desktop. The app
itself connects to `http://127.0.0.1:<port>`. With Tailscale on the box the server is
reachable from the whole tailnet. No Docker, no root: it is a plain sideloaded app on any
Android TV ≥ 10 (API 29, arm64) — the primary target is the Streamybox (Radxa ROCK 4D,
RK3576, Android 14).

This document covers the native and packaging foundation: how the server is built for
Android, how the app runs it, the contract the Streamybox OS uses to control it, and what was
verified. The screens (`fb/client-local-server`) and the OS-side Settings page are separate
pieces built against the contracts described here.

## Architecture

```text
 Android TV app (dev.streamarr.app, one process)
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ React Native screens ──▶ EmbeddedServer (Expo module, Kotlin)             │
 │ Streamybox Settings ───▶ ServerStateProvider (content://dev.streamarr.app.server)
 │ BOOT_COMPLETED / MY_PACKAGE_REPLACED ──▶ BootReceiver                     │
 │                              │                                            │
 │                              ▼                                            │
 │        ServerController (process-wide supervisor, state machine)          │
 │          ├─ EmbeddedServerService: foreground service (specialUse),       │
 │          │   notification "Streamarr Server", partial WakeLock            │
 │          ├─ ServerBundle: extracts assets/embedded-server/server.zip once │
 │          │   per bundle version into filesDir/server/bundles/<version>/   │
 │          └─ ServerProcess ──exec──▶ libstreamarr-host.so  (native lib dir)│
 └──────────────────────────────────────────│────────────────────────────────┘
                                            │ dlopen libhostfxr.so → hostpolicy → coreclr
                                            ▼
                     Streamarr.Server.dll (self-contained .NET 8, linux-bionic-arm64)
                     listens on http://0.0.0.0:<port>, spawns libffmpeg.so / libffprobe.so
```

Fixed decisions:

1. **Separate child process, not in-app hosting.** The app ships the complete Core Server
   (the same thing the Docker image contains: server + `wwwroot` management UI +
   `viewer-web`) and spawns it from a foreground service in the app's own package. The server
   stays a normal ASP.NET Core process with its own lifecycle, memory and logs.
2. **Published for `linux-bionic-arm64`**, self-contained, directory layout (see
   *Android constraints*).
3. **ffmpeg/ffprobe cross-compiled with the NDK**, MediaCodec through the NDK API.
4. **Hardware transcoding** through the new `mediacodec` backend of the server
   ([transcoding.md](transcoding.md#mediacodec-android)).
5. **Everything under `filesDir/server/`** (app-private, no permissions, removed with the
   app): `data/` (SQLite database, Data Protection keys, NZB cache), `cache/` (transcode
   workspace, repair and pre-download caches, temp), `logs/`, `bundles/<version>/` (the
   extracted server). On every current device the "external" app directory lives on the same
   partition, so it would gain nothing; an attached USB drive is a follow-up.

## What the bundle contains

`client/embedded-server/build.sh` produces `client/embedded-server/dist/<server version>/`
(git-ignored) and a `current` symlink:

| Path | Content | Size (0.20.1 build) |
|---|---|---|
| `assets/server.zip` | `dotnet publish` of `Streamarr.Server` for `linux-bionic-arm64` (self-contained, workstation GC, English resources only, no PDBs) with `wwwroot/` (management UI), `viewer-web/` (Expo web export, served under `/watch`), `appsettings.json`, the .NET runtime natives, `libssl.so`/`libcrypto.so` (OpenSSL 3.5.9), `libe_sqlite3.so` and `libSkiaSharp.so` (android-arm64 builds of the referenced package versions). Stored uncompressed; the APK compresses it. | 152 MB (494 files), ≈ 45 MB in the APK |
| `assets/manifest.json` | Versions, `bundleVersion` (`<server version>+<sha256 prefix of server.zip>`), per-file sizes and SHA-256 | |
| `jniLibs/arm64-v8a/libstreamarr-host.so` | The native host (7 KB, `client/embedded-server/host/streamarr-host.c`) | 7 KB |
| `jniLibs/arm64-v8a/libffmpeg.so`, `libffprobe.so` | ffmpeg 9.0.2 programs | 0.4 MB + 0.2 MB |
| `jniLibs/arm64-v8a/libav*.so`, `libsw*.so` | ffmpeg libraries (MediaCodec, x264, x265 8/10-bit, zimg; GPL) | 28 MB together |
| `jniLibs/arm64-v8a/libstreamarr-tunnel.so` | The WireGuard helper of `fb/server-tunnels` (`server/tunnel/build.sh android-arm64`: pure Go, `CGO_ENABLED=0`, a PIE whose only dependency is `/system/bin/linker64`). Included when `build.sh` runs with `STREAMARR_TUNNEL_HELPER=<path to libstreamarr-tunnel.so>`; the app then passes its native-library path as `Streamarr__Tunnels__HelperPath`. Without the variable the slot stays empty. | 11 MB |

The ffmpeg libraries need `libc++_shared.so`, which React Native already packages in every
APK; the server's own natives are self-contained.

## Build pipeline

```sh
source docs/client/env.sh                   # NDK 27.1, JDK 17, Android SDK
client/embedded-server/build.sh             # everything below, ~10 min cold, ~3 min warm
cd client && STREAMARR_EMBEDDED_SERVER=1 npx expo prebuild --platform android --no-clean
cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a
```

`build.sh` runs, with all downloads, build trees and outputs under
`/Volumes/DevSSD/Development/streamarr-work/embedded-server/` (`STREAMARR_EMBEDDED_WORK`):

1. `build-openssl.sh` — OpenSSL 3.5.9 (`android-arm64`, API 29, no legacy/engines/modules,
   16 KB page alignment). OpenSSL's Android targets emit **unversioned** sonames
   (`libssl.so`), which is what .NET's Android crypto shim `dlopen`s first.
2. `build-ffmpeg.sh` — x264 (stable `b35605a`), x265 4.1 as one 8+10-bit static library,
   zimg 3.0.6, then ffmpeg 9.0.2 with `--enable-mediacodec --enable-jni --enable-gpl
   --enable-libx264 --enable-libx265 --enable-libzimg`, shared libraries. ffmpeg ≥ 6 uses the
   NDK `AMediaCodec` API whenever no JavaVM is registered (`ndk_codec` auto), so the plain
   child process gets hardware codecs. libavdevice stays in for the `lavfi` test sources of
   the capability probe. Build time on an M-series Mac: x264 10 s, x265 20 s, zimg 20 s,
   ffmpeg configure 1–3 min + build 1–3 min.
3. Management UI (`web/`, `npm run build` → `server/src/Streamarr.Server/wwwroot`) and the
   viewer web app (`client/`, `EXPO_BASE_URL=/watch npx expo export --platform web`), exactly
   like `server/Dockerfile`. `SKIP_WEB=1` reuses the previous outputs.
4. `dotnet publish -r linux-bionic-arm64` (.NET 8.0.31 runtime pack). The RID graph resolves
   the glibc `linux-arm64` natives for SQLite and SkiaSharp; the script swaps in the
   `android-arm64` builds of the same package versions and adds the OpenSSL libraries.
5. The native host is compiled with the NDK against `hostfxr.h` from the host pack.
6. Everything is zipped, hashed and written to `dist/<version>/` with `manifest.json`.

Every source is pinned by version and SHA-256 (`common.sh`); the two NuGet natives are pinned
by package version (immutable on nuget.org).

The tunnel helper is built from its own branch today (`cd server/tunnel && ./build.sh
android-arm64`, then `STREAMARR_TUNNEL_HELPER=server/tunnel/dist/android-arm64/libstreamarr-tunnel.so
client/embedded-server/build.sh`). Once `fb/server-tunnels` and this branch are merged,
`build.sh` should build the helper itself (follow-up).

CI/EAS (follow-up, not in scope): the bundle is a build input of the Android job. A CI job
would run `build.sh` on a Linux runner with the NDK (the scripts only assume `darwin-x86_64`
or `linux-x86_64` NDK prebuilts), cache `/…/streamarr-work/embedded-server/sysroot` by the
pinned versions, and upload `dist/<version>` as an artifact that the EAS build downloads
before prebuild.

## Android constraints and how they are met

| Constraint | Consequence |
|---|---|
| **No ASP.NET Core runtime pack for `linux-bionic`** (`Microsoft.AspNetCore.App.Runtime.linux-bionic-arm64` does not exist; the SDK lists `linux-bionic` in `RuntimePackExcludedRuntimeIdentifiers`). | ASP.NET Core's runtime pack is pure IL. `Streamarr.Server.csproj` clears that exclusion for `linux-bionic*`, and the RID graph (`linux-bionic-arm64` imports `linux-arm64`) makes the SDK use the `linux-arm64` ASP.NET pack while CoreCLR and the native shims come from the bionic pack. The ReadyToRun code in those assemblies carries the Linux OS override, which bionic accepts. |
| **No `singlefilehost` for bionic.** `PublishSingleFile=true` yields an apphost bundle that still wants an installed runtime ("You must install .NET to run this application"). | Directory layout; `PublishSingleFile` is pinned to `false` for bionic in the csproj. |
| **Android 10+ refuses `exec()` from app data directories**; only files in the APK's native library directory run, and they must be named `lib*.so` and be real files (`extractNativeLibs=true` / `expo.useLegacyPackaging=true`). | Exec'd binaries ship as `libstreamarr-host.so`, `libffmpeg.so`, `libffprobe.so` in `jniLibs/arm64-v8a`. `dlopen`/mmap of libraries in the data directory is allowed, so the whole published server (managed assemblies, `libcoreclr.so`, …) is extracted from assets into `filesDir/server/bundles/<bundleVersion>/`. |
| **The stock apphost locates the app next to its own executable** (`/proc/self/exe`), which would be the read-only native library directory. | `streamarr-host.c`: 70 lines of C that `dlopen` `libhostfxr.so` from the extracted directory and call `hostfxr_initialize_for_dotnet_command_line` + `hostfxr_run_app` with `dotnet_root` = that directory (self-contained mode). |
| **OpenSSL**: the bionic crypto shim `dlopen`s `libssl.so`/`libcrypto.so`; Android has no public ones. | Built from source (above), placed next to the assemblies; `LD_LIBRARY_PATH` covers the extracted directory and the native library directory. HTTPS to indexers/TMDB, PBKDF2, JWT HMAC and `SslStream` for NNTP all go through it. |
| **SQLite / SkiaSharp** natives for glibc would not load. | `SQLitePCLRaw.lib.e_sqlite3` 3.53.3 already contains `runtimes/android-arm64/native/libe_sqlite3.so`; `SkiaSharp.NativeAssets.Android` 4.153.1 provides `libSkiaSharp.so`. |
| **ICU**: the bionic globalization shim loads the system `libicuuc.so`/`libicui18n.so`, which the linker namespace of a plain process may or may not expose. | The host probes ICU before starting the runtime and falls back to invariant globalization (`DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`, predefined cultures off); the supervisor additionally restarts a server that died within 20 s with "ICU" in its output in invariant mode and remembers the choice. The two culture-dependent server paths (ISO 639-2 audio language tags, native language names in the HLS master) degrade gracefully in invariant mode instead of emitting `ivl`/"Invariant Language". |
| **CPU feature detection on the emulator**: the Android emulator on Apple silicon advertises SVE/SVE2 in `/proc/cpuinfo` but traps every SVE instruction (`SIGILL` in x264's SVE2 path). | x264 and ffmpeg are built without SVE/SVE2 code; NEON, DotProd and I8MM stay runtime-detected. No TV box SoC has SVE, so nothing is lost on real hardware. |
| **Memory**: a 4 GB TV box. | Workstation concurrent GC, `DOTNET_GCConserveMemory=5`, English satellite resources only. The server used ≈ 200 MB RSS idle on the emulator. |
| **Process lifetime**: Android kills the app's whole process group (the child included) when it kills the process. | The foreground service keeps the process alive; `START_STICKY` + the sticky-restart path in `ServerController.onServiceStarted` bring the server back after a kill when autostart is on; `BootReceiver` handles reboots and app updates. |

## The Android module (`client/modules/embedded-server`)

Kotlin, package `expo.modules.embeddedserver`, Android only (`expo-module.config.json`).

- **`EmbeddedServerModule`** — `Name("EmbeddedServer")`, the JS contract of
  `client/modules/embedded-server/{types,index}.ts`: `getStatus/start/stop/setAutostart/
  setPort/getCredentials/resetAdminPassword/getLogs` and the `onStatusChange` event with
  the full status.
- **`ServerController`** — the supervisor. Start → the foreground service is started →
  bundle extraction (once per `bundleVersion`, older bundles removed) → port check (the
  configured port or the next free one, reported in the status) → spawn → `/api/v1/health`
  polled every 500 ms (up to 120 s) → `running`. While running, health is polled every 15 s;
  three failures restart the server. Crashes restart with 1, 2, 4, 8, 16 s backoff; the
  sixth crash within 10 minutes ends in `failed` with `lastError`. Stop sends SIGTERM and
  SIGKILL after 10 s. Addresses are re-enumerated on network changes.
- **`EmbeddedServerService`** — `foregroundServiceType="specialUse"` with the
  `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` property, `stopWithTask="false"`, notification channel
  "Streamarr Server" (state + URL, tap opens `streamarr://server/local`), partial WakeLock
  while running.
- **`ServerProcess`** — `ProcessBuilder` with the environment below, stdout+stderr pumped
  into `ServerLog` (`filesDir/server/logs/server.log`, 5 × 1 MB, plus a 2000-line ring buffer
  for `getLogs`).
- **`ServerSettings`** — `port` (default 8080), `autostart` (default on once the server was
  started the first time), the invariant-globalization flag, the "password changed" flag,
  and in `EncryptedSharedPreferences` (Android Keystore master key) the admin password
  (24 characters, `SecureRandom`, unambiguous alphabet) and the machine API key.
- **`BootReceiver`**, **`ServerStateProvider`** (below), **`Addresses`** (`lan`, `tailscale`
  for 100.64.0.0/10 or `tailscale*` interfaces, `loopback`).

Environment of the server process: `ASPNETCORE_URLS=http://0.0.0.0:<port>`,
`ASPNETCORE_ENVIRONMENT=Production`, `--contentRoot <bundle dir>`, `Streamarr__Host=android`,
`Streamarr__ConnectionString`, `Streamarr__DataProtectionKeysPath`, `Streamarr__NzbCachePath`,
`Streamarr__Repair__WorkspacePath`, `Streamarr__PreDownload__CachePath`,
`Streamarr__Transcoding__{WorkspacePath,SamplesPath,FfmpegPath,FfprobePath,LocalSourceBaseUrl}`,
`Streamarr__FfprobePath`, `Streamarr__Admin__{Username,Password}`, `Streamarr__ApiKey`,
`Streamarr__Admin__ResetOnStart=true` (only on the start after a password reset),
`Streamarr__Tunnels__HelperPath` (when the helper is bundled), `HOME`, `TMPDIR`,
`LD_LIBRARY_PATH`, `DOTNET_gcServer=0`, `DOTNET_GCConserveMemory=5`.

**Admin credentials.** Generated once and passed as the bootstrap password; the server seeds
the admin on first run. `resetAdminPassword` rotates the stored password and restarts the
server with `Streamarr:Admin:ResetOnStart=true`, a new server option that re-applies the
configured bootstrap password to the existing admin; the app clears the flag as soon as the
server reports healthy. Whether the user changed the password in the web UI is detected by a
loopback login probe (at most every 30 s while running): a 401 flips
`adminPasswordAvailable` to `false` and `getCredentials().password` to `null`.

### JS contract (`client/modules/embedded-server`)

`types.ts` is the contract the screens are built against; the native module implements it
1:1 and `mock.ts` (`EXPO_PUBLIC_EMBEDDED_SERVER_MOCK=1`) imitates it. Beyond the original
surface (`getStatus/start/stop/setAutostart/setPort/getCredentials/resetAdminPassword/
getLogs`, `addStatusListener`):

- **Rejections carry a stable code.** A rejected call is an `Error` whose `code` is one of
  `port_in_use` (no free port from the configured one upwards), `bundle_missing` (build
  without the bundle or host), `service_unavailable` (the foreground service could not be
  started, e.g. background-start restrictions), `start_failed` (invalid port, spawn errors),
  `stop_failed` (the process survived SIGTERM and SIGKILL) and `not_supported` (no native
  module: other platforms or `STREAMARR_EMBEDDED_SERVER=0` builds). The message starts with
  the code (`port_in_use: no free port between 8080 and 8099`). Failures of an attempt that
  is already running asynchronously (extraction, health timeout, crashes) end in state
  `failed` with the same prefix in `lastError`.
- **`restart()`** stops (waiting until the process is gone) and starts again, so a changed
  port applies in one call. `stop()` itself resolves only once the process has exited.
- **`runningPort`** is the port the process actually bound (`port` stays the configured one);
  it is undefined while not running. `addresses` are built from it.
- **`onCredentialsChange`** (`addCredentialsListener`) fires with the credentials after
  `resetAdminPassword` and when the loopback probe notices that the admin password was
  changed in the web UI (`password: null`).

## ContentProvider contract for the Streamybox OS (version 1)

Authority `dev.streamarr.app.server`, exported, guarded by the permission
`dev.streamarr.permission.SERVER_CONTROL` that the app declares with
`protectionLevel="signature|privileged"` (the Streamybox Settings priv-app on another
signer is whitelisted by the product). `query()` and `call()` both enforce it with
`enforceCallingOrSelfPermission`. The OS side checks availability with
`resolveContentProvider("dev.streamarr.app.server").packageName == "dev.streamarr.app"`.

`query(content://dev.streamarr.app.server/state)` returns one row with the column `json`;
the cursor carries `setNotificationUri`, and `notifyChange(uri, null)` fires on every
transition (debounced 150 ms) and after every mutating call:

```json
{"contractVersion":1,"state":"stopped|starting|running|stopping|failed","port":8080,
 "autostart":true,"version":"0.20.1","startedAt":1793650000000,"lastError":null,
 "adminUser":"admin","adminPasswordAvailable":true,
 "urls":[{"kind":"lan","url":"http://192.168.1.20:8080"},
         {"kind":"tailscale","url":"http://100.101.102.103:8080"},
         {"kind":"loopback","url":"http://127.0.0.1:8080"}]}
```

`startedAt` is 0 while not running, `version` is the bundle's server version until the
process reported its own, `urls` kinds are exactly `lan`, `tailscale`, `loopback` in that
order (`urls` is empty while not running).

`call(method, arg, extras)` → `Bundle { ok: boolean, json: string, error?: string }`:

| Method | Effect | `json` |
|---|---|---|
| `status` | — | state JSON |
| `start` | state `starting`, notify, start the foreground service | state JSON |
| `stop` | graceful stop | state JSON |
| `autostart` (`arg` `"true"`/`"false"`, validated) | persist | state JSON |
| `credentials` | — | `{"username":"admin","password":"…"}` (`null` once changed in the web UI) |
| `resetAdminPassword` | new bootstrap password, restart | credentials JSON |
| `open` | `ACTION_VIEW streamarr://server/local` with `FLAG_ACTIVITY_NEW_TASK`, own package | state JSON |
| anything else | — | `{ok:false, json:"{}", error:"Unknown method"}` |

The deep link is served by the app's `streamarr` scheme (`client/src/app/server/local.tsx`
is a placeholder until the real screen lands). Starting an activity from the provider is
subject to Android's background-activity-launch rules; the Settings app, being in the
foreground, can also fire the same `ACTION_VIEW` intent itself.

## Verification

Emulator: AVD `sbx_streamarr_engine` (Android TV, API 34, arm64-v8a, user build, no root, 4 GB)
on an Apple M4 Pro. Everything below ran against the debug APK built from this branch
(`STREAMARR_EMBEDDED_SERVER=1`, bundle `0.20.1+b923880a`, APK 212 MB), installed with
`adb install -r -g`.

**Server process and API.** After `start` the supervisor extracts the bundle (152 MB, ≈ 1 s on
the emulator), spawns the host and sees `/api/v1/health` within 2 s:

```text
[supervisor] extracting server bundle 0.20.1+b923880a to /data/user/0/dev.streamarr.app/files/server/bundles/0.20.1+b923880a
[supervisor] bundle extracted
[supervisor] spawning /data/app/~~…/dev.streamarr.app-…/lib/arm64/libstreamarr-host.so /data/user/0/dev.streamarr.app/files/server/bundles/0.20.1+b923880a/Streamarr.Server.dll --contentRoot … on port 8080
[supervisor] healthy on port 8080

$ adb shell ps -A -o PID,PPID,RSS,NAME,ARGS | grep streamarr
 8756   338 210784 dev.streamarr.app      dev.streamarr.app
 8863  8756 192380 libstreamarr-host.so   libstreamarr-host.so /data/user/0/dev.streamarr.app/files/server/bundles/0.20.1+b923880a/Streamarr.Server.dll --contentRoot …

$ adb forward tcp:18080 tcp:8080 && curl -s localhost:18080/api/v1/health
{"status":"ok","version":"0.20.1+a94566937031a2617e01c8cd21d2432f84fa7e72","indexers":[],"providers":[]}
$ curl -so /dev/null -w '%{http_code}' localhost:18080/          # management UI   → 200
$ curl -so /dev/null -w '%{http_code}' localhost:18080/watch/    # viewer web app  → 200
```

`POST /api/v1/auth/login` with the generated credentials (read from the dev screen) returns a
JWT; `GET /api/v1/auth/me` answers `{"name":"admin","role":"admin"}`. PBKDF2, HMAC-JWT and
an HTTPS request (indexer test against `https://httpbin.org/`) all run through the bundled
OpenSSL. The JWT stays valid across a server restart (the data-protection keys live in
`files/server/data/keys`).

**ffmpeg from the native library directory, as the app's uid** (`adb shell run-as
dev.streamarr.app sh -c 'LD_LIBRARY_PATH=<libdir> <libdir>/libffmpeg.so …'`; `env` cannot be
used because the install path contains `==`):

```text
ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers
 V....D av1_mediacodec       AV1 Android MediaCodec encoder (codec av1)
 V....D h264_mediacodec      H.264 Android MediaCodec encoder (codec h264)
 V....D hevc_mediacodec      H.265 Android MediaCodec encoder (codec hevc)
 V....D mpeg4_mediacodec     MPEG-4 Android MediaCodec encoder (codec mpeg4)
 V....D vp8_mediacodec       VP8 Android MediaCodec encoder (codec vp8)
 V....D vp9_mediacodec       VP9 Android MediaCodec encoder (codec vp9)
ffprobe version 9.0.2 Copyright (c) 2007-2026 the FFmpeg developers
Hardware acceleration methods: mediacodec
--cpu=armv8-a --enable-gpl --enable-mediacodec --enable-jni --enable-libx264 --enable-libx265 --enable-libzimg --disable-sve --disable-sve2
```

MediaCodec decoders: `av1 h264 hevc mpeg2 mpeg4 vp8 vp9 aac amrnb amrwb mp3`; software:
`libx264 libx265 aac`, filters `zscale tonemap bwdif overlay`. The SVE-free build is what
fixed software encoding on the emulator: before it, the server's own sample generation died
in x264 (`Generating transcoding sample h264-720p-aac failed:` with an empty message, the
`SIGILL`); after it a direct 1280×720 `libx264` encode (2687 kb/s), a `libx265` encode and
an `h264_mediacodec` encode (`speed=17.2x`) all complete.

**Capability probe through the API** (`GET /api/v1/transcoding/capabilities`, 62 s on the
emulator; the MediaCodec encode self-tests write through the fMP4 muxer, see below):

```text
ffmpegFound True  version 9.0.2  usable True  recommended mediacodec  platform {os: Android, architecture: arm64, logicalCores: 4}
mediacodec: status ready, platformSupported True, compiledIn True
  h264Encode {passed: True, detail: '135 ms'}   hevcEncode {passed: True, detail: '446 ms'}
  decode: hevc 146 ms ✓, mpeg2video 143 ms ✓, h264/hevc10 timed out (emulator software decoders), vp9/av1/vc1 no test clip
  toneMapping: 'No hardware tone mapping; HDR is tone-mapped on the CPU (zscale).'
videotoolbox/vaapi/qsv/nvenc: not-applicable ("… is not available on Android.")
```

The emulator answers through the `c2.android.*` software codecs; the numbers say nothing
about the box's hardware, only that the plumbing (NDK MediaCodec from a child process, the
probe's arguments, the backend selection) works.

**Benchmarks through the live pipeline** (`POST /api/v1/transcoding/benchmarks`, the 720p
H.264 sample, 3 Mbit/s, the same `FfmpegArgumentBuilder` command a playback session uses).
The first run exposed a real bug: `h264_mediacodec` produced *no video at all* in fMP4 HLS
while ffmpeg exited 0 after 0.15 s, so the benchmark reported "200× realtime" with
`0 of 10 segments`. ffmpeg's MediaCodec encoder handles the muxer's global-header request by
encoding a dummy frame and leaves Android's codec at EOF afterwards (`-f null` and the probe's
old self-test never trigger it). The encoders now run in async mode with the global header
coming from the `extract_extradata` bitstream filter (`HardwareProfiles.EncoderDeviceArgs`),
and the probe tests MediaCodec through the fMP4 muxer. With the fix:

| Run | Encoder | Result |
|-----|---------|--------|
| `acceleration=mediacodec` | software decode → `h264_mediacodec` (async, `extract_extradata`) | completed, **10/10 segments**, keyframes aligned (drift 0 ms), 1280×720 @ 2973 kbit/s, 13.4× realtime, 0.71 CPU cores in the server process (the codec runs in Android's codec service), first segment after 245 ms |
| `acceleration=none` | `libx264 -preset veryfast` | completed, 10/10 segments, keyframes aligned, 2772 kbit/s, 4.5× realtime, 1.69 CPU cores, first segment after 1086 ms |

The only stderr line of the MediaCodec run is ffmpeg's expected notice `Mediacodec encoder
doesn't support AV_CODEC_FLAG_GLOBAL_HEADER. Use extract_extradata bsf when necessary.`

**OS contract** (instrumented test `client/modules/embedded-server/android/src/androidTest/…/
ServerContractTest.kt`, a second package signed with the app's debug key and holding
`dev.streamarr.permission.SERVER_CONTROL`; run with `./gradlew
:embedded-server:assembleDebugAndroidTest` + `adb shell am instrument -w -r
expo.modules.embeddedserver.test/androidx.test.runner.AndroidJUnitRunner`):

```text
OK (2 tests)
state: {"contractVersion":1,"state":"running","port":8080,"autostart":true,"version":"0.20.1","startedAt":1793656490285,"lastError":null,"adminUser":"admin","adminPasswordAvailable":true,"urls":[{"kind":"lan","url":"http://10.0.2.15:8080"},{"kind":"loopback","url":"http://127.0.0.1:8080"}]}
```

Without the permission the same calls are rejected (`Permission Denial: opening provider …
requires dev.streamarr.permission.SERVER_CONTROL`), and `adb shell content call` from the
shell user is rejected as well.

**Tunnel helper from the native library directory**, as the app's uid:

```text
$ adb shell run-as dev.streamarr.app <libdir>/libstreamarr-tunnel.so --help
Usage of streamarr-tunnel:
  -validate    read the config from stdin, validate it and exit
  -version     print the version and exit
```

**Survival.** Three kinds of death, all with autostart on and the app sent to the background:

- `adb shell am kill dev.streamarr.app` leaves both processes alive (the service is
  `isForeground=true`, type `specialUse`, `oom adj 50`) and health keeps answering.
- `adb shell am crash dev.streamarr.app` kills the app process; Android kills the child with
  the process group, then restarts the sticky service (`lastStartId=2`), whose supervisor
  respawns the server. Health was back after ≈ 6 s:

  ```text
  --- before:        9759  338 dev.streamarr.app / 9850 9759 libstreamarr-host.so
  --- 2 s after:     9850    1 [libstreamarr-ho]           (zombie, reaped)
  --- after ≈ 6 s:  14247  338 dev.streamarr.app / 14287 14247 libstreamarr-host.so
  23:51:59 [supervisor] spawning …/lib/arm64/libstreamarr-host.so … on port 8080
  23:52:01 [supervisor] healthy on port 8080
  ```

- `adb reboot` (and a cold boot of the emulator): `BOOT_COMPLETED` starts the service before
  anyone opens the app; health answered 16 s after the kernel came up while the TV launcher was
  the foreground activity:

  ```text
  --- boot_completed after ~14 s, uptime 11.7 s
  --- health: {"status":"ok","version":"0.20.1+a9456693…"}
  --- processes: 2174 339 dev.streamarr.app / 2442 2174 libstreamarr-host.so …/bundles/0.20.1+b923880a/Streamarr.Server.dll
  --- mCurrentFocus=Window{… com.google.android.tvlauncher/…MainActivity}
  23:52:13 [supervisor] autostart after android.intent.action.BOOT_COMPLETED
  23:52:15 [supervisor] healthy on port 8080
  ```

`adb install -r` of a new build (`MY_PACKAGE_REPLACED`) brings the server back on its own with
the new bundle version and removes the old one (health 3 s after `Success`):

```text
23:48:21 [supervisor] start requested
23:48:22 [supervisor] extracting server bundle 0.20.1+b923880a to /data/user/0/dev.streamarr.app/files/server/bundles/0.20.1+b923880a
23:48:22 [supervisor] bundle extracted
23:48:24 [supervisor] healthy on port 8080
```

Android TV has no recents list to swipe from; the equivalent `stopWithTask="false"` is in the
merged manifest (`aapt2 dump xmltree`: `stopWithTask=false`, `foregroundServiceType=0x40000000`,
`extractNativeLibs=true`, permission `protectionLevel=0x12` = signature|privileged).

**Dev screen** (`/dev/server`, Settings → Developer → *Server on this device (lab)*): start/stop,
autostart, credentials, reset, addresses and the live log (the screenshot in the report shows
it right after a cold boot, with the `BOOT_COMPLETED` autostart in the log).

## Limitations and follow-ups

- **Real hardware codecs only on the box.** The emulator (API 34, arm64) exposes the
  `c2.android.*` software codecs through the same MediaCodec API, which is enough to prove
  the plumbing (encode, decode, self-test, fMP4 segments), not the speed. The emulator's
  H.264 and 10-bit HEVC *decoders* time out in the probe, so sessions there decode in software
  and only encode through MediaCodec; on the RK3576 the hardware decoders are expected to
  pass and `hardwareDecodingAuto` enables them.
- **Expected ffmpeg notice.** Every MediaCodec session logs `Mediacodec encoder doesn't
  support AV_CODEC_FLAG_GLOBAL_HEADER. Use extract_extradata bsf when necessary.` once; the
  bitstream filter is already in the command and the line is harmless.
- **No hardware tone mapping** with MediaCodec; HDR → SDR runs on the CPU (zscale) and is
  slow on a TV box. Remuxing to an HDR-capable player avoids it.
- **AV1 and VP9 software decoding** is not compiled in (no dav1d/libvpx); those codecs decode
  through MediaCodec where the box has a decoder, otherwise they fail.
- **Tunnel helper**: the Android binary ships in the bundle when `STREAMARR_TUNNEL_HELPER` is
  set and executes from the native library directory (see *Verification*), but the Core Server
  on this branch has no tunnel code yet, so `Streamarr__Tunnels__HelperPath` is only consumed
  once `fb/server-tunnels` is merged. Building the helper inside `build.sh` is a follow-up.
- **`open` from the provider** may be blocked by background-activity-launch rules on some
  builds; the OS Settings app can open the deep link directly.
- **Storage** is the box's `/data` partition; external drives are a follow-up.
- **CI/EAS** does not build the bundle yet (see *Build pipeline*).
- **Phone builds** (`STREAMARR_EMBEDDED_SERVER=0`) exclude the module entirely; the JS
  contract then reports `supported: false`.
