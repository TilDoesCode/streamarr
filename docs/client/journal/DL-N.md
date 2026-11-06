# DL-N — native download engine

Status: in-progress

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
- (none yet)

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
