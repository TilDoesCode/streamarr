# DL-N — native download engine

Status: done (fix rounds 1, 1c and 2 done, see "Fix round 1", "Fix round 1c", "Fix round 2" and "Known limitations" at the end)

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
- Fix round 1c (2026-11-07, DL-C1 request, TS/fake in 2a6e65a1, hash sent to the orchestrator before the native work):
  1. `cancelled` is no longer event-only. After `cancel(id)` from the app it still is (the task is forgotten). A cancel
     outside the app (Android notification Cancel while JS may not run; iOS has no such path yet) leaves a tombstone in
     `list()`: state `cancelled`, `bytesWritten` 0, `error` omitted, id/url/relativePath/volumeId kept, partial deleted,
     persisted across restarts until `remove(id)`. The `cancelled` event is still emitted when a listener exists.
  2. A tombstone owns no path (a new `start` on it is allowed); `start` with the tombstone's id returns it unchanged
     (remove it first); `cancel(id)` on a tombstone only forgets it (no event, no file operation).
  3. `remove(id)` also clears tombstones and is idempotent: an unknown id resolves (was `not_found`).
  4. Fake: `controls.userCancel(id)` (queued/running/waiting/retrying/paused; no-op on a tombstone, `invalid_state` on
     completed/failed). Android's notification Cancel itself only touches active tasks (paused ones stay).
- Fix round 2 (2026-11-07, TS/fake in af135dd5, sent to the orchestrator before the native work):
  1. `relativePath` ending in `.part` → `invalid_argument`. A task claims its final and its `.part` path
     (case-insensitive) until `cancel`/`remove` and while its transfer is still ending; an equal path, one below it or a
     directory above it → `invalid_state` (N2-01, N2-02).
  2. `cancel(id)` force-closes the connection and resolves once the transfer really ended; after 30 s it rejects
     `io` / `cancel_pending` (claim kept, the cancel continues; calling again waits again). `remove(id)` waits for a
     transfer still ending (e.g. stopped by a missing volume); after 30 s `io` / `remove_pending`. `remove` of a failed
     task deletes its partial (N2-02, N2-06).
  3. `retryAt` is a display value; waits and the 12 h budget run on an elapsed clock (N2-04).
  4. Fake: `controls.stallDrain(id)` / `releaseDrain(id)`, injected monotonic `now` plus optional `wallNow`.
  5. iOS (N2-12, behavioural): a failed task's `bytesWritten` is the bytes the engine kept; losing all of them counts a
     restart.

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

## Fix round 1c (DL-C1 request: notification Cancel while JS is not running)

Gap: the viewer tapped Cancel in the Android notification with the app swiped away; the engine forgot the task, the
`cancelled` event had no listener, and the next launch's `list()` lacked the task, so the manager restarted it.
Rules (orchestrator, binding) and their interface changes: "Interface changes after freeze" → "Fix round 1c".
Merged fb/downloads first (fast-forward to f9cd491c).

### Commits
- 2a6e65a1 (TS): `types.ts` documents the tombstone, the fake gets `controls.userCancel(id)`, tombstones own no path,
  `cancel` on a tombstone only forgets it, `remove` is idempotent; module README states table and ownership note.
  Three conformance tests (lifecycle; cancel on a tombstone keeps the new owner's partial; app cancel stays forgetful,
  paused tasks cancel, finished ones reject); the first two fail without their rule.
- a66e5547 (Android): `cancelAll` (notification, outside the app) keeps every active task as a tombstone (bytes 0,
  checkpoint/retryAt/error cleared, persisted); the partial is deleted at once or when the draining worker ended (the
  claim stays with the drain until then). `cancel(id)` from JS stays forgetful and only forgets a tombstone. A relaunch
  deletes a tombstone's leftover partial (process death mid-drain) only while no newer task owns the path. `remove` is
  idempotent; the space check ignores tombstones. `cancelAll` now marks every task before one pump, so a queued task is
  not started just to be cancelled. JVM: `notificationCancelLeavesATombstoneAcrossARestart` (running + queued task,
  events, files, two relaunches, remove twice), `cancellingATombstoneNeverTouchesTheNextDownloadOnItsPath`,
  `aRelaunchNeverDeletesThePartialOfANewerDownload`; all three fail on the pre-1c engine, the last one also without the
  relaunch guard alone.
- 2903f9e9 (iOS, kept symmetric): `cancelOutsideApp(id)` (unused on iOS today) with the same rules (resume data and staged
  file deleted); ownership skips tombstones; the app's cancel only forgets one; `remove` idempotent. Host check: five
  checks through the public API outside the engine queue (tombstone fields and event, freed path and unchanged id,
  survives a reload, cancel forgets silently, remove twice + finished tasks reject); the ownership and forget guards each
  fail their check when removed.

### Device check (Streamarr_Phone_DLN, API 34; booted as `emulator-5560` this time, serials are assigned at boot)
Build 2903f9e9 installed over the existing data, test server 39320 (`?rate=3000000`), Metro 8099.
1. Swipe-away with JS still alive: `tomb1` (1 GiB) and `tomb2` (512 MiB) running, app swiped from Recents. Process 9278
   kept running, no activity, and the JS runtime stayed attached to Metro (React Native keeps the instance). Notification
   Cancel ("Tombstone one"; `tomb2` had completed): the live listener got `tomb1 cancelled` (bytes 0, no error), server
   "client closed after 679477248", `tomb/one.bin.part` gone, `state.json`: `tomb1 cancelled 0 None`. Relaunch → `list()`
   = `tomb1` cancelled (url/path/volume kept, bytes 0, error null) + `tomb2` completed.
2. JS not running (the reported case): `tomb3` started on the tombstone's path `tomb/one.bin` (allowed), Home, the
   process killed (`run-as kill -9`). The system restarted it at once (pid 9945) without an activity, Metro had **no
   target**, and the UIDT job resumed natively (`GET bytes=33554432-` with If-Range → 206). Notification Cancel
   ("Tombstone three"): server "client closed after 67633152", partial gone, `state.json`: `tomb3 cancelled 0 None`.
   Launching the app started a fresh JS runtime (dev launcher, no earlier globals); its `list()` showed `tomb1` and
   `tomb3` cancelled (bytes 0, error null) and `tomb2` completed. `start({ id: 'tomb3' })` returned the tombstone
   unchanged; `remove('tomb3')` twice, `remove('tomb1')` and `remove('never-known')` resolved; `state.json` empty after
   the cleanup. Screenshots `screenshots/DL-N/fix1c-android-headless-{notification,after-cancel}.png`.
