# DL-N — native download engine

Status: done

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
