# DL-N — native download engine

Status: done (fix round 1 done, see "Fix round 1" at the end)

Branch `fb/dl-native` (worktree `streamarr-worktrees/dl-native`, off `fb/downloads`). Spec: PLAN.md § "DL — offline
downloads" (DL-N) and `downloads-plan.html` § 7.

Intent: spike `@kesha-antonov/react-native-background-downloader` vs `expo-file-system` vs an own Expo module
`client/modules/offline-downloads`, decide on evidence, then ship the engine behind one TS interface in
`client/src/downloads/engine/` (+ web/tvOS stub, jest mock), config plugin, local Range test server, device verification
(Android phone, Google TV, iOS simulator).

## Log

- 2026-11-06: read PLAN §2–4 + DL, downloads-plan.html § 7, client/README, embedded-server module/plugin.
- Toolchain: `Streamarr_Phone` / `Streamarr_GoogleTV_1080p` AVDs were gone (and the android-36 google-tv image); recreated
  both from installed API 34 images (`google_apis` pixel_7, `android-tv` tv_1080p — Android TV, not Google TV), 16 GB data,
  `hw.audioOutput=no`. `~/.gradle` still breaks `@react-native/gradle-plugin` (`Unresolved reference 'libs'`, see DV /
  LOCAL-SERVER): builds use `GRADLE_USER_HOME=/Volumes/DevSSD/Caches/Gradle-dl-native` (APFS clone of modules-2 + wrapper).
- Test server `client/scripts/download-test-server.mjs` (port 39320): generated position-dependent bytes (AES-CTR keystream)
  `/f/<size>/<name>`, real files `/media/<file>` (`--media` = Dev World cache), Range/If-Range/416, strong ETag, knobs
  rate / resetAfter(+resetCount) / failStatus(+failCount) / variant (validator change) / log / sha256. 2.5 GB sha256 in 1.5 s.

### Spike — source review (library 4.7.0, published 2026-10-31)
- Android has three transfer paths: DownloadManager (API < 34, writes to external app dir, its own notification; README
  admits `ERROR_CANNOT_RESUME` with large files), UIDT jobs (34/35), `ResumableDownloader` + UIDT (36+).
- `ResumableDownloader` resumes with `Range: bytes=N-` only — **no If-Range / ETag check** (on a changed file a 206 is
  appended: silent corruption). iOS relies on NSURLSession resume data (validator handled by the OS).