- Tap method: SystemUI exposes no accessibility tree to Argent `describe`, and `uiautomator dump` never reaches an idle
  state while the progress notification refreshes (after stopping Argent's devtools, which hold UiAutomation). The
  Cancel action was therefore tapped via the screenshot fallback from the argent-device-interact skill, and verified
  through the engine state and server log, not the picture.

### Fake strictness (scratch conformance)
Scratch worktree at 2903f9e9, Node 24.14.0, full client jest: + `fb/dl-core` 08b345cb → 264/264 suites, 2695/2695
tests; + `fb/dl-ui` 7dd63a9d → 271/271, 2799/2799. No core/UI test breaks. Scratch worktree removed.

### Checks (2903f9e9)
- `npm run typecheck` 0 errors; `npm run lint` clean; engine jest 5 suites, 124/124.
- JVM harness 48/48 (`HttpPolicyTest` 6, `EngineTest` 17, `TransferTest` 25, live cases against my own fixture server on
  39323, since 39321 was taken by the verifier's `tools/dl-verify-native` server, which I left alone; no SKIP). The
  stderr line `not_found: no download a` from `cancelRacingTheLastByteLeavesNoFile`'s racing thread predates 1c.
- Swift: corpus `HttpPolicyCheck` 738/738, engine host 24/24. JS harness 10/10.

### Builds
`/Volumes/DevSSD/Caches/streamarr-builds/dl-native-2903f9e9/` (README.txt): `streamarr-dev-arm64.apk` (debug, arm64-v8a,
`STREAMARR_EMBEDDED_SERVER=0`; the device check ran on this APK) and `Streamarr.app` (simulator, arm64 + x86_64, rebuilt
because the Swift engine changed; not device-checked, the iOS path has no caller yet and is covered by the host check).

## Fix round 2 (verifier DL-N-verify2: 2 blockers, 6 majors, 2 minors; N2-11, N2-12 and the iOS downgrade added)

Input: `dl-verify-native` @ b207e786 (`DL-N-verify2.md`, `Round2AdversarialTest` REPROs, Swift replays, JS parser case).
Merged fb/downloads (5faac512). N2-10 (client error registry) is DL-C1's. Orchestrator decisions per N2 item in the task.

### Commits
af135dd5 TS policy + fake · 42a7317f Android · 8e2cdc39 iOS · 1c044293 test server (stall, rangeShift, TLS) ·
b1340937 N2-11 · 3fc66a7d iOS https → http · 990710ea test server revoke knob · 18a4d9c9 iOS N2-12 + N2-07 follow-up ·
0f151f4b Android N2-12 parity · 799b4668 iOS N2-12 device follow-ups · 1d77c7ca iOS clone on resume-data arrival ·
8574a70e iOS adopted-task restart count · f40e9757 N2-11 host tokens, no double scheduling, watchdog ·
86a52014 N2-12 error-body diagnostics · 1d2afddf flaky cooldown assertion.

### N2 → fix and regression tests
Each REPRO became a correct-outcome test that fails on the pre-round-2 engine (JVM: the old engine fails the 7 new
engine tests and `retryAfterVectors`; Swift and later fixes: every new guard was reverted one at a time and its check
failed; JS: the zero-padded check fails on the old parser).
| N2 | fix | tests |
|---|---|---|
| N2-01 `.part` alias | final + staging claims, ancestor/descendant, `.part` invalid_argument (all three) | JVM `aTaskOwnsItsStagingPathAndTheDirectoriesAround`; jest "claims the final and the staging path"; Swift "a path ending in .part is rejected …" |
| N2-02 removal during a writing worker | drain record for every stop reason owns the paths; remove waits; write guard + no publish after stop | JVM `aFailedTaskKeepsItsPathUntilItsWorkerEnded`, `aStoppedWorkerWritesNothingMore`; jest "keeps a failed task path claimed …" |
| N2-03 iOS stale resume closure | one increasing generation counter; resume data / probe token / adoption identity-checked; cancel/remove/start drop pending bookkeeping | Swift "late resume data of a cancelled predecessor …" |
| N2-04 clock rollback | elapsed clock (Android elapsedRealtime, iOS mach_continuous_time, fake monotonic now); state v3 with boot id; `restoreWait` corpus (10 vectors) | JVM `wallClockJumpsNeitherExtendNorShortenACooldown`, `aWaitSurvivesARestartAndARebootWithoutGrowing`; jest "keeps deadlines on the monotonic clock"; Swift "a wait restores without growing …" |
| N2-05 `external-<n>` | v1 records rebound only via a `/storage/<UUID>/` segment, else failed volume_unavailable (logged once) | JVM `legacyExternalVolumeIdsAreReboundOnlyByTheirMedium` |
| N2-06 cancel before cleanup | force-close + real drain wait; 30 s → cancel_pending; receiver never claims a timed-out cancel | JVM `cancelForceClosesAStalledRead`, `cancelOfAWorkerThatCannotEndRejectsAndKeepsTheClaim`; jest "rejects cancel_pending …" |
| N2-07 iOS range start | offset from didResumeAtOffset (or the Range on currentRequest), strong recorded ETag, no `?? true` | Swift 4 × "a 206 …", 2 × in-task, "unknown offset keeps the clone" |
| N2-08 iOS final callback intents | failure / replace / cancel / pause honoured before publication | Swift "the final callback keeps a requested failure", "… request replacement …", "same-request requeue …" |
| N2-09 zero-padded Retry-After | strip leading zeroes in all three parsers | corpus vectors (jest, JUnit, Swift), js-check |
| N2-11 (device; DL-C1) | b1340937: a job's stop finds its own execution. f40e9757 (orchestrator decisions): monotonic persisted host token in job extras / service intent, engine keeps the current host by token (older start releases itself, non-current stop ignored); `onForeground` requests only when the system holds no job; the visible fast start replaces only a job in backoff (`getPendingJobReason` = `MINIMUM_LATENCY`); a job still listed after its host stopped for good is replaced; 15 s watchdog (runnable work + request + no host → cancel, ask again, warn once; foreground, `list()`, pump, timer; visible only); `DownloadService` newer start → own host | JVM `aResumeAtForegroundNeverReplacesTheJobItJustScheduled`, `aReplacedHostsLateStopNeverClearsTheNewHost`, `aHostRequestNobodyAnswersIsReplacedAfter15Seconds`, `aStoppedJobIsReplacedOnlyWhileHeldInBackoff`, `aJobStillListedAfterItsHostStoppedForGoodIsReplaced`; each of the six guards fails ≥ 1 of them when removed. Device: DL-C1's sequence 10× |
| N2-12 (DL-C1) | iOS kept bytes (below); Android already kept them | Swift 14 N2-12 checks; JVM `aRevokedCapabilitysGoneAnswerKeepsThePartialForTheRenewedUrl`, `aForbiddenAnswerKeepsThePartialForTheRenewedUrl` |
| iOS https → http (verify2 device question) | response URL checked; https answered over http fails network "redirect https → http refused" | Swift "bytes an https request got …", "https end to end still publishes" |

N2-12 design (iOS; the orchestrator rejected a server-side grace period): a non-2xx body is never content; the engine
keeps APFS clones of the OS partial in `offline-downloads/kept/` (when resume data arrives, before it is spent, and
while the app runs once a second while growing and after 250 ms without progress, cut to the reported bytes; only for
the validated 2xx response; skipped when the OS file is missing, shorter or ambiguous); 4xx/5xx keep the bytes, only
416 / validator_changed / size_mismatch drop them; a changed URL or an unprovable in-task continuation continues the
kept bytes with a plain `Range` + `If-Range` request (206 at the kept offset with the kept strong ETag, else restart;
200 = whole new file); the remainder is appended off the engine queue; kept files go with every terminal path.

### Device verification
Android `Streamarr_Phone_DLN` (API 34, identified by `emu avd name`, `emulator-5560` this boot):
- N2-06: cancel during a 10-min server stall resolved in 16 ms, the socket closed at 8,388,608, the path was free at
  once (a new task on it completed). Earlier run: 200 MB closed at 20,971,520.
- N2-04: a 429 cooldown (Retry-After 120) with the device clock rolled back a day retried after 121 s; a second one
  with the clock 2 h ahead (and a forced pump) also after 121 s; both completed; clock restored (auto_time 1).
- N2-02: virtual SD (`public:7,305`, `524A-0925`) unmounted mid-transfer at 54,788,096 sent; after remount the
  engine resumed at the fsynced checkpoint 54,783,712 with If-Range (206), sha256 = server.
- N2-11 found here: a start right after another download finished stayed `queued` (the replaced job's late
  `CANCELLED_BY_APP` stop detached the new host) → b1340937; rerun: four back-to-back starts completed.
- N2-11, DL-C1's sequence on the f40e9757 APK (Streamarr_Phone_DLN, booted as `emulator-5560`): ten tasks cut at
  1,608,690 B, then 403 (`failed http 403`, 1,608,690 B kept); ten rounds HOME → 2.5 s → launcher intent; on each
  `AppState` `active` the next task was resumed with a renewed URL after 0, 100, 250, 400, 550, 700, 850, 1000, 0 and
  300 ms. Every round: `queued` → `running` in 29–49 ms (longest `queued` 42 ms; limit 5 s), Range `bytes=1608690-` +
  If-Range → 206, completed at 12,289,591 B in 2.7–2.9 s, sha256 = server ×10. JobScheduler history for the window:
  one START and one `app called jobFinished` per round, no `cancelled while waiting for bind` and no app cancel; the
  same emulator's older entries (previous runs with the earlier builds, kept by the boot snapshot) show START, START,
  `cancelled while waiting for bind` six times — the double scheduling. No stale-host or watchdog log line.
- Fast-start regression with the BACKOFF gate (visible, 100 MiB at 3 MB/s): airplane mode 6 s → JobScheduler
  `waiting`, one `host 12 stopped (SYSTEM), reschedule=true` → Range resume 5.6 s after the network returned (round 1:
  13 s), sha256 = server.
- Regression, all sha256 = server: back-to-back starts, ETag unpinned (restart) and pinned (`validator_changed`,
  partial dropped), pause/resume (three Range resumes), `kill -9` (kill2 resumed at 83,896,160, net2 at 50,331,648),
  airplane mode 10 s, 429 (above).
- Observation: after that `kill -9` in the background JobScheduler kept the rescheduled job `ready` but did not start
  it for 55 min (past its 31 min batch window); the next connectivity change started it within 6 s (opening the app
  does too). Rounds 1 and 1c restarted at once on this AVD. OS scheduling, not the engine; worth a look on DL-Q devices.

iOS `DL-N iPhone` (iOS 26.5 simulator), final build 8574a70e for the last runs:
- State v2 → v3 on install. N2-01: `.part` → invalid_argument, ancestor → invalid_state. N2-06: cancel 4 ms, server
  closed at 8,388,608, no partial.
- N2-07: a shifted 206 (+4096) → "invalid partial response … resumed at 10173788" → restart, sha256 ok.
- N2-08: 15 replacement races: the daemon delivers completion without an app-visible window except one replacement
  during a stall (old request closed, new URL downloaded); every file has the right bytes; the ordering itself is
  covered by host checks.
- https → http: the OS followed the downgrade and the engine published plain-HTTP bytes → fixed (3fc66a7d); now
  `failed` network "redirect https → http refused", 0 bytes; https direct and http → https still complete.
- N2-04 clock change: not done on the simulator (it runs on the Mac's clock; changing that would affect other
  sessions); covered by host checks and the `waitRestore` corpus.
- N2-12, DL-C1 numbers (12,289,591 B, cut after 1,608,690): before the fix `failed http 410` with `bytesWritten` 74
  and a full re-download; after: clone of exactly 1,608,690 bytes 0.7 s before the OS's in-task 410 → `failed 410`,
  `bytesWritten` 1,608,690 → renewed URL `Range: bytes=1608690-` + If-Range → 206 of 10,680,901 → sha256 ok, restarts 0.
  403: same. Resume-data path (pause, revoke, resume → GET 410 truncates the OS file, the clone survives) → renewed
  `Range: bytes=2883584-` → sha256 ok. Clean loss (first build, clone too late): `failed 410`, `bytesWritten` 0,
  restarts 1, renewed URL restarts from 0 — the documented limitation's outcome.
- Device findings while doing it: the OS retries a cut connection inside the task (Range + If-Range, no HEAD, no
  callback, no offset; 1.0–3.5 s later) and truncates its file in place to an error body; resume-data blobs use the
  literal root key "NSKeyedArchiveRootObjectKey"; nsurlsessiond purged every CFNetworkDownload file of the app about
  half a minute after a pause; an adopted finished task counted a restart.
- N2-07 follow-up: a plain reset at 20,000,000 → clone 20,000,000 → the OS's unprovable in-task 206 dropped after
  256 KiB → own `Range: bytes=20000000-` → 206 → no full re-download (before: a 52 MB re-download at the end).
- Regression, all sha256 = server: 429 Retry-After 3 s ×2 (attempts 0, 6.6 s), ETag unpinned (restart 1) and pinned
  (`validator_changed`), reset (above), pause/resume ×2 (the clone held exactly the blob's 2,883,584 bytes), kill
  (terminate → the background session finished 50 MiB with one GET → adopted, published, restarts 0), TLS.

### Checks (8574a70e)
`npm run typecheck` 0 errors; `npm run lint` clean; engine jest 5 suites / 145 tests; JS harness 11/11; JVM 59/59
(HttpPolicy 7, Engine 27, Transfer 25; live cases on my own fixture server 127.0.0.1:39323 because 39321 is the
verifier's); Swift corpus 754/754; Swift engine host 53/53.
Fake strictness (scratch merges, Node 24.14.0, same lockfile): 8574a70e + fb/dl-core fa42dacb 269/269 suites, 2760/2760
tests; + fb/dl-ui 238728f2 276/276, 2854/2854 — no core/UI breakage.

### Builds
`/Volumes/DevSSD/Caches/streamarr-builds/dl-native-8574a70e/` (README.txt): `streamarr-dev-arm64.apk` (no native Android
change since b1340937; the APK of every post-fix Android run) and `Streamarr.app` (simulator, arm64 + x86_64; the build
the last iOS runs used).

### Follow-up: N2-04 clock correction (orchestrator, after the round-2 report)
- The decision text called `CLOCK_MONOTONIC_RAW` "no sleep"; on Darwin it is sleep-inclusive like `mach_continuous_time`
  (host: Δ 0.008 ms); `CLOCK_UPTIME_RAW` / `systemUptime` / `SuspendingClock` stop in sleep. The engine already used
  `mach_continuous_time`; no code or doc here repeated the wrong claim.
- Pinned: the iOS source is an injectable `continuousMs` with a one-line comment naming the sleep-inclusive and the
  stopping clocks; host checks fake it (a sleep makes a retry due, a wall-clock change does not) and compare the default
  with `CLOCK_MONOTONIC_RAW`; the harness generator rejects `mach_absolute_time`, `CLOCK_UPTIME_RAW`, `systemUptime`,
  `SuspendingClock` and `CACurrentMediaTime` in the engine's code (a value check cannot tell them apart on a host that
  never slept: this Mac has 5 days uptime and no sleep). Android was already pinned (`elapsed()` doc, JVM fakes it).
- Found while pinning: the retry wake-up timers (iOS `DispatchTime`, Android `ScheduledExecutorService`) stop in sleep,
  so after a sleep a retry could start up to the remaining wait (≤ 1 h) late although the decision used the right clock.
  Both re-arm at least once a minute now (`maxWakeMs`); Swift and JVM checks fire the retry through the timer alone after
  a faked sleep and fail without the cap. Host check 56/56, JVM 60/60.

### N2-11 follow-up builds and checks (f40e9757)
`/Volumes/DevSSD/Caches/streamarr-builds/dl-native-f40e9757/`: new APK; `Streamarr.app` = the f1b25ae7 build (no iOS
source changed since). Checks: typecheck 0, lint clean, engine jest 145/145, JS harness 11/11, JVM 65/65 (no SKIP),
Swift corpus 754/754, engine host 56/56.

### N2-12 follow-up: error body as diagnostics (86a52014)
The decision "a non-2xx body goes to diagnostics only, truncated" was half done: never content, but discarded unseen.
Now Android reads at most 257 bytes of the error stream and iOS of the file the OS hands over for a non-2xx task;
both log one printable line, `<id>: HTTP <status> body: <≤ 256 bytes>` (`…` when cut), through the engine log. Tests:
JVM `HttpPolicyTest.errorBodyBecomesOneTruncatedPrintableLine`, the 410/403 parity tests assert the line; Swift
`an error answer's body is one truncated log line, never content`; each fails without the log line. Found on the
way: `networkChangesNeverShortenAServerCooldown` compared the recomputed `retryAt` display value exactly and failed
4 of 5 isolated runs → tolerance 20 ms (1d2afddf), 5/5. Checks: JVM 66/66, Swift engine host 57/57, corpus 754/754,
lint clean; both dev clients rebuilt into `/Volumes/DevSSD/Caches/streamarr-builds/dl-native-86a52014/`.

## Fix round 3 (verifier DL-N-verify3: 1 major, 7 minors, 3 nits; "pass with findings")
Every verifier repro (`tools/dl-verify-native/` JVM `Round3AdversarialTest` `REPRO_N3_*`, Swift `Round3Check`) now runs
in the promoted harness as the decided outcome; each guard was mutation-checked (reverted alone → its test fails:
11 JVM mutations, 7 Swift).

### Commits
- `acca869f` fake, `types.ts`, conformance (N3-02, N3-03, N3-06); sent to the coordinator before the native work.
- `cb107891` Android: N3-02 … N3-08, N3-10, N3-11, JVM tests, corpus `diagnostics`, lint gate.
- `87411d06` iOS: N3-01, N3-02, N3-03, N3-07, N3-09, Swift checks, README.
- `a23bc812` iOS: a paused partial in `tmp/` is found by its blob name (found on the simulator while verifying N3-01).

### N3 → fix and regression tests
- **N3-01 (iOS, major):** the OS-file heuristic is gone. `osFile` returns only the file the task's own resume data
  names (set when the task is created from that blob); the clone stays cut to the reported bytes. Swift checks:
  ambiguous files, the task's file ≥ 1 MiB ahead and a stall > 10 s (the verifier's three triggers) all leave no kept
  bytes; the blob-named file is cloned and cut even ≥ 1 MiB ahead; an in-task 410 of a task without resume data keeps
  nothing. **Consequence:** a download that was never paused has no exact identity, so a dropped connection that the
  OS continues in-task (unprovable 206, N2-07) or an in-task 4xx/5xx now restarts it from 0 (`restarts` + 1); round 2
  kept those bytes through the heuristic (device: reset at 20,000,000 → full restart, round 2: Range from 20,000,000).
  Possible follow-up, not done: one early `cancel(byProducingResumeData:)` + resume would give fresh tasks an exact
  identity for one extra request.
- **N3-02:** `move`/`deletePath` refuse paths of every registered task but a completed one or a tombstone (paused,
  queued, waiting, retrying, failed with kept bytes; the completed file is the caller's, as core already relies on).
  JVM `pausedRetryingFailedAndQueuedTasksKeepTheirPaths` (also: the resumed 206 publishes only server bytes), Swift
  "every registered task but a completed one …", fake/conformance.
- **N3-03:** `start` rejects a segment ending in `.` or space with `invalid_argument` on every volume and platform;
  claim keys strip trailing dots/spaces per segment. JVM `pathSegmentsEndingInADotOrSpaceAreRejectedOnEveryVolume`,
  Swift, conformance. Core's `filePathOf` can produce such names; reported to the coordinator (DL-C1 fixed it).
- **N3-04:** a new attempt syncs the part an earlier one left (`Transfer.sync` seam) before `durableBytes` covers it;
  if that sync fails the checkpoint stays 0 until this attempt's first sync. JVM
  `aNewAttemptSyncsTheOldPartBeforeItsCheckpointCoversIt` (failing sync → checkpoint 0, relaunch keeps 0 bytes).
- **N3-05:** persisted dispose list (`state.json` `disposals`: volume, path, owner) for every partial that cannot go
  at once (worker still ending, volume missing, delete failed); processed at load, on every pump (volume return) and on
  `remove`; never while a drain writes there or a newer task owns the path. A bounded `settled` list (256) makes a
  retried `cancel`/`remove` after a relaunch resolve. JVM `aProcessDeathDuringCancelPendingStillDeletesThePartial`,
  `removeOrCancelWhileTheVolumeIsMissingDeletesThePartialOnItsReturn`, `aDisposalNeverDeletesTheBytesOfANewerTask`.
- **N3-06:** `cancel` of a draining tombstone waits for the drain like `remove` (same 30 s `cancel_pending`, the claim
  stays with the drain). JVM `cancellingADrainingTombstoneWaitsForItsWorker`, fake/conformance.
- **N3-07:** `HttpPolicy.diagnosticLine` (Kotlin and Swift, byte-identical, 12 corpus vectors): `HTTP <status>
  type=<…> length=<n|unknown> body: <≤ 128 printable bytes>…` after redacting the request URL, its path+query, path and
  query (longest first, ties by text), any absolute URL and every URL-safe token of 24+ chars. JVM
  `anErrorBodyEchoingTheRequestIsRedactedInTheLog`, Swift "an error body echoing the request path …".
- **N3-08:** bounded `read(buf, off, len)` loop; the JVM fixtures' error stream is an API-24 stub without
  `readNBytes`/`readAllBytes`/`transferTo` (the 403/410 parity tests assert the body). Lint `NewApi` is an error for
  the module (`./gradlew :offline-downloads:lintDebug -x :react-native-worklets:lintAnalyzeDebug`; the exclusion skips
  a lint crash in that library's build script). Gate proof: putting `readNBytes` back fails it at `Transfer.kt:323`.
  It also found `NotificationChannel` (API 26) unguarded in `Notifications.ensureChannel`, i.e. a
  `NoClassDefFoundError` on the Android 7 foreground-service path (fixed), `scheduleJob` without `@RequiresApi(34)`
  (only called under the check; annotated) and `syncDirectory`'s java.nio (guarded).
- **N3-09:** continuation tails are `kept/<id>.<generation>.tail`; a stale completion checks the generation first and
  deletes only its own tail. Swift "a stale assembly completion leaves the current generation's tail alone".
- **N3-10:** the legacy test seeds genuine v1 records (id, url, headers, relativePath, volumeId, …); the dead
  `/storage/<UUID>/` branch is gone; README/journal now say v1 external records become `volume_unavailable` and their
  files stay on the card.
- **N3-11:** the connection is handed over under the write lock with a stop check (stopped → disconnect at once);
  `signalStop` is a lock-free CAS under the engine lock and the socket closes on the pool, so a write hung in the kernel
  blocks no engine call. JVM `aStopDuringConnectClosesTheNewConnection`, `aHungWriteNeverBlocksTheEngine`.

### Device verification
Android `Streamarr_Phone_DLN` (API 34, `emulator-5560` by `emu avd name`), APK `cb107891`:
- Virtual SD (`public:7,305`, `B5FC-17FB`) unmounted mid-transfer: vold sends SIGINT to the app because it holds the
  `.part` files open ("Sending Interrupt to pid … (v.streamarr.app)"); the job service restarted the process at once and
  both tasks failed `volume_unavailable`. `remove(sdA)` while missing resolved; `disposals` held
  `{volume-B5FC-17FB, r3/sdA.bin, sdA}`; remount → "sdA: queued partial on volume-B5FC-17FB deleted", list empty,
  sdB resumed by itself.
- `cancel(sdB)` while missing (72,876,032-byte part) resolved; `kill -9`; remount while the app was dead (part still
  there); relaunch → deleted during load; retried `cancel(sdB)` resolved, the next one `not_found`.
- A `cancel_pending` that outlives the process cannot be produced on a device: the force-close ends a worker within ms,
  only a write hung in the kernel outlives 30 s. Covered by the JVM test (blocked worker, relaunch on the same state).
- N3-02/03: dot/space segments rejected on SD and internal; `move` onto a paused task's `.part` and onto `HELD.bin.`,
  `deletePath` of the part and of `r3` → `invalid_state`.
- N3-07: an Apache-style 404 echoing the path, a JWT-like token and the full URL logged as `echo2: HTTP 404
  type=text/html; charset=iso-8859-1 length=244 body: <p>The requested URL [redacted] was not found on this
  server.</p> <p>ref [redacted] at [redacted]</p> </body></html>`; no `DUMMY-CAPABILITY` in logcat.
- Regression, all sha256 = server: pause/resume ×2 (restarts 0), 429 ×2 (Retry-After 3 → completed after 7.0 s),
  ETag unpinned (restart 1) and pinned (`validator_changed`, no partial left), airplane mode 8 s (`retrying` →
  `waiting_network` → `Range: bytes=27304736-` → 206), `kill -9` at 61.6 MB → `Range: bytes=50331648-` (the fsynced
  checkpoint) → 206. A first kill at 22 MB restarted from 0, correctly: the 16 MiB sync had happened, the next 3 s
  persist of its checkpoint had not.
- N3-08 below API 33 has no own AVD; the lint gate and the API-24 stub prove it.

iOS `DL-N iPhone` (iOS 26.5 simulator), app `a23bc812`, host watcher of `kept/` and the OS files every 250 ms:
- N3-01, the verifier's stall trigger: B paused at 2,097,152 (its partial in `tmp/`); fresh A stalled 12 s after
  1,000,000 B, was cut at 1,608,690 and the OS's in-task `Range: bytes=1608690-` got 410 → A `failed` 410,
  `bytesWritten` 0, restarts 1, and `kept/` never held a file for A. B resumed (HEAD + `Range: bytes=2097152-` → 206,
  restarts 0) while its own blob-named file was cloned up to its reported bytes; A's renewed URL restarted from 0;
  both sha256 = server.
- Found there (fixed in `a23bc812`): a pause moves the partial to the app's `tmp/` and the blob then carries only
  `NSURLSessionResumeInfoTempFileName`. The engine looked only in nsurlsessiond's directory, so it dropped the blob
  (B's resume was a GET 200 from 0) and kept nothing. Now the same name is looked up in `tmp/` too (host check, mutation
  checked); the run above is after the fix.
- N3-02/03 as on Android; N3-07 line byte-identical to Android's for the same answer. The capability URL still appears
  in nsurlsessiond/Network.framework's own logs (the OS logs request URLs; unredacted on the simulator), not the app's.
- Regression, sha256 = server: 429 ×2 (6.5 s), ETag unpinned (restart 1) and pinned (`validator_changed`), terminate
  at 12 MB (the background session finished with one GET; adopted, published, restarts 0), reset at 20,000,000 (full
  restart, the N3-01 consequence above), pause/resume (B above).

### Checks (a23bc812)
`npm run typecheck` 0 errors; `npm run lint` clean; engine jest 5 suites / 148 tests; JS harness 11/11; JVM 76/76
(HttpPolicy 8, Engine 43, Transfer 25; live cases on 127.0.0.1:39323); Swift corpus 767/767; Swift engine host 67/67;
module lint (`NewApi` error) 0 errors. Full client jest 237/238 suites, 2579/2580 tests: `src/api/__tests__/errors.test.ts`
"every documented code is known and translated" fails on 15 download codes documented in `docs/api.md` without client
translations; same inputs on fb/downloads `add2fb1f`, not this lane.

### Builds
`/Volumes/DevSSD/Caches/streamarr-builds/dl-native-a23bc812/` (README.txt): `streamarr-dev-arm64.apk` (Android sources
identical at `cb107891` and `a23bc812`; every Android device run used it) and `Streamarr.app` (simulator, arm64 +
x86_64; the build of the final iOS runs).

## Fix round 3b (iOS identity cycle; verifier DL-N-verify4 N4-01..03; engine clock, C2-07)
Coordinator decision after round 3: a fresh iOS download gets an exact OS-file identity through one early
cancel-for-resume-data cycle. Added during the round: the verifier's round 4 (fb/dl-verify-native d93b329b, pass with
findings: N4-01 minor, N4-02 minor, N4-03 nit) and the engine `clock()` API for DL-C1 (C2-07). Repros of
`tools/dl-verify-native/` (`Round4AdversarialTest`, `Round4Check.swift`) run as correct outcomes in the harness.

### Commits
- `567385fe` iOS identity cycle (engine, 10 host checks, README).
- `35e07e7f` `clock()` TS/fake/types + jest, sent to the coordinator first; `e2520225` native `clock()` (Android
  `BootClock`, iOS) + JVM `ClockTest` and a Swift check.
- `c71ce7fa` N4-01 (TS mirror, Kotlin, Swift, corpus); `d51d7b66` strict-index typing of its TS part (`tsc` had failed).
- `88b4da87` N4-02 (Android) and N4-03 (Android, iOS).

### Identity cycle (iOS)
- Once per generation of a fresh GET (not from resume data, not a Range continuation): after its 200 passed validation
  (strong ETag, `Accept-Ranges: bytes`, consistent length), `taskBytes` >= 1 MiB, >= 2 s since the task started and
  >= 1 MiB still to come, the task is cancelled with `cancel(byProducingResumeData:)`; the blob is saved (durable + kept
  clone) and `downloadTask(withResumeData:)` starts at once (no HEAD). Intent `.cycle`: pump keeps the slot and the
  state; the old task's completion only saves its blob and keeps the speed meter; a stop meanwhile (pause, requeue,
  new URL) takes over with the saved blob; a file that finishes before the cancel is published normally.
- Only while the app is active (`UIApplication` notifications); a cycle that came due in the background runs on the next
  activation; a background assertion covers the gap between cancel and the new task.
- Identity = the blob's `NSURLSessionResumeInfoTempFileName`, persisted per generation (`osFileName`,
  `osFileGeneration`), restored on adoption while the file exists (Caches or `tmp/`). It holds only if the
  generation's first answer is a 206 with the same ETag; 200 / another ETag / no usable blob = one failure, one log line,
  strict rule for that generation; after two failures no more cycles (`identityFailures`, persisted).
- Needed alongside: an OS retry inside an already validated generation is proven only by its own `Range`; otherwise it
  is `unverified` (kept bytes stay, Range continuation from them). Before, a resumed task's in-task retry compared
  against the generation's first offset, was "invalid" and dropped the kept bytes.
- Host checks (10): cycle conditions (1 MiB, 2 s), no state event / restart, monotonic bytes; 206 confirms (cost line);
  200 or another ETag = no identity + 1 failure; no resume data = honest restart, max two failures; foreground only +
  activation; pause during the cycle; old task ending first (slot kept); identity across a relaunch; in-task retry
  unproven / proven by its Range. 13 mutations, each caught.

Device (DL-N iPhone, iOS 26.5, test server, sha256 = server every time):

| Scenario | Requests | Result |
| --- | --- | --- |
| 40 MB never paused, reset 12 MB into the cycled 206 | 200 (closed at 8,388,608) · 206 `bytes=8338778-` If-Range (reset at 20,338,778) · OS retry 206 `bytes=20338778-` (unverifiable, closed) · own 206 `bytes=20338778-` If-Range | kept 20,338,778 at the stall; completed, `restarts` 0, 22 progress events, no drop; states queued → running → retrying (the real drop) → running → completed |
| revoke mid-body (410) then renewed URL | 200 · 206 `bytes=8388608-` (revoked after 12,000,000) · OS retry 410 · renewed 206 `bytes=20388608-` | failed `http 410` with 20,388,608 kept, completed after renew, `restarts` 0 |
| B paused (partial in `tmp/`), A cycled, 12 s stall at 11 MB, revoke at 12 MB | A: 200 · 206 `bytes=8388608-` · 410 · renewed 206 `bytes=20388608-`; B: HEAD + 206 `bytes=2621439-` | A's `kept/` (20,388,608 B) byte-identical to the server's bytes of A; B's kept bytes are B's; both complete |
| relaunch mid-transfer (native only, Metro down) | 200 · 206 `bytes=4194304-` (revoked after 30,000,000) · 410 | no second cycle after the relaunch (identity restored); kept 34,194,304 = cut point, byte-identical |
| final build smoke | as row 1 | identical behaviour |

Cycle cost: one extra GET per download; 11, 14, 15, 15, 16, 16, 17, 18 ms from the cancel to the first validated 206
(simulator, localhost); at most 49,831 bytes fetched twice (the response was ahead of the resume data). The first
relaunch attempt lost its tasks: DL-C1's launch reconcile (`manager.ts` `sweepOrphan`, merged with fb/dl-core) removes
native tasks without a core record and their files when JS starts. Expected; device tests that drive the native module
directly must keep JS from relaunching (Metro down), as the repeat did.

### N4 → fix and regression tests
- **N4-01 (Android, iOS, TS):** redaction order is now absolute URLs (the whole run of scheme characters, so a URL glued
  to a token takes it along), then 24+ char tokens, then the request URL's pieces: 8+ chars anywhere, shorter ones only
  as a whole token. `http-policy.ts` gains `diagnosticLine`. Corpus: 12 vectors recomputed (an echoed 27-char
  capability now shows `/api/v1/download/[redacted]`), 3 new vectors, and `redactionFuzz`: 1,500 cases from a seeded
  xorshift32 generator (no query and 1-3 char queries) that jest, JUnit and the Swift check regenerate, 0 leaks and one
  sha256 over all lines (the old order leaks 92 of them). The verifier's own `java.util.Random` fuzz runs as
  `RedactionFuzzTest` (0 leaks, short queries too). 9 mutations (3 rules x 3 implementations) caught. Device: a `?1`
  capability URL logs `/api/v1/offline/[redacted]` on iOS.
- **N4-02 (Android):** when nothing transfers, the idle path always runs (host, progress notification, counters) and
  only a missing volume stays watched. Downloads whose card is missing get one dismissible "Waiting for storage" note
  without actions (en/de; not counted as failed; updated on `remove`, which now pumps); queued partials show nothing and
  expire after 7 days (persisted `since`, one log line). Pause/Cancel only while a download can act on them. JVM: the
  verifier's repro as a correct outcome, storage note, expiry; 7 mutations. Device (Streamarr_Phone_DLN, `emulator-5562`,
  virtual SD `public:7,305` / `2428-1910`): progress with 2 actions while an internal download runs and an SD one is
  queued; card out → after the internal one: summary + "Waiting for storage" (no actions, not ongoing); card back → the
  SD download completes, note gone; German strings (app locale de-DE) checked the same way; `remove` of the waiting
  download while the card is out → note gone, disposal queued; the next batch posts its summary at once (also after a
  `kill -9` + relaunch); card back → `sd4: queued partial … deleted`, disposals empty.
- **N4-03 (Android, iOS):** a record whose path has a segment of only dots or spaces is `failed` `file_system` /
  `invalid_legacy_path` at load (one log line), owns the folder before that segment (parent `deletePath`/`move` =
  `invalid_state`), refuses `resume`, and `remove(id)` deletes it normally. JVM + Swift checks; 6 mutations.

### Engine clock (C2-07)
`clock(): { elapsedMs, bootId }`, synchronous (`Function`), never throws. Android: `SystemClock.elapsedRealtime()`,
boot id `/proc/sys/kernel/random/boot_id` (readable by the app uid on API 34), else `boot-count-<BOOT_COUNT>`, read once
per process and shared with the engine's persisted waits. iOS: `mach_continuous_time`, boot id `kern.bootsessionuuid`,
else `kern.boottime` (deviation from the request, reported: XNU shifts `kern.boottime` whenever the wall clock is set,
which would look like a reboot on exactly the corrections C2-07 is about). JS falls back to `performance.now()` with a
per-process id (stub, missing function, throwing or malformed answer). Fake: `elapsedMs`/`bootId` options,
`controls.advanceElapsed`, `controls.reboot`. Device: iOS 12,671 calls in 50 ms (monotonic, one id = the engine's
persisted boot id); Android 1,973 calls in 50 ms, id = the kernel `boot_id`.