- MMKV: Android `compileOnly com.tencent:mmkv-shared` — at runtime it borrows `com.tencent.mmkv.MMKV` from whatever the app
  ships (here react-native-mmkv 4's `io.github.zhongwuzw:mmkv:2.4.1` fork); iOS pod `MMKV >= 1.2.0, != 2.4.1` next to
  NitroMmkv's exact `MMKVCore 2.4.0` (README lists a past EXC_BAD_ACCESS clash with react-native-mmkv, "fixed in 4.4.0").
- Concurrency limit is iOS only (`setMaxParallelDownloads`); Wi-Fi only = `isAllowedOverMetered` per task, no waiting state
  reported; errors are strings/codes (no disk-full / validator kinds); 12k LOC native.
- expo-file-system 57 (`File.createDownloadTask`): foreground transfer only on Android (no service/job), no re-attach after
  a kill, no Wi-Fi constraint → ruled out without a build.
- Streamybox engine: renderer contract v1 `load(session, url, optionsJson)` runs mpv in `dev.streamybox.player` (other UID):
  it cannot open `/data/data/dev.streamarr.app/files/...`. See notes for core.

### Spike — measured (library 4.7.0 in the app, Streamarr_Phone API 34, test server, uncommitted harness)
- Build: links next to react-native-mmkv 4.3.2 without changes (plugin auto-skips its MMKV dependency); runtime: its
  `RNBackgroundDownloader` MMKV instance and Nitro's MMKV 2.4.0 share one `libmmkv` without errors. API 34 runs the
  transfer as a UIDT job (`com.eko.UIDTDownloadJobService`).
- **Validator change → silent corruption:** 2.5 GB at 30 MB/s, ETag switched to variant b at ~520 MB, pause + resume:
  request `Range: bytes=523723930-` **without If-Range** → 206 → `done` with sha256 `374892b9…`, matching neither
  variant a (`1c82b666…`) nor b (`3b57ea06…`).
- **Process kill:** `am kill` leaves the process alive (running UIDT job). `kill -9`: JobScheduler restarts the UIDT job
  in a new process within ~3 s, but the library starts over **from byte 0** (second request without Range; 275 MB lost).
- Re-attach: `getExistingDownloadTasks()` after relaunch lists the running task with bytes/total (works).

### Decision: own Expo module `client/modules/offline-downloads`
| | library 4.7.0 | expo-file-system 57 | own module |
|---|---|---|---|
| Android background | DownloadManager (<14) / UIDT (14–15) / UIDT+own (16+) | none (foreground only) | UIDT job (14+) / dataSync FGS (<14), one transfer code |
| Resume after kill (Android) | measured: restarts from 0 | n/a | Range from `.part` length |
| If-Range / ETag | measured: none (silent corruption) | n/a | If-Range strong ETag/Last-Modified, 200 → restart from 0, `spec.etag` → `validator_changed` |
| Re-attach | yes | no | yes (`list()`, persisted registry) |
| Concurrency | iOS only | JS | native queue on both platforms |
| Wi-Fi only | per-task metered flag, no state | no | global setting, `waiting_wifi` state |
| Error kinds | strings/codes | — | network/http/disk_full/validator_changed/size_mismatch/file_system |
| Native deps | MMKV via react-native-mmkv's fork (compileOnly), 12k LOC | — | none (platform APIs only) |
| iOS | background URLSession | background session (no re-attach) | background URLSession + resume data |
Own module = least long-term risk for multi-GB files on Android TV boxes and phones; we own ~2k LOC native code.

## Interface freeze (requested by the orchestrator for DL-C1)

Frozen TS surface: `client/src/downloads/engine/types.ts` (`DownloadEngine`), `index.ts` (`downloadEngine`; unsupported
stub on web, Apple TV and without the native module; `EXPO_PUBLIC_DOWNLOAD_ENGINE_MOCK=1` = simulated fake for UI work),
`fake.ts` (`createFakeDownloadEngine()` + `controls`: `progress`, `complete`, `fail`, `setState`, `setNetwork`,
`setStorage`, `writeFile`, `files`, `autoRun`). Semantics the manager can rely on:
- The engine queues natively (`maxConcurrent`, default 2) and keeps running while JS is gone; on launch `list()` returns
  every task incl. ones that completed/failed meanwhile. Completed/failed tasks stay until `remove(id)`.
- `start` with a known id returns the existing task unchanged. `resume(id, { url })` swaps an expired capability URL and
  continues from the bytes on disk (also for `failed`). `cancel` deletes the `.part` and forgets the task (state event
  `cancelled`); it never deletes a completed file (`deletePath`).
- Files: written as `<relativePath>.part`, renamed to `<relativePath>` on completion. Store `relativePath` + `volumeId`,
  never absolute URIs (iOS container path changes on app updates); `uriFor()` resolves at runtime.
- Transient failures retry natively (`retrying`, backoff 2 s → 60 s, 8 attempts without progress, progress resets the
  count); then `failed` with `network` / `http`. `waiting_network` / `waiting_wifi` continue by themselves.

### Interface changes after freeze
- Additive only: dev builds expose the engine as `globalThis.__streamarrDownloads` (Argent `debugger-evaluate`, DL-Q).
- `fake.ts`: diagnostics routed through a helper (1663fc1e) so the repo's no-literal-text guard passes; same API.
- DL-C1 requests (orchestrator, 2026-11-06 evening), all additive:
  1. `DownloadError.retryAfterMs?: number` — the server's Retry-After (429/503, delta-seconds or HTTP-date, capped at 1 h)
     in ms, on the `retrying` state event's task (and kept on `failed`); `retryAt` stays the absolute next attempt.
     Absent error fields are now left out instead of `null` on both platforms (Android sent `httpStatus: null`).
  2. HTTP semantics pinned: `src/downloads/engine/http-policy.ts` (`httpStatusAction`, `parseRetryAfter`) is the shared
     table, mirrored by `HttpPolicy.kt` (JUnit `HttpPolicyTest`, 4/4) and `HttpPolicy.swift` (`ios/Tests/HttpPolicyCheck`,
     swiftc). 403/404/409/410/416 and every other 4xx fail at once as `http`; 408/425/429/500–599 and network errors retry
     natively. Changes vs. before: all 5xx retry (was 500/502/503/504), 416 fails at once (was: start over) and drops the
     partial, a Retry-After answer no longer uses up one of the 8 attempts. Fake: `controls.httpStatus(id, status,
     { retryAfterMs })` applies the same table.
  3. iOS backup exclusion covers the whole root (directory attribute; `ensureRoot()` re-applies it on launch/start/storage;
     the `isExcludedFromBackup` diagnostic now checks parent directories); `deletePath` is recursive on both (verified).
- iOS bug found while doing 2: a 503/429 answer to a resumed request threw the resume data away (the next attempt started
  at 0). Fixed with a HEAD probe before resume data is spent (see module README "HTTP statuses").
- Fix round 1 (2026-11-07, all in `types.ts` docs and the fake; sent to the orchestrator before the native work):
  1. `headers`: only `Accept-Language` / `User-Agent`; anything else rejects `start`/`resume` with `invalid_argument`.
  2. Path ownership: `start` with a path another task owns → `invalid_state` (naming the owner); `deletePath` / `move`
     touching an unfinished download's file → `invalid_state`. `cancel` resolves only after the transfer has ended.
  3. Volume ids are stable: `internal` and `volume-<uuid>` (was `external-<n>`). A missing volume is never reassigned:
     its tasks fail `file_system` with message `volume_unavailable` and continue by themselves when it returns (no new
     state).
  4. Retry policy (shared corpus `test-vectors/http-policy.json`): Retry-After answers do not use attempts but are capped
     at 12 h of server-directed waiting without progress (then `failed` `http` with the last status and
     `retryAfterMs`); `retryAfterMs` is 2 s … 1 h (Retry-After 0 → 2 s); an invalid 206 is an ordinary attempt and a
     restart; network changes never shorten a server cooldown.
  5. Event order: `completed` is followed by exactly one final progress event (both platforms, fake too).
  6. Fake: native semantics by default (retry deadlines, capped backoff, exhaustion, 12 h / 2 s, 64 MiB reserve, unknown
     volume `not_found`, ownership, recursive delete frees storage, header allowlist); new controls `httpStatus(id,
     status, { retryAfterMs, retryAfter, progressBytes })`, `networkError`, `mountVolume` / `unmountVolume`, `tick`,
     `calls`, injectable `now`; the old controls stay as manual overrides.

## Notes for core (DL-C1)
- **Streamybox engine and local files:** the renderer contract v1 (`IRenderService.load(session, url, optionsJson)`) hands
  a URL string to mpv inside `dev.streamybox.player` (another UID). It cannot open `/data/user/0/dev.streamarr.app/files/…`
  (app-private), and app-specific external dirs are not readable by other apps on Android 11+ either.
  **Recommendation for v1: never use the Streamybox engine for local playback.** A download is only offered when it
  plays as-is natively or with VLC, so local playback picks the in-app engine from the saved playability: native →
  `expo-video` (Media3), vlc → `expo-libvlc-player` (libVLC), both open `file://` from the engine root (verified below).
  `contentUriFor(relativePath, { grantPackage: 'dev.streamybox.player' })` returns a FileProvider `content://` URI with a
  read grant, but that only helps once the Streamybox player resolves `content://` itself (mpv needs
  `ContentResolver.openFileDescriptor` → `fd://N` in the player process) — a player-side change; a cleaner contract v2
  would be `loadFd(session, ParcelFileDescriptor, optionsJson)`. Track as a Streamybox follow-up, not a DL blocker.

## Verification — Android phone (`Streamarr_Phone`, API 34, emulator-5554, own module)
Driven with Argent `debugger-evaluate` against `globalThis.__streamarrDownloads` (dev global in `index.ts`), test server
on 39320 (`10.0.2.2`), sizes/hashes on the device with `run-as … stat/sha256sum`.
- 2.5 GB (`/f/2560m/movie.bin`, `expectedBytes` + `etag` set) ran as a UIDT job (`started as UIJ: true`, constraint
  `NOT_METERED&INTERNET`, VPN allowed). During the transfer: app to background (continued, 14 MB/s); `kill -9` with the app
  in the background → JobScheduler restarted the job in a new headless process (~50 s, default 30 s backoff) →
  `Range: bytes=685452305-` + `If-Range: "fabf…"` → 206; reinstall over the data + relaunch → `Range: bytes=437928186-`
  → 206; Wi-Fi off (cellular = metered) → `waiting_wifi`, data off → `waiting_network`, data on + `setWifiOnly(false)`
  → resumed on cellular, `setWifiOnly(true)` → stopped, Wi-Fi on → resumed after ~9 s; pause/resume; two server resets
  after 30 MB (`resetAfter`) → `retrying` 2 s → resumed at exactly the next byte. Final file 2,684,354,560 bytes,
  sha256 `1c82b666…` = source; `.part` gone; summary notification "1 download finished"
  (`screenshots/DL-N/phone-notification-finished.png`).
- **Bug found and fixed:** after a process kill, engine init re-scheduled the same job id and thereby cancelled the job
  JobScheduler had just restarted (`reason 1`); scheduling a UIDT job from the background then failed → stalled.
  Now a pending/running job is kept (`getPendingJob`) and only `setWifiOnly` replaces it.
- Concurrency: 3×200 MB + 1, `maxConcurrent` 2 → 2 `running`, 2 `queued` (`phone-notification-progress.png`, "Downloading
  2 items"); `cancel` → `cancelled` event + `.part` deleted, next task starts; 40 GB with 12 GB free → `failed
  disk_full` before writing; server size ≠ `expectedBytes` → `size_mismatch`.
- Validator change: 42 MB of variant a, variant switched, pause/resume → If-Range answered 200 → started over
  (`restarts: 1`, new ETag), final sha256 = variant b; wrong `spec.etag` → `failed validator_changed`.
- HTTP: 503 ×2 with `Retry-After: 1` → `retrying` 1 s each → completed; 404 → `failed http` at once →
  `resume(id, { url })` → completed.
- Swipe from Recents (real gesture) while downloading: process stays (UIDT job), 47 → 97 MB in 10 s.
- Notifications: revoking POST_NOTIFICATIONS kills the process; the job restarts and keeps downloading without it;
  `getNotificationPermission()` → `undetermined`, `requestNotificationPermission()` → system dialog
  (`phone-notification-permission.png`) → Allow → `granted`.
- Playback from the engine root (temporary uncommitted route `src/app/dev/dl-play.tsx`): downloaded Dev World
  `big-buck-bunny` MP4 (H.264/AAC) and MKV (H.264/E-AC3/SRT), sha256 via `engine.sha256()` = source. expo-video (Media3)
  plays `file:///data/data/dev.streamarr.app/files/downloads/acc-1/media/bbb.mp4` (`readyToPlay`, 180 s,
  `phone-expo-video-local-mp4.png`); libVLC opens the MKV (`onFirstPlay` 1920×1080, 180 s, MKV title tag; clock at 38.8 s;
  the emulator capture of VLC's GL surface is black, so no screenshot).
- `storage()` 15.2 GB free of 16.7 GB (16 GB AVD data partition), drops by the file sizes and returns after `deletePath`.

## Verification — Google TV 13 (`Streamarr_GoogleTV13_1080p`, API 33, `sdk_google_atv64_amati_arm64`, Ethernet)
New AVD from the newly installed `system-images;android-33;google-tv;arm64-v8a` (covers the ≤ 13 foreground-service path
real TV boxes use).
- 1 GB at 8 MB/s: `DownloadService` `isForeground=true` (dataSync); Home → continued; `am crash` (run-as kill is not
  allowed on this image) → "Scheduling restart of crashed service … DownloadService in 1000ms" → new process →
  `Range: bytes=286973632-` + If-Range → 206; final sha256 `b9b6b903…` = source; the service stopped itself when the
  queue emptied. `storage()` 16.1 of 16.7 GB free; `volumes()` = internal only (no SD/USB on the emulator).
- expo-video plays the downloaded MP4 from `file:///data/data/dev.streamarr.app/files/downloads/acc-1/media/bbb.mp4`
  (`googletv13-expo-video-local-mp4.png`).

## Verification — iOS simulator (iPhone Air, iOS 26.5, `137E4593…`, Xcode 27)
`node scripts/prebuild-ios.mjs ios` (pod install needs `LANG=en_US.UTF-8`, else CocoaPods dies with
`Encoding::CompatibilityError`), `xcodebuild … -sdk iphonesimulator` → BUILD SUCCEEDED; test server at `127.0.0.1:39320`.
- 1 GB at 15 MB/s in the `…offline-downloads.wifi` background session. `simctl terminate` (system-style kill):
  nsurlsessiond kept downloading (tmp 366 → 457 MB in 6 s); on completion iOS relaunched the app in the background, the
  engine moved the file to `Application Support/downloads/acc-1/ios/ios1.bin`, state `completed`, sha256 `6b971629…` =
  source, xattr `com_apple_backup_excludeItem` (root dir too: `isExcludedFromBackup` true). `storage()` 186 of 494 GB
  (host disk).
- Pause → resume data → `Range: bytes=40058203-` + `If-Range` → 206. Server reset after 50 MB: nsurlsessiond retried by
  itself (`Range: bytes=52428800-` + If-Range after ~6 s; engine attempts stay 0); sha256 = source.
- Concurrency 2 (2 running, 2 queued); validator change: pause, variant switched, resume → If-Range answered 200 →
  URLSession started over, `restarts: 1`, sha256 = variant b; `cancel` → `cancelled`; 400 GB `expectedBytes` →
  `failed disk_full` before any request; 503 (Retry-After 1) → `retrying` → completed; 404 → `failed http 404`.
- User force quit (app switcher swipe, real gesture): the transfer stops at once (server: "client closed"), the partial
  stays in nsurlsessiond's temp; next launch (native only, no JS needed) → `Range: bytes=304349184-` exactly where it
  stopped; installing a new build mid-transfer behaves the same. Two force quits + an update → sha256 `35b50afe…` =
  source.
- Playback from the engine root: AVPlayer (expo-video) plays the downloaded MP4 (`iphone-avplayer-local-mp4.png`), VLCKit
  the MKV H.264/E-AC3/SRT (`iphone-vlckit-local-mkv.png`, first play 1920×1080, 180 s). The container path changed across
  the reinstalls (`…/4B3E0FAC…` → `…/4A371A14…`): store relative paths.
- **Bugs found and fixed:** (1) state/progress events stopped after a JS reload: the old module instance's `OnDestroy`
  cleared the engine's single callback after the new instance had set it → per-instance listener registry. (2) After a
  force quit, reconcile adopted the already-cancelled task from `getAllTasks()` and never resumed → only `.running` /
  `.suspended` tasks are adopted, identity by `taskIdentifier`.
- Not testable on the simulator: Wi-Fi only on cellular/expensive networks (the simulator has no such interface; the
  wifi session sets `allowsExpensiveNetworkAccess`/`allowsConstrainedNetworkAccess`/`allowsCellularAccess` = false and
  `NWPathMonitor` reports `waiting_wifi`) → pending on a real iPhone (DL-Q). iPad: same binary, not run separately.

## Verification — Android TV 14 (`Streamarr_GoogleTV_1080p`, API 34 `android-tv` image, `sdk_google_atv64_arm64`)
- 700 MB at 8 MB/s as a UIDT job on the TV image (`started as UIJ: true`, NOT_METERED constraint; Ethernet).
- **Edge case found:** `kill -9` (app in the background, linear 10 s backoff build): the job stayed `Ready: true` but was
  never started again (`started as UIJ: false`, no timing constraint, empty pending queue) for > 5 min. Fix: the default
  backoff again, and `onForeground()` replaces a pending job that is not attached with a fresh user-initiated one →
  opening the app resumed with `Range: bytes=48974656-` + If-Range → 206. A second background `kill -9` on the new build:
  restarted after 2 s, `Range: bytes=188697408-` → 206. Final sha256 `7a8c4719…` = source.
- So: automatic restart after a process death worked 3 of 4 times (2–52 s); the remaining case recovers when the app is
  opened. Real boxes rarely kill a process with a running user-initiated job; DL-Q should watch for it.

## Decisions (no user input needed)
- **Own module** over the library (table above): measured silent corruption on a validator change and restart-from-0
  after a kill with the library on Android; DownloadManager below Android 14; MMKV coupling.
- **Concurrency is native** on both platforms (default 2): the queue must keep moving while JS is not running.
- **Wi-Fi only = unmetered** (Android `NET_CAPABILITY_NOT_METERED`, so Ethernet on TV boxes counts; iOS: not expensive and
  not constrained). Global setting persisted natively; waiting tasks report `waiting_wifi`.
- **No config plugin and no `app.config.ts` change:** the module manifest brings the services, FileProvider and
  permissions (INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS, WAKE_LOCK, RUN_USER_INITIATED_JOBS, FOREGROUND_SERVICE,
  FOREGROUND_SERVICE_DATA_SYNC); iOS background URLSession needs no `UIBackgroundModes`, the AppDelegate hook is an
  `ExpoAppDelegateSubscriber`. Android Auto Backup already excludes `files/` (expo-secure-store's include-only rules) —
  guarded by `src/downloads/engine/__tests__/android-backup.test.ts`. `STREAMARR_EMBEDDED_SERVER` and the TV builds are
  untouched; the podspec compiles for tvOS (module reports nothing there, JS says unsupported on Apple TV).
- **Storage on Android TV boxes:** internal `files/downloads` by default. `volumes()` already lists app-specific dirs on
  non-emulated (SD/USB) storage and `start({ volumeId })` can target them; whether the UI offers it is a DL-C2 decision
  (removable media can vanish; files there are app-private but deleted with the app). A user-visible public folder is not
  offered (scoped storage, other apps could not play them anyway).

## Summary
`client/modules/offline-downloads` (Kotlin + Swift) behind `client/src/downloads/engine` (`downloadEngine`, types,
fake). Android: one UIDT job (14+) or dataSync foreground service (≤ 13) runs a native queue; Range + If-Range resume from
the `.part` length, start over on a changed validator, retries with backoff, waiting states for network/Wi-Fi, one
progress notification + summary, FileProvider URIs. iOS: two background URLSessions (Wi-Fi only / any), resume data,
background completion moves the file, excluded from backup. Verified on Android phone 14, Google TV 13, Android TV 14 and
the iPhone simulator (iOS 26.5), incl. kills, force quit, app updates, network/Wi-Fi changes, server resets, validator
changes, disk full, HTTP errors and playback of downloaded files in expo-video and VLC. Needs a new APK/IPA (no OTA).

## Files
- `client/modules/offline-downloads/` — `expo-module.config.json`, `README.md`, `android/` (`DownloadEngine.kt`,
  `Transfer.kt`, `DownloadJobService.kt`, `DownloadService.kt`, `Notifications.kt`, `Network.kt`, `Storage.kt`,
  `Model.kt`, `OfflineDownloadsModule.kt`, `OfflineDownloadsFileProvider.kt`, manifest, `res/values{,-de}/strings.xml`,
  `res/xml/offline_downloads_paths.xml`), `ios/` (`OfflineDownloadEngine.swift`, `OfflineDownloadsModule.swift`,
  `OfflineDownloadsAppDelegateSubscriber.swift`, `FileHash.swift`, `OfflineDownloads.podspec`).
- `client/src/downloads/engine/` — `types.ts`, `index.ts`, `fake.ts`, `__tests__/{fake,index,android-backup}.test.ts`.
- `client/scripts/download-test-server.mjs`, `client/README.md` (module pointer).
- Evidence: `docs/client/screenshots/DL-N/*.png`.

## Checks
- `npm run typecheck` 0 errors; `npm run lint` clean; `npm test` 236/236 suites, 2446/2446 tests (the two tab-guard
  failures mentioned in the brief did not occur on this branch).
- Android: `./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a` (STREAMARR_EMBEDDED_SERVER=0 prebuild,
  `GRADLE_USER_HOME=/Volumes/DevSSD/Caches/Gradle-dl-native`). iOS: `xcodebuild … -sdk iphonesimulator` succeeded, no
  warnings in the module. tvOS not built (podspec/sources guard `#if os(iOS)`).

## Follow-ups
- Real devices (DL-Q): Wi-Fi only on an iPhone with cellular; a Streamybox/Android TV box (≤ 13, FGS path, Ethernet,
  SD/USB volume); iPad; long multi-GB seasons (Android 15+ dataSync 6 h budget only matters on the FGS fallback path).
- Android: the notification text follows the device language (en/de resources), not the in-app language override;
  optional `setNotificationStrings()` from JS. Notification actions (pause/cancel) and a deep link to the Downloads screen
  are not there yet.
- Android 14 edge case: a UIDT job left ready-but-unstarted after a process kill (seen once on the TV emulator) recovers
  when the app is opened; a background-only recovery would need an extra regular job.
- Streamybox engine cannot read app-private files (see notes for core); `contentUriFor` exists if the player learns
  `content://`.
- Argent 0.32.0 is available (installed 0.23.0); updating is the user's call.

## Verification — DL-C1 requests (Android phone API 34 emulator-5554, iPhone Air simulator)
Test server rules per file (`/admin/fail?name=…`), 5 MB files, `setMaxConcurrent(6)` for the run (reset to 2 after).
| status (rule) | Android | iOS |
|---|---|---|
| 403, 404, 409, 410, 416 | 1 request each → `failed` `http` + status, attempts 1 | same |
| 429 ×2, Retry-After 5 | `retrying` `retryAfterMs: 5000`, attempts 0 → 2nd 429 → 200 after 10.9 s → completed | same (10.5 s) |
| 503, Retry-After HTTP-date +4 s | `retrying` `retryAfterMs: 3691` → completed | `3423` (fractional, now rounded) → completed |
| 500, no Retry-After | `retrying` backoff 2 s, attempts 1 → completed | same |
| 410, then `resume(id)` | 200 → completed | same |
| 503 on a resumed request (paused at 15/20 MB) | `Range: bytes=15027547-` 503 → after 2 s same Range → 206, sha256 = source | HEAD 503 → `retrying` 2 s → HEAD 200 → `Range: bytes=20135260-` → 206, sha256 = source |
- iOS artwork: `new FileSystemDirectory(rootUri + 'acc-1/work-9/art/').create()` + `FileSystemFile.write()` (expo-file-system)
  works in the engine root; the root has `com_apple_backup_excludeItem`, the art file has no own attribute and is covered
  by the excluded directory (`isExcludedFromBackup('acc-1/work-9/art/poster.jpg')` → true); `engine.fileSize()` sees it.
- `deletePath('acc-1')` / `deletePath('http')` removed nested directories with media and artwork on both; the root stays
  (and stays excluded).
- Checks: jest `src/downloads` 36/36; Kotlin `:offline-downloads:testDebugUnitTest` 4/4; Swift policy check passes.

## Hand-off (final dev clients, devices left running and idle)
Builds from `fb/dl-native` @ b1b3a8f4 (native only; JS from Metro), copied to
`/Volumes/DevSSD/Caches/streamarr-builds/dl-native-b1b3a8f4/` (README.txt there):
- `streamarr-dev-arm64.apk` (also `client/android/app/build/outputs/apk/debug/app-debug.apk`): debug dev client,
  arm64-v8a, one APK for phone/tablet and Android/Google TV (leanback launcher resolves), `STREAMARR_EMBEDDED_SERVER=0`.
- `Streamarr.app` (also `client/ios/build/dd/Build/Products/Debug-iphonesimulator/Streamarr.app`): iOS simulator dev
  client, arm64 + x86_64, iPhone and iPad (not tvOS).
Devices, each with a clean install of these builds, Metro/test server stopped, argent services for them stopped:
`emulator-5554` Streamarr_Phone (API 34), `emulator-5556` Streamarr_GoogleTV_1080p (API 34 android-tv),
`emulator-5558` Streamarr_GoogleTV13_1080p (API 33 google-tv), iPhone Air `137E4593-7A54-4CCA-9707-24B36E336E4A` (iOS 26.5).

## Fix round 1 (verifier DL-N-verify1: 3 blockers, 11 majors, 3 minors)

Input: `streamarr-worktrees/dl-verify-native` @ f5f6c1a5 (`docs/client/journal/DL-N-verify1.md`, `tools/dl-verify-native/`).
Merged fb/downloads (fast-forward to bf1c6483). Orchestrator decisions for N1-01 … N1-17 recorded in the task; log below.

### Log
- Read the report, harness README and all repros (JVM Transfer fixtures + child-JVM crash, Swift host generator, js-check,
  redirect fixtures).
- 220a0ded (TS): shared corpus `test-vectors/http-policy.json` (35 Retry-After vectors, backoff, 10 retry sequences),
  `http-policy.ts` (`decideRetry`, strict IMF-fixdate, clamp before multiply, 2 s floor, 12 h server wait, header
  allowlist), fake rewritten to native semantics, `conformance.test.ts`, N1-17 fix. Interface/fake summary sent to the
  orchestrator before native work. Scratch conformance (220a0ded + fb/dl-ui 74782695, Node 24): 256 suites / 2706 tests
  pass, 0 core/UI breakages.
- 8aa2cfa6 (Android): engine core is pure Kotlin behind `EnginePlatform` (Android parts in `AndroidPlatform.kt`), so the
  JVM harness runs the actual `DownloadEngine`. Transfer appends only on proven 206s, truncates+fsyncs before a new
  validator, last-byte re-validation instead of the complete-part shortcut, every 416 fails, manual redirects, fsync
  checkpoints, space ledger; engine ownership/drain/publication transaction, user-stop exit history, notification
  actions, UUID volumes.
- 5dc806ba (iOS): generations + session-aware task identity, validation on first progress/adoption/final callback,
  pause staging, resume data kept on transient errors, probe assertion, ownership, space ledger, durable writes.
  Found while writing the Swift host check: on a volume that reports `volumeAvailableCapacityForImportantUsage = 0`
  (macOS external disk) every download would be `disk_full` → fallback to `volumeAvailableCapacity`.
- Harness (`client/modules/offline-downloads/test-harness/`): JVM 45/45 (Engine 14, Transfer 25 incl. 3 live on the Range
  server, corpus 6), Swift corpus 738/738 + engine host 16/16, JS 10/10, jest engine 120/120.
- Devices (own, max 2 booted): AVD `Streamarr_Phone_DLN` (API 34 google_apis arm64, pixel_7, 8 GB data,
  `hw.audioOutput=no`) = `emulator-5562`; iOS 26.5 simulator `DL-N iPhone` (iPhone 17) `2CFA8952-5597-45A2-B1D7-907F637C3708`.
  Test server 39320 (new knobs: method-scoped fail rules, `/redirect`, `/capture`, `latencyMs`), Metro 8099.
- Android device run (details under "Device verification" below) found two timing problems: after a network change
  JobScheduler restarted the stopped job only after its backoff (bytes moving again 62 s after the network returned) →
  a visible app replaces the job at once (≤ every 5 s; then 13 s); `kill -9` lost up to 10 s of bytes → checkpoint every
  3 s (3035ccad).
- iOS device run found three bugs: engine errors reached JS as `OfflineDownloadsError: undefined reason` (code lost →
  everything `io`) → Exception subclass with reason + code, bridge falls back to `error.code` (5244b174); after a kill,
  iOS relaunched the app in the background to deliver the finished task but reconcile only adopted running tasks, so the
  200 MB file was dropped and fetched again → finished current-generation tasks are adopted (reconcile and callback
  path, 30 s watchdog), generations seeded from the clock (ce1f5b6d); one ETag change counted `restarts: 2` (validated on
  first write and at the end) → once (19854629).

### N1 → commits and regression tests
Commits: 220a0ded (TS policy/fake), 8aa2cfa6 (Android), 5dc806ba (iOS), 3035ccad (Android timing), 5244b174 (iOS error
codes), ae1e63f6 (test server), ce1f5b6d (iOS relaunch adoption), 19854629 (iOS restart count), aa31636b (README).
JVM = `test-harness/jvm` (`TransferTest`, `EngineTest`, `HttpPolicyTest`), Swift = `test-harness/swift/EngineHostCheck`,
corpus = `test-vectors/http-policy.json` (jest `http-policy.test.ts`, JUnit, `ios/Tests/HttpPolicyCheck`).
| N1 | commits | regression tests | device |
|---|---|---|---|
| 01 resume integrity | 8aa2cfa6 | `missingEtagWithPinnedValidatorFailsAndDrops`, `missingEtagWithoutPinnedValidatorRestartsFromZero`, `unknownRangeTotalIsRejected`, `changedTotalIsRejectedEvenWithoutExpectedBytes`, `invalidRangeEndIsRejected`, `weakValidatorNeverResumes`, `wrongStartDropsThePartial`, `changedEtagDropsThePartial`, `rangeTotalMustMatchExpectedBytes` | Android: wrong pinned ETag → `validator_changed`; ETag switch while paused → If-Range mismatch → 200 → restarts 1, sha256 = variant b |
| 02 crash consistency | 8aa2cfa6 | `resume200StartsOverAndTruncatesBeforeTheNewValidatorIsReported`, `processDeathAfter200NeverPublishesMixedBytes` (child JVM killed) | Android `kill -9` at 150 MB of 1 GiB → `Range: bytes=117460602-` + If-Range, sha256 ok |
| 03 ownership | 8aa2cfa6, 5dc806ba | `EngineTest.aPathBelongsToOneTask`, Swift "an unfinished task owns its path", conformance "owns a path…" | both: `N112//./SAME.json` vs `n112/same.json` → `invalid_state: … belongs to download same` |
| 04 completion / 416 | 8aa2cfa6 | `every416FailsEvenForAMatchingPart`, `range416FailsAndDropsThePartial`, `completePartIsRevalidatedThroughItsLastByte`, `bodyLongerThanTheTotalFails` | — (README fixed) |
| 05 iOS identity | 5dc806ba, ce1f5b6d | Swift "a stale task never publishes…", "the same taskIdentifier from the other session…", "a pending pause wins…", "a task that finished while the app was gone is adopted…", "…not adopted by a paused download" | 12 × pause/resume with Wi-Fi-only toggles (session moves) on 200 MB: bytes monotonic, restarts 0, sha256 ok; kill → background relaunch publishes the one download |
| 06 iOS validation | 5dc806ba, 19854629 | Swift "missing pinned ETag…", "final callback validates the ETag…", "an adopted task is validated again", "the final size is checked…", "unknown range total…", "a 200 answer to a resume counts one restart" | pinned ETag change → `failed validator_changed`, bytes 0; unpinned → completed, restarts 1, sha256 = variant b |
| 07 cancel/move/delete | 8aa2cfa6, 5dc806ba | `EngineTest.cancelRacingTheLastByteLeavesNoFile`, `liveFilesCannotBeMovedOrDeleted`, `cancelResolvesAfterTheWorkerEnded` | Android: live `deletePath`/`move` → `invalid_state`; notification Cancel removes the part, completed file kept |
| 08 retry bounds | 220a0ded, 8aa2cfa6, 5dc806ba | corpus `retrySequences` ×3 runtimes, `networkChangesNeverShortenAServerCooldown`, `invalidPartialIsAnOrdinaryAttemptAndARestart`, Swift "Retry-After answers wait at least 2 s and end after 12 h", "eight ordinary failures stop", conformance (deadlines, exhaustion) | Android: 429 RA 20 s kept through Wi-Fi off/on (`waiting_network` → `retrying` same `retryAt`), 503 RA HTTP-date; iOS: 429 ×2 RA 3 → completed after 6.7 s, attempts 0 |
| 09 parsing parity | 220a0ded, 8aa2cfa6, 5dc806ba | corpus (35 Retry-After vectors), `HttpPolicyTest` 6, Swift 738/738, `hugeRetryAfterCapsAtOneHour`, `dateWithTrailingGarbageIsRejected`, js-check | — |
| 10 HEAD probe / resume data | 5dc806ba | Swift "GET 503 after a good HEAD keeps the resume data", "HEAD 416 drops the resume data" | iOS: HEAD 200 → GET 503 RA 3 → `retrying` attempts 0; the OS then dropped its partial (next GET without Range, restarts 1, documented); suspension during the probe: background-task assertion from HEAD to GET handoff (6 s server latency), GET with Range sent while backgrounded, sha256 ok |
| 11 fake fidelity | 220a0ded | `conformance.test.ts` (10), `fake.test.ts`, js-check | scratch conformance below: 0 breakages |
| 12 redirects | 220a0ded, 8aa2cfa6, 5dc806ba | `sameOriginRedirectKeepsHeaders`, `crossOriginRedirectDropsCallerHeaders`, `httpToHttpsUpgradeIsFollowed`, `schemeChangingRedirectIsRefused`, `liveCrossHostRedirectDropsCallerHeaders`, `EngineTest.headersOutsideTheAllowlistAreRejected`, index.test allowlist | Android (libcore, manual redirects): cross-origin `/capture` got no `Accept-Language`, same-origin kept it; iOS: the OS forwards `Accept-Language` cross-origin (hence the allowlist); `Authorization` → `invalid_argument` on both |
| 13 user stop | 8aa2cfa6, 3035ccad | `userStopExitPausesUnfinishedTasks`, `hostStoppedByTheUserPausesAndIsNotRescheduled` | Task Manager Stop → process stays dead (checked 30 s), exit reason 10 `STOP APP` → relaunch: `paused`, part unchanged; notification Pause/Cancel (screenshots `fix1-android-*.png`) |
| 14 volume identity | 8aa2cfa6 | `missingVolumeWaitsForItsReturn`, conformance "rejects unknown volumes and pauses work on a missing one" | `sm set-virtual-disk`: `volume-446F-07EC`; unmount → `failed file_system volume_unavailable`; remount → resumed with exact Range (when the app ran; Android 14 freezes cached apps), sha256 ok |
| 15 durability | 8aa2cfa6, 3035ccad | `recoveryKeepsOnlyTheCheckpointedPrefix`, Swift "durable writes replace the file" | `kill -9` resume (above) |
| 16 storage pressure | 8aa2cfa6, 5dc806ba | `freeSpaceIsReservedAcrossRunningTasks`, `disk_fullBeforeWritingKeepsThePartial`, Swift "free space is reserved before a start", conformance "keeps 64 MiB free…" | — |
| 17 bridge errors | 220a0ded, 5244b174 | index.test (no prefix → `io` + full message; native `error.code`), js-check | iOS: `invalid_argument` / `invalid_state` reach JS with their code |

### Device verification (fix round 1)
- Android `emulator-5562` (all sha256 = server): 1 GiB through `kill -9`, two network drops and an APK reinstall;
  Wi-Fi off with Wi-Fi only → `waiting_wifi`, all off → `waiting_network`, back → continues with Range; 429 cooldown kept;
  ETag switch; Task Manager stop; notification Pause/Cancel; virtual SD unmount/remount; server reset at 20 000 000 B →
  `Range: bytes=20000000-` + If-Range; swipe from Recents during 200 MB → process and UIDT job keep running, completed.
- iOS `DL-N iPhone` (all sha256 = server): 12-cycle pause/resume + session-move stress; `simctl terminate` mid-download →
  nsurlsessiond finishes, background relaunch publishes (after ce1f5b6d: one GET); force quit from the app switcher at
  177 MB → relaunch: HEAD, `Range: bytes=177209344-` + If-Range; Home during the probe; 429 Retry-After; ETag change
  pinned/unpinned; server reset at 20 000 000 B → Range resume, restarts 0.
- Not engine issues, noted for others: cold start via deep link plus a tap on the Metro entry loads the bundle twice and
  crashed the dev client once (`ExpoFabricView.swift:197: The app context has been lost`); after a background relaunch
  Argent's debugger can stay bound to the old JS page (reset the session and reconnect). Host crash reports from the
  iPhone Air `137E4593…` (not mine) at 00:08 / 00:19 show a MediaToolbox crash in `itemfig_setTextMarkupArray` (player
  subtitles), for whoever owns the player on that device.

### Fake strictness (scratch conformance)
`git worktree add /tmp/dl-n-conformance aa31636b` + `git merge fb/dl-ui` (f60af7c1), Node 24.14.0, full client jest:
**269/269 suites, 2764/2764 tests pass — no core/UI test breaks with the stricter fake** (`jest/downloads.tsx` uses
`createFakeDownloadEngine`). A first run while the iOS build linked had 63 timeouts in `src/__tests__/screens.test.tsx`
only (passes alone 103/103 and in the clean rerun). Earlier (220a0ded + dl-ui 74782695): 256/2706 pass. Scratch worktree
removed.

### Checks (final head aa31636b)
- `npm run typecheck` 0 errors; `npm run lint` clean; engine jest `src/downloads/engine` 5 suites, 121/121.
- JVM harness 45/45 (`HttpPolicyTest` 6, `EngineTest` 14, `TransferTest` 25 incl. 3 live on the Range server, no SKIP).
- Swift: corpus `HttpPolicyCheck` 738/738, engine host 19/19. JS harness `js-check.cjs` 10/10.
- Commands: `client/modules/offline-downloads/test-harness/README.md`.

### Builds
`/Volumes/DevSSD/Caches/streamarr-builds/dl-native-a36493d1/` (README.txt): `streamarr-dev-arm64.apk` (debug, arm64-v8a,
`STREAMARR_EMBEDDED_SERVER=0`; byte-identical to the aa31636b APK, the extra fix is iOS-only) and `Streamarr.app`
(simulator, arm64 + x86_64, includes the extra fix). The earlier `dl-native-aa31636b/` folder is superseded.

### Extra — iOS crash playing a downloaded file (expo-video subtitle lift)
- Reported by DL-C1 (iPhone Air sim, iOS 26.5): a downloaded MP4 on AVPlayer crashed ~3 s in when the controls hid,
  `EXC_BAD_ACCESS` 0x0 on `com.apple.coremedia.rootQueue`, `CFArrayGetCount(NULL)` ← `itemfig_setTextMarkupArray` ←
  `surrogatePlaybackItem_SetProperty`. Cause: `VideoPlayerSubtitleLift.swift` (our expo-video patch) assigned
  `item.textStyleRules = nil` when the lift went back to 0; file-based items crash on nil, HLS items survive it.
- Fix a36493d1: assign `[]` (default placement) instead of nil; the existing `current == target` guard still skips
  no-op assignments. Edited `node_modules/expo-video/ios/VideoPlayerSubtitleLift.swift`, then `npx patch-package
  expo-video` (Gradle's `node_modules/expo-video/android/build` moved aside during the run so it stays out of the patch).
  Patch diff: the assignment line, its doc comment ("[] = default, never nil") and patch-package's blob hash; everything
  else byte-identical; `npx patch-package --error-on-fail` → `expo-video@57.0.5 ✔`.
- Device check on `DL-N iPhone` with a temporary, uncommitted dev route (expo-video `VideoView` + `setSubtitleLift`,
  the same native call the engine makes when the controls show/hide) and local media: a 60 s 480p MP4 with a `mov_text`
  English track, downloaded through the engine (real `file://…/downloads/lift/lift.mp4`), and the same content as HLS
  with a WebVTT rendition (local server, `application/vnd.apple.mpegurl`).
  - Unfixed build (aa31636b): first hide (lift 0.55 → 0) on the file item → SIGSEGV with the reported backtrace.
  - Fixed build, file item: 8 show/hide cycles (3 s each) with subtitles off/on twice, played through to 55 s, same pid,
    no crash report.
  - Fixed build, HLS: cues move above the bar while lifted and return to the bottom after the hide (`[]` resets like nil
    did), 4 more cycles with a subtitle toggle, no crash. Screenshots `screenshots/DL-N/fix1-extra-hls-{default,lifted,reset}.png`.
  - Observation for DL-C1: `mov_text` (tx3g) cues in the MP4 stayed at the picture bottom while lifted (iOS ignores the
    line-position rule for them on the simulator); only WebVTT cues moved. Re-enabling the lift for `file://` sources
    (DL-C1 disabled it in fb/dl-core 0f8f1829) is now safe but may not visibly help for tx3g tracks.
- Checks at a36493d1: `npm run typecheck` 0 errors, `npm run lint` clean, jest `src/downloads/engine` + `src/player`
  68 suites / 1265 tests pass.