### Checks (d51d7b66)
`tsc --noEmit` 0 errors; `expo lint` 0 problems; engine jest 5 suites / 169 tests; full jest 271 suites / 2,796 tests
(the first full run had 1 failing suite that I did not capture; two reruns were clean); JS harness 11/11; JVM 86/86
(Engine 47, Transfer 25, HttpPolicy 9, RedactionFuzz 3, Clock 2); Swift corpus 773/773; Swift engine host 79/79; Android
module lint (`NewApi` error) 0 errors.

### Builds
`/Volumes/DevSSD/Caches/streamarr-builds/dl-native-88b4da87/`: `Streamarr.app` (iOS simulator) and
`streamarr-dev-arm64.apk` (native code unchanged after 88b4da87), README included.

## Fix round 3c (device findings D-01 from DL-C1, D-02 from DL-C2)
Branch first brought up to date: `fb/downloads` merged in (2aa7961a; DL-C2 UI and journals, no native changes).

### Commits
- `256f2c51` D-01 (Android sync/checkpoint/recovery, iOS pause ordering, 5 JVM tests + 1 Swift check, N3-04 test adapted).
- `5410255b` D-02 (restart bookkeeping on both platforms, 1 JVM + 1 Swift check, one N2-07 check re-seeded).

### D-01: a paused or user-stopped download lost its whole partial (Android)
Cause: a stop disconnects the socket, the blocked read threw out of the write loop and skipped its final fsync, so
`durableBytes` (and the persisted checkpoint) stayed at the last 16 MiB sync, 0 for small downloads; `recoverPart`
then trimmed the part to it at the next launch.
- Worker: fsync on every way out (end, pause, stop, network loss, error) via a plain `syncQuietly` in the `finally`
  (an inlined `runCatching` there let `SyncFailedException` escape the non-local return: Kotlin codegen), and every
  8 MiB or 5 s while running (monotonic clock seam); each running sync calls `onCheckpoint`, persisted at once. The
  fsync stays on the worker thread.
- A persisted record never claims more bytes than its checkpoint (`bytesWritten = min(bytesWritten, checkpoint)`).
- Load: same boot (persisted `clock.bootId` = `clock()`'s source, and `elapsed` not reset) adopts the whole part,
  capped at `totalBytes`/`expectedBytes`, and raises the checkpoint only after an fsync of it; another or unknown boot
  trims to the checkpoint. N1-02 ordering unchanged (truncate + sync → persist the new validator → write), pinned by a
  death-between-truncate-and-persist test.
- iOS: `paused` reaches the registry only together with its resume data and kept clone (`pausePending` keeps the
  pre-pause record on disk until the blob is saved); force-quit after a pause keeps both.
- Tests: JVM pause → sync → reboot keeps the bytes and resumes with `Range: bytes=685360-`; process death on the same
  boot keeps 1 MiB, another boot / unknown boot / reset elapsed trims to the checkpoint (0); sync failure at load keeps
  the old checkpoint; 5 s and 8 MiB cadence; truncate-death never mixes validators. 9 Android mutations + 2 iOS
  mutations caught. The N3-04 test now makes the earlier attempt's sync fail (its premise since D-01).

Device, Streamarr_Phone_DLN (`emulator-5560`, by AVD name), test server, Metro with `EXPO_PUBLIC_DOWNLOAD_ENGINE_MOCK=1`
(the core uses the fake, so its launch reconcile leaves the native tasks alone):

| Sequence | Before the relaunch | After | Resume |
| --- | --- | --- | --- |
| pause at 786,432 → `am force-stop` → relaunch | persisted `paused`, checkpoint = bytesWritten = part = 786,432 | log `[FORCE STOP] … unfinished downloads pause`; part 786,432 | `Range: bytes=786432-` + If-Range → 206, sha256 = server |
| `am stop-app` (the Task Manager stop) mid-transfer | JobScheduler restarted the process at once; part 1,310,720 = server's `client closed after 1310720` | log `[STOP APP] … by user request`; `paused` 1,310,720, checkpoint raised after its sync | `Range: bytes=1310720-` → 206, sha256 = server |
| `adb reboot` mid-transfer | part 5,505,024, persisted checkpoint 4,983,616 (boot `cceb940d…`) | new boot `6c66f898…`; trimmed to 4,983,616 | `Range: bytes=4983616-` + If-Range → 206, completed, `restarts` 0, sha256 = server |
| final APK recheck: pause → force-stop → relaunch | 1,048,576 | 1,048,576, `restarts` 0 | `Range: bytes=1048576-`, sha256 = server |

DL-N iPhone: pause at 4,980,736 → persisted `paused` with `i1.resume` and a 4,980,736 B kept clone → terminate →
relaunch (still `paused`, blob on disk) → resume: HEAD + `Range: bytes=4980736-` + If-Range → 206, sha256 = server.
The notification's Pause could not be tapped by automation (SystemUI is invisible to argent's describe and
`uiautomator` never idles while the progress notification updates); the action calls `pauseAll()`, which runs the same
`pauseLocked` stop/drain/sync path as the API pause used here.

### D-02: a resume that started over kept `restarts: 0` (iOS, also Android paths)
DL-C2 on a23bc812: after a 403 the record still held 2,407,796 B; the renewed URL found no usable resume data and no
kept bytes, `begin()` started a plain GET and set `bytesWritten = 0` without counting (the baseline was already 0), so
the task showed `restarts 0` and 83,536 B right after the resume. Android had similar silent drops (a part without a
strong validator truncated at start, 416, a changed pinned ETag, an oversized body: not counted).
- iOS: `dropBytes(keeping:)` counts `restarts + 1` whenever recorded bytes fall to 0 and is used by `begin()`,
  `handle()` (every drop, not only retryable ones), the replace and pausing paths of `didFinish`, and the cycle fallback.
- Android: `Transfer.droppedAll` marks an attempt that truncated bytes on disk to 0; the engine counts one restart per
  such attempt (at the response and at its end, never twice).
- Tests: JVM, 6 drop paths count exactly one restart and reset `bytesWritten`, and a 403 keeps the part and continues
  with Range + If-Range under the renewed URL. Swift: the DL-C2 sequence and a 416 drop followed by a resume count one
  restart (not two). 6 mutations caught. One N2-07 Swift check now seeds the 4 bytes its in-task retry implies.
- Device (final builds): DL-N iPhone, 403 after the identity cycle (revoke 12 MB into the cycled 206): failed `http 403`
  with 20,338,776 B kept, `restarts` 0; renewed URL `Range: bytes=20338776-` + If-Range → 206, completed, sha256 = server.
  403 before the cycle (at 500,000 B, in-task retry): failed with 0 B and `restarts` 1; renewed URL plain GET 200,
  completed with `restarts` still 1, sha256 = server. Streamarr_Phone_DLN, DL-C2's cut at 2,407,796 B: retry
  `Range: bytes=2407796-` → 403 → failed with 2,407,796 B kept, `restarts` 0; renewed URL `Range: bytes=2407796-` +
  If-Range → 206, completed, sha256 = server.

### Checks (5410255b)
`tsc --noEmit` 0 errors; `expo lint` 0 problems; engine jest 5 suites / 169 tests; full jest 280 suites / 2,916 tests
(one run had a jest worker killed by SIGSEGV in `offline-shell-expired-auth.test.tsx`, the suite never ran; alone and in
the next full run it passed: an infrastructure crash, likely also the unidentified failure of the 3b run); JS harness
11/11; JVM 92/92 (Engine 53, Transfer 25, HttpPolicy 9, RedactionFuzz 3, Clock 2); Swift corpus 773/773; Swift engine
host 81/81; Android module lint (`NewApi` error) 0 errors.

### Builds
`/Volumes/DevSSD/Caches/streamarr-builds/dl-native-5410255b/` (`Streamarr.app` simulator, `streamarr-dev-arm64.apk`,
README); they replace `dl-native-88b4da87` (marked `SUPERSEDED.txt`, kept).

## Fix round 3d (verifier DL-N-verify5: N5-01 minor, N5-02 and N5-03 nits; device finding D-03 from DL-C1)
Branch first fast-forwarded to `fb/downloads` (0a9bbef8; no native changes). Verifier repros of
`tools/dl-verify-native/` (`Round5AdversarialTest`, `Round5Check.swift`) run as correct outcomes in the harness.

### Commits
- `e01adde6` N5-01, N5-02 (Android), N5-03 (iOS), `types.ts` `restarts` doc (doc only, D-02 wording).
- `bd8911dc` D-03 (iOS).

### N5 → fix and regression tests
- **N5-01 (Android, removable media):** same-boot adoption (D-01) now applies to the `internal` volume only. A part on
  `volume-<uuid>` trims to its last synced checkpoint at load, and a task whose volume went missing in the process
  (`untrimmed`) trims when the volume is back, once its own worker ended; pump starts no task that still drains and
  `reconcileVolumes` runs before it starts any, so the trim always precedes the next request. A first version
  postponed the trim per volume and needed a re-queue guard that no test could distinguish (mutation not caught); per
  task it needs none. JVM: the verifier's `AAAA0000CCCC` repro now ends `AAAABBBBCCCC` with `Range: bytes=4-` (internal
  still adopts 8); a card leaving and returning in one process; a worker still ending on the returned card holds the
  trim back (8 bytes kept while it writes, then `bytes=4-`). 4 mutations caught.
- **N5-02 (Android):** a part deleted between launches counts one restart at load (log "partial file gone, starting
  over"), checkpoint and bytes go to 0; the fresh GET truncates nothing, so it is never counted twice. JVM test incl.
  a second relaunch. No corpus row: the shared corpus covers the pure HTTP-policy functions, and restart bookkeeping is
  engine state (iOS parity is covered by the 3c D-02 Swift check). 1 mutation caught.
- **N5-03 (iOS):** the cycle's background-task assertion lived in the shared per-id slot; a file finishing inside the
  cycle window dropped the cycle without ending it (held until expiry, ~30 s). The cycle now owns its assertion
  (`IdentityCycle`) and `dropCycle` ends it on every way the cycle ends: resumed (after `begin`), file finished in the
  window, cancel / remove / new start (`forget`), pause or requeue (when its blob arrives), unusable resume data.
  `BackgroundAssertion.end()` ends once and counts begin/end for the harness. Swift: open assertions 1 during the race,
  0 right after the finished file, 0 after the late blob; cancel, pause, success and unusable-blob paths end theirs;
  a double end counts once; 6 begun = 6 ended. 4 mutations caught.

### D-03: a reset in the first response before the identity cycle lost every byte (iOS)
DL-C1 on 5410255b (iPhone Air, Dev World `direct_reset` at 2,000,000 B, unthrottled): the OS retried inside the task
with `Range: bytes=2000000-` + If-Range and got a matching 206, but nsurlsessiond puts that Range on an internal
request (`task.currentRequest` has none), so the offset was unknown, the response "unverifiable", and with no kept
bytes yet the task restarted from 0.
- When the 206's Range is not visible, it counts as the task's own continuation only if its Content-Range starts
  exactly at the cumulative bytes the same task (identifier + generation) reported last, with the strong ETag of the
  validated first response and a consistent range; never for the engine's own Range continuation. Everything else
  keeps today's outcome (one byte later or another task: unverifiable; another ETag: invalid, as before). One log line
  when it applies; publishing still checks the size. An `expectedBytes` clause I added first turned out redundant with
  the existing `size_mismatch` check (its mutation was not caught) and was dropped.
- The identity cycle runs once 256 KiB of a validated fresh GET arrived, no 2 s minimum (same cap of two failures,
  same fallback); `taskStarted`, used only by the time rule, is gone.
- Swift: accepted at the reported bytes (continues and publishes, `restarts` 0); one byte later, another ETag and
  another task are not accepted; threshold pinned at exactly 256 KiB (256 KiB − 1 does not cycle). 4 mutations caught.

### Device verification
- **DL-N iPhone (final iOS build bd8911dc), D-03:** test-server reset at 2,000,000 B, unthrottled, 8,654,107 B file
  (Sintel's size), three runs: each time `GET 200 reset after 2000000` → `206 bytes=2000000-` + If-Range, `restarts` 0,
  no `retrying` state, sha256 = server. On the simulator's localhost the reset lands while the new 256 KiB cycle is
  already cancelling, so the cycle's own resume carried it ("identity cycle … at 2000000 bytes, resumed with a 206
  after 10–12 ms"). Reset at 100,000 B: the OS's in-task 206 `bytes=100000-` was accepted by the counter proof ("in-task
  continuation at 100000 proven by the bytes this task reported"), `restarts` 0, sha256 = server: better than the
  clean restart the decision allowed. The rejected path (start ≠ reported) is covered by the Swift check only.
- **DL-N iPhone, N5-03:** 1 MiB, 1.5 MiB and 1.9 MB unthrottled files plus the D-03 runs, then 45 s in the background.
  UIKit's own log: 5 `streamarr-download-*` cycle assertions created, 5 ended, none overdue, no "30 seconds" warning.
  Two of them (1.5 MiB, 1.9 MB) logged no cycle line: the file finished inside the window (the N5-03 race) and the
  assertion still ended. Earlier run on e01adde6: 1.5 MiB + a cycled 8 MiB file, 45 s background, no warning.
- **Streamarr_Phone_DLN (emulator-5560, API 34, virtual SD), N5-01:** 40 MB to `volume-89D6-1AF9` at 1 MB/s, unmounted
  at 11.27 MB (persisted checkpoint 11,014,368). vold killed the app and the job restarted it; the new process failed
  the task `volume_unavailable`. Remount: the card held 11,534,336 B (a clean `sm unmount` flushes), and the transfer
  did not restart while the app had no UI (likely Android 14 deferring the mount broadcast to a cached process; a
  user-initiated job also needs the foreground). On foreground: `Range: bytes=11014368-` (the checkpoint, not the card's
  length), sha256 = server, `restarts` 0.
- **Streamarr_Phone_DLN, N5-02:** paused at 1,835,008, `am force-stop`, `.part` deleted, relaunch: "gone: partial file
  gone, starting over", `restarts` 1, bytes 0; resume → full GET 200, completed with `restarts` 1, sha256 = server.

### Checks (bd8911dc)
- `tsc` 0 errors, `expo lint` 0 problems, engine jest 5 suites / 169, full jest 293 suites / 2,979, JS harness 11/11.
- JVM 96/96 (ClockTest 2, EngineTest 57, HttpPolicyTest 9, RedactionFuzzTest 3, TransferTest 25), Swift corpus
  773/773, Swift engine host 83/83, Android module lint (`NewApi` error) 0 errors.
- 13 guard mutations caught (N5-01 4, N5-02 1, N5-03 4, D-03 4).

### Builds
`/Volumes/DevSSD/Caches/streamarr-builds/dl-native-bd8911dc/` (`Streamarr.app` built at bd8911dc,
`streamarr-dev-arm64.apk` built at e01adde6; bd8911dc changes no Android source; README). `dl-native-5410255b` carries
`SUPERSEDED.txt`.

## Fix round 3e (verifier DL-N-verify6: N6-01, N6-02 minor, N6-03 nit; N6-04 found on device)
Branch first fast-forwarded to `fb/downloads` (092a2fba; no native changes). Verifier repros of
`tools/dl-verify-native/` (Swift round 6 checks 1, 2 and 6, JVM `REPRO_N6_aNewDownloadCountsARestartForAQueuedPartialItInherits`)
run as correct outcomes in the harness. None of the round-6 findings could publish wrong bytes; all cost bandwidth.

### Commits
- `cedc06e2` N6-01, N6-02 (iOS), N6-03 (Android), checks and README.
- `f60e3bc0` N6-04 (iOS), decided by the coordinator mid-round (option A, with the "Range at or behind the report" guard).

### N6 → fix and regression tests
- **N6-01 (iOS):** `didFinishDownloadingTo` cleared the task tracking (with `lastReport`) before `validate`, so an in-task
  206 whose bytes were never reported (short tail after a late reset, coalesced progress) could not be proven and the
  complete file was dropped as unverifiable. The report is now captured together with the validated response key
  before the clear and handed to `validate(report:)`. Swift (verifier check 1): finishing without a report of the 206
  publishes with `restarts` 0; the control with a report too; a start one byte off publishes nothing. 1 mutation.
- **N6-02 (iOS):** the cycle wanted the current response to be a 200, so after a D-03 continuation a download never got
  an identity. `freshGets` records the generation whose validated response was a 200 with `Accept-Ranges: bytes`
  (also for adopted tasks, as before); its proven in-task 206 still counts, bytes counted from the generation start.
  Swift (verifier check 2): an accepted in-task 206 at 100 KiB, then the cycle past 256 KiB, then an in-task 410 keeps
  the bytes (failed 410, bytes = kept, `restarts` 0); no cycle for a 200 without `Accept-Ranges`. 3 mutations.
- **Generation guard promoted:** the verifier's check 6 (a report of the same task identifier under another
  generation proves nothing) is now in the harness; reverting `report.generation == generation` fails it.
- **N6-03 (Android):** `start` runs the pending disposals before registering the new task, so a queued partial on the
  path is deleted, not inherited; and a drop counts a restart only if the task had bytes of its own at the attempt's
  start (`Transfer.ownBytes` = `bytesWritten > 0 || checkpoint > 0`), as iOS `dropBytes`. JVM: the verifier's repro
  ends `restarts` 0 with A's partial deleted (log line); a stray part a new task truncates is no restart; the D-02 test
  guards the other direction. 3 mutations, each caught by its own test.
- **N6-04 (iOS, device finding):** a task made from resume data keeps the blob's ORIGINAL Range on its
  `currentRequest` (bytes=262144- from the identity cycle, also after a later pause/resume at 6,257,960). In the
  later-response branch that visible Range took precedence over the D-03 report: an in-task 206 at exactly the
  reported bytes was "unverifiable" (2 s `retrying`, then the engine's own Range continuation; correct, but slower).
  Coordinator decision (A): when the visible Range lies at or behind the same task's report (identifier and
  generation), the report decides and the 206 must start exactly there (ETag and consistency checks unchanged); a
  visible Range ahead of it keeps its own rule. A first version also required `start == report` in the condition;
  dropping it makes a 206 at the stale Range itself unacceptable too (it cannot continue a file holding more bytes).
  Swift: the device sequence accepted (running, `restarts` 0, no `retrying`); Range ahead of the report (start = report:
  not accepted; start = Range: accepted), start one byte off, another generation's report, a 206 at the stale Range.
  2 mutations (plus the generation guard).

### Device verification
- **DL-N iPhone (iOS 26.5 simulator, 3e build):**
  - Reset 64 KiB before the end of a 20 MiB file, unthrottled (as decided, `resetCount` 2): the identity cycle took over
    the first response at 4,456,448 B, so the reset was never reached; published, `restarts` 0, sha256 = server.
  - Deterministic version: throttled to the cycle (262,144), paused at 6,257,960, resumed unthrottled with the reset at
    20,905,984. Before N6-04: in-task 206 `bytes=20905984-` "unverifiable … resumed at 262144", `retrying`, engine Range
    continuation, `restarts` 0, sha256 = server. After N6-04 (rebuilt, paused at 6,291,456): one 206 at 20,905,984,
    "in-task continuation at 20905984 proven by the bytes this task reported", no `retrying`, no extra request,
    `restarts` 0, sha256 = server.
  - Reset at 100,000, then a later in-task 410: 206 `bytes=100000-` proven by the report, identity cycle at 362,144
    (N6-02), revoked after 6,000,000 more bytes, in-task 410 at 6,362,144: `failed` 410 with 6,362,144 kept, `restarts`
    0; renewed URL → `Range: bytes=6362144-` → completed, `restarts` 0, sha256 = server.
- **Streamarr_Phone_DLN (emulator-5560, API 34):** the disposal race (card back, new start before any pump) cannot be
  provoked there: the mount broadcast pumps at once and processes the disposal first, so that path is JVM only. Device
  check of the restart gate instead: a foreign 3 MB `.part` on the path of a new 8 MiB download → truncated, one plain
  GET 200, completed with `restarts` 0, sha256 = server.

### Checks (f60e3bc0)
`tsc` 0 errors, `expo lint` 0 problems, engine jest 169/169 (5 suites), full jest 2,998/2,998 (295 suites), JS harness
11/11, JVM 98/98 (EngineTest 59, TransferTest 25, HttpPolicyTest 9, RedactionFuzzTest 3, ClockTest 2), Swift corpus
773/773, Swift engine host 87/87, Android lint (`NewApi` error) 0 errors. 10 new guard mutations caught (iOS 7: N6-01 1,
N6-02 3, N6-04 2, generation guard 1; Android 3).

### Builds
`/Volumes/DevSSD/Caches/streamarr-builds/dl-native-f60e3bc0/`: `Streamarr.app` (built at f60e3bc0) and
`streamarr-dev-arm64.apk` (built at cedc06e2; f60e3bc0 changes no Android source), README. `dl-native-bd8911dc` has a
`SUPERSEDED.txt`.

## Fix round 3f (verifier DL-N-verify7, final engine verdict "pass with findings": N7-01 minor, N7-02 nit)
Branch first fast-forwarded to `fb/downloads` (3a3d1cc6; no native changes). Verifier repros of
`tools/dl-verify-native/` (Swift round 7 "REPRO N7 …" with its control, JVM
`REPRO_N7_aDisposalLeavesItsDirectoryAndTheAncestorDownloadCannotPublish`) run as correct outcomes in the harness.

### Commits
- `ca88b62e` N7-01 (iOS): the engine's own Range continuation is protected like a fresh GET.
- `6ed69002` N7-02 (Android): emptied directories go with their partial, a directory path is refused; README for both.

### Empirical check first (host)
The cycle for an own continuation depends on how CFNetwork resumes a blob of a request that carried our own
`Range: bytes=K-`. A macOS command-line run against the test server (default session, 8 MiB file, K = 1 MiB,
cancelled for resume data after 786,432 bytes): the blob counts the 786,432 tail bytes, `didResumeAtOffset` reports
786,432 (relative), the resumed request is `Range: bytes=1835008-` (K + r, absolute) and the finished file is exactly
the server's bytes from K (sha256). The simulator's `nsurlsessiond` behaved the same (device runs below), and the engine
validates the resumed task's first 206 at exactly K + r anyway, so a different OS behaviour could only fail the cycle.

### N7 → fix and regression tests
- **N7-01 (iOS):** after a renewed URL (410 `download_expired`, security sign-out, in-task 4xx with kept bytes) the
  remainder runs as `Range: bytes=K-`. Before: an in-task 206 at its end was refused (the D-03 report was ignored for
  own continuations), no snapshots, no identity cycle; a reset cost everything after K.
  - Proof: `reported` = K + the task's own report (same task and generation); the N6-04 rule stays (a visible Range at
    or behind it yields, one ahead keeps its rule). A report of another generation or task, the relative report alone,
    another start or ETag prove nothing.
  - Identity cycle after 256 KiB of this request (remaining counted after K). Its blob names a file of only the bytes
    after K: they are cloned to `kept/<id>.snap` (`keptTailBytes`), and the task resumes from the blob at once as the
    next own continuation (`begin(ownBlob:)`), whose first 206 must start at K + `didResumeAtOffset`. The blob is never
    saved for a later `begin()`: a stop during the cycle (pause, new URL) keeps the snapshot and starts nothing; no
    blob or one of another ETag is one cycle failure and continues from the kept bytes.
  - Snapshots of the identified OS file go to the tail snapshot (cut to the report), like a fresh GET's.
  - Fallback: pause, failure, later in-task 4xx keep K + snapshot (`keptTotal`); `begin()` first joins the snapshot to
    the kept bytes off the engine queue (`foldTail`; handles opened on the queue, so a cancel and new start of the id
    never receive them), then continues after them.
  - Swift (8 new checks): the verifier's repro and control (continues, publishes, `restarts` 0); negatives; cycle +
    snapshot + later in-task 410 keeping K + snapshot + a renew continuing after them; cycle without / with a foreign
    blob; no cycle near the end; pause and new URL during the cycle. 12 mutations caught; redundant guards dropped
    (extra ETag check in the snapshot, snapshot reset at load and after assembly: `tailSnapshot()` re-checks the file).
    `folding.remove` in `forget()` is hygiene `finishFold` makes unobservable (no test can tell).
- **N7-02 (Android):** `start` refuses a path, or its `.part`, that is an existing directory (`invalid_state`) before
  any request. After a disposal, a cancel/remove or a drained worker of a gone task deletes a partial, emptied parent
  directories go up to the volume root, never one a registered download's path lies in (`claimKey` refuses the root and
  anything above; `delete()` refuses content: the two explicit checks I first wrote were redundant, their mutations
  survived, so they went). Tombstones own nothing, so their emptied directory goes too; the 1c tombstone test now pins
  that (its simulated leftover partial recreates the directory). JVM: the verifier's repro publishes the ancestor
  download; directory paths refused; pruning stops at content, another download's directory and the root. 7 mutations.

### Device verification (DL-N iPhone, iOS 26.5 simulator; mock engine on Metro 8099, test server 39320, 20 MiB files)
- **Renew, then reset on the continuation:** fresh GET cycled at 262,144, revoked after 1 MiB of its resumed response,
  in-task 410 → `failed 410`, 1,310,720 kept, `restarts` 0. Renewed URL: own continuation `bytes=1310720-`, reset after
  2 MiB; the engine cycled it and `nsurlsessiond` resumed the blob with `bytes=3407872-` (K + r; "identity cycle … at
  3407872 bytes, resumed with a 206 after 8 ms"); reset again after 2 MiB → in-task retry `bytes=5505024-` accepted
  ("in-task continuation at 5505024 proven by the bytes this task reported"). Completed, `restarts` 0, states
  running → completed without `retrying`, sha256 = server.
- **Later in-task 410 after the cycle:** revoked at 1 MiB → 1,572,864 kept; renewed (throttled): own continuation
  `bytes=1572864-` cycled, resumed `bytes=2097152-`, revoked after 3 MiB, in-task 410 at `bytes=5242880-` → `failed 410`
  with 5,242,880 bytes (kept 1,572,864 + 3,670,016 snapshot), `restarts` 0. Renewed again: `bytes=5242880-` (the
  snapshot joined first), cycled (`bytes=7340032-`), completed, sha256 = server.
- Android: N7-02 is JVM-only as decided.

### Checks (6ed69002)
`tsc` 0 errors, `expo lint` 0 problems, engine jest 169/169 (5 suites), full jest 3,037/3,037 (296 suites), JS harness
11/11, JVM 98 → 101 (ClockTest 2, EngineTest 62, HttpPolicyTest 9, RedactionFuzzTest 3, TransferTest 25), Swift corpus
773/773, Swift engine host 87 → 93, Android module lint 0 errors.

### Builds
`/Volumes/DevSSD/Caches/streamarr-builds/dl-native-6ed69002/` (README): `streamarr-dev-arm64.apk` and `Streamarr.app`,
both built at 6ed69002. `dl-native-f60e3bc0` has a `SUPERSEDED.txt`.

## Fix round 3g (verifier DL-N-verify8: N8-01 major, N8-02 minor, N8-03 nit; all iOS)
Branch at `fb/downloads` 1f06c43a; `fb/downloads` 52caf572 (core N8-03, reserved media names) merged in after the
fixes (e33c2b20). Verifier repros of `tools/dl-verify-native/` (Swift round 8 check 1 in both chains and check 2,
`guards8.py`, the host `replaceItemAt` run) run as correct outcomes in the harness.

### Commits
- `21328fcc` N8-01 + N8-02 (iOS): a tail snapshot is bound to its base; an interrupted append costs at most itself.
- `31409153` N8-03 (iOS): `start` refuses a directory path; the publish never replaces a directory; README.
- `e33c2b20` merge of `fb/downloads` 52caf572 (no native change).

### N8 → fix and regression tests
- **N8-01 (iOS, silent corruption):** a tail snapshot must only ever extend the exact kept bytes it was taken for.
  - Binding: `cloneTail` persists `tailBase = { offset: K, etag, generation }` with `kept/<id>.snap` (K = kept length,
    etag = the strong kept ETag, generation = the own continuation's `rangeGeneration`). `tailSnapshot()` (used by the
    fold, `keptTotal` and the snapshot tick) accepts it only if `keptLength == offset`, `keptEtag == etag` and
    `rangeGeneration == generation`; the identity cycle rebinds it to the resumed task's generation (the same kept
    bytes). A snapshot without a binding (written by 3f) is dropped: that download continues from its kept bytes.
  - Defence in depth, each one on its own observable: `cloneKept` ends any snapshot before new kept bytes replace the
    file; `finishAssembly` ends it whatever follows (also a failed publish or append); `load` drops an unbound one and
    an orphan `.snap`; `begin()` drops an unbound one before every request.
  - Swift (13 new checks): the verifier's chain in both variants (same process, relaunch) as correct outcome (fallback
    1,500, `bytes=1500-`, published = server's bytes) plus its state after the failed publish; the invariant "no
    published byte comes from a snapshot whose base differs from the kept length at fold time" as a matrix (other kept
    length, other ETag, other continuation, no binding: never folded, gone by the request, published exactly the
    server's bytes; snapshot bytes 0xEE so a fold would show) with a bound control that folds; one state check per
    defence guard; the cycle's snapshot surviving an in-task 410 right after the resume.
- **N8-02 (iOS, cost):** an in-place append (fold, Range assembly) never touches the first `keptBytes`.
  - At load a kept file longer than `keptBytes` (strong ETag) is cut back to `keptBytes` (truncate + fsync, one log
    line) and kept, with its snapshot if the binding still holds; shorter is dropped as before. `bytesWritten` follows.
  - A failed continuation append (`appendOrCut`) is cut back to K and retried from there (`retryable`, no longer
    `dropPartial`); the fold already cut back on failure.
  - `finishFold` persists the new kept length before deleting the `.snap` (a crash in between leaves an orphan, dropped
    at load). `cloneKept` with another ETag clears and persists the old kept bytes before the file is replaced, so the
    prefix N8-02 trusts is always the recorded entity's.
  - Swift (8 new checks): verifier check 2 with 200/500 and 500/500 appended (keeps 1,000 + the bound tail, folds
    again, `bytes=1500-`, exact bytes), the same with a 3f record (1,000 kept, tail dropped, `bytes=1000-`), a crash in
    the Range assembly (`bytes=1000-`), a shorter kept file still dropped, `appendOrCut`, a failed append retried with
    `bytes=1000-`, a failed clone with another ETag leaving no old kept bytes (persisted).
- **N8-03 (iOS, parity with N7-02):** `start` refuses a final or `.part` path that is an existing directory
  (`invalid_state`) before any request; `move()` (publish, staging, JS `move`) throws `invalid_state` onto a directory
  and only replaces a file or a missing target. Swift (3 new checks): start at a directory and at a `.part` directory;
  `move` onto a directory with content (content stays, source stays; the verifier's host case) and onto a file
  (replaced); a directory created at the target mid download fails the publish with "art is a directory", its
  content stays.
- Mutations (`/tmp/mut3g.py`, keep-going copy of the whole suite per variant): each one removed alone is caught —
  binding (whole: 6 checks; offset, ETag, generation: 1 matrix row each), `cloneKept` reset, `cloneKept` other-ETag clear,
  `finishAssembly` reset (both chains), load prune (3 checks), `begin()` prune (4 matrix rows), cycle rebind, load
  cut, append cut, append retry from K, start directory, start `.part` directory, move directory (2 checks). Not
  caught: the persist-before-remove order in `finishFold` (only a crash between the two lines tells; both orders are
  correct, this one keeps the tail): code reading only.
- Each defence alone against the verifier's chains (the other four mutated away):

  | only this guard | same process | across a relaunch |
  |---|---|---|
  | binding | fallback 1,500, `bytes=1500-`, exact | same |
  | `cloneKept` reset | exact | exact |
  | `finishAssembly` reset | exact | exact |
  | `begin()` prune | exact | exact |
  | load prune | **fallback 2,000, `bytes=2000-`, corrupt** | exact |
  | none of the five | **corrupt** | **corrupt** (the verifier's N8-01 reproduced) |

### Guards removed in 3f, status now
| Guard removed in 3f | Verifier round 8 | Now |
|---|---|---|
| iOS: tail-snapshot reset after assembly | not redundant (N8-01) | Back, stronger: `finishAssembly` ends the snapshot whatever follows (publish, failed publish, failed append, pause). Caught by both chains' state check and the failed-append check. |
| iOS: tail-snapshot reset at load | not redundant, not sufficient | Back, stronger: any snapshot whose binding does not hold and any orphan `.snap` go at load. Alone it covers only the relaunch chain (table above); caught by 3 checks. |
| iOS: extra ETag check in the snapshot | redundant | Still removed. The snapshot's own ETag is now part of its binding (`tailBase.etag == keptEtag`), a different rule; caught by its matrix row. |
| Android: "directory empty" check (pruning) | redundant | Still removed (`File.delete()` refuses content). |
| Android: "below root" check (pruning) | redundant | Still removed (`claimKey` refuses the root and anything above). |
| iOS: `folding.remove` in `forget()` (kept in 3f, untestable) | not reachable | Unchanged. |

### Device verification (DL-N iPhone, iOS 26.5 simulator; mock core on Metro 8099, test server 39320, 20 MiB files)
- **Renew, then resets on the continuation:** fresh GET cycled at 524,288, revoked after 1 MiB of its resumed response,
  in-task 410 → `failed 410` with 1,572,864 kept, `restarts` 0. Renewed URL: own continuation `bytes=1572864-`, reset
  after 2 MiB; cycled ("identity cycle … at 3145728 bytes, resumed with a 206 after 11 ms", request
  `bytes=3145728-`), reset again after 2 MiB → in-task retry `bytes=5242880-` accepted ("in-task continuation at
  5242880 proven by the bytes this task reported"). Completed, `restarts` 0, states running → completed without
  `retrying`, sha256 = server.
- **Later in-task 410 after the cycle:** revoked at 1 MiB → 1,310,720 kept; renewed (throttled): own continuation
  `bytes=1310720-` cycled at 1,572,864 (resumed `bytes=1572864-`), revoked after 3 MiB, in-task 410 at
  `bytes=4718592-` → `failed 410` with 4,718,592 (kept 1,310,720 + 3,407,872 snapshot, bound to the resumed
  generation), `restarts` 0. Renewed again: `bytes=4718592-` (the snapshot folded first), cycled at 8,781,408,
  completed, sha256 = server; `kept/` empty afterwards.
- **N8-03:** `start` onto the existing `n8` directory → `invalid_state`, no task, no request, its files intact.
- Not on a device: the N8-01 trigger (a failed final move, e.g. a full volume, then a fresh GET and an in-task 4xx)
  and N8-02's crash or jetsam mid append stay host/Swift only, as decided.

### Notes for the coordinator
- `types.ts` still says `move` "replaces the target". iOS now replaces a file but refuses a directory; Android's JS
  `move` and its publish use `Files.move` without `REPLACE_EXISTING`, so they refuse any existing target (pre-existing,
  unchanged). The fake does not model directories. No TS change in this round; the directory rule is in the module
  README for both platforms.

### Checks (e33c2b20)
`tsc` 0 errors, `expo lint` 0 problems, engine jest 169/169 (5 suites), full jest 3,081/3,081 (297 suites), JS harness
11/11, JVM 101/101 (ClockTest 2, EngineTest 62, HttpPolicyTest 9, RedactionFuzzTest 3, TransferTest 25; Range server
live), Swift corpus 773/773, Swift engine host 93 → 117, Android module lint 0 errors (4 warnings, unchanged).

### Builds
`/Volumes/DevSSD/Caches/streamarr-builds/dl-native-e33c2b20/` (README): `Streamarr.app` built at e33c2b20 and
`streamarr-dev-arm64.apk` (Gradle found every input unchanged since 6ed69002, so it is byte-identical to that APK).
`dl-native-6ed69002` has a `SUPERSEDED.txt`.

## Known limitations
- iOS: a download has no OS-file identity until its identity cycle ran (after 256 KiB, app in the foreground; also after
  a proven in-task continuation, N6-02): a loss in the first 256 KiB restarts from 0 unless the OS's in-task 206 starts
  exactly at the bytes the task reported (D-03; also when the file finishes before a report of it, N6-01, and for a
  task resumed from resume data, N6-04), as does a loss while the app stayed in the background since the start. Also without one: after two failed cycles,
  with a server that does not send `Accept-Ranges: bytes`, and in the first 256 KiB of a Range continuation (a pause
  or failure there keeps the bytes kept before it; after its cycle the last snapshot too, N7-01).
- iOS: the engine's own copy of a running download is refreshed only while the app runs (up to a second behind): if the
  app is suspended when a security sign-out revokes a running download, the bytes kept before the suspension survive
  (all of them restart from 0 only if the cycle had not run yet). Android keeps every fsynced byte. A Range
  continuation needs room for its remainder twice while it is appended.
- iOS simulator only: clock-change checks need a device (the simulator uses the Mac's clock).
- Android 14 emulator: after a background `kill -9` JobScheduler held the rescheduled job until the next state change
  (55 min once); the engine resumes correctly when it starts.
- Android: after a reboot (or with an unknown boot id) up to 5 s / 8 MiB of a running download is fetched again (only the
  synced checkpoint is trusted); on the same boot nothing is lost on internal storage. Removable media (SD card, USB)
  always resume from the last checkpoint, at load and when the volume returns: at most ~5 s / 8 MiB re-downloaded (N5-01).
- Android 14: after a volume returns while the app has no UI (the process vold killed was restarted by its job), the
  transfer continues when the app next comes to the foreground.
- Android: unmounting a volume while a download writes to it makes vold kill the app process (SIGINT); the job restarts
  it and the tasks wait for the volume (`volume_unavailable`, "Waiting for storage" note), their partials are kept or
  disposed as usual; a queued partial whose volume never returns is dropped after 7 days.
