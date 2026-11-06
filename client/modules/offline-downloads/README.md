# offline-downloads

Native download engine for offline playback (DL-N). JS entry and contract: `src/downloads/engine` (`downloadEngine`,
`types.ts`, in-memory `fake.ts`). Decision record and device evidence: `docs/client/journal/DL-N.md`.

## Model

- One HTTP(S) GET per file into `<root>/<relativePath>.part` (Android; iOS: the OS's temporary file), published as
  `<relativePath>` through **one validated completion path** (size = expected/known total, strong ETag = pinned/recorded)
  in the same step that reports `completed`. Store `relativePath` (+ `volumeId`), never absolute URIs: the iOS container
  path changes with app updates.
- **Ownership:** a task owns its canonical path (`a//b/./c` = `a/b/c`, case-insensitive) until `cancel`/`remove`; a second
  `start` on it, and `deletePath`/`move` touching an unfinished task's file, partial or directory, reject `invalid_state`.
  `cancel` resolves only after the worker ended (Android) and never lets that generation publish.
- **Headers:** only `Accept-Language` / `User-Agent` (JS and native reject others): capability URLs need none, and
  iOS background sessions follow redirects on their own, so a secret header could never be scoped there.
- The engine owns a persisted registry (`files/offline-downloads/state.json` on Android, `Application Support/offline-downloads`
  on iOS) and a native queue (`maxConcurrent`, default 2, 1–6). It keeps working while JS is not running; `list()`
  re-attaches, including tasks that completed or failed meanwhile. Finished tasks stay until `remove(id)`.
- Settings (`wifiOnly`, default true; `maxConcurrent`) are persisted natively, so the background queue honours them.

## States

| state             | meaning                                                                                                        | leaves by                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `queued`          | waits for a slot (or for the job/service to start)                                                             | engine                                          |
| `running`         | transferring                                                                                                   | engine                                          |
| `paused`          | `pause()`, or the user stopped the app's job in Android's task manager                                         | `resume()`                                      |
| `waiting_network` | no usable network                                                                                              | engine (network returns)                        |
| `waiting_wifi`    | Wi-Fi only is on and the network is metered (cellular, hotspot)                                                | engine (Wi-Fi/Ethernet), `setWifiOnly(false)`   |
| `retrying`        | transient failure (reset, timeout, 408/425/429/5xx); `retryAt` is the next attempt (Retry-After or 2 s → 60 s) | engine                                          |
| `completed`       | file at `uri`                                                                                                  | `remove()`                                      |
| `failed`          | `error.kind`; after 8 attempts without ≥ 1 MiB progress, or a non-retryable error                              | `resume()` (from the bytes on disk), `cancel()` |
| `cancelled`       | state event only: the task and its partial file are gone                                                       | –                                               |

Error kinds: `network`, `http` (+ `httpStatus`, + `retryAfterMs` when the server sent Retry-After), `disk_full` (free
space < remaining + 64 MB before the start, or ENOSPC), `validator_changed` (ETag ≠ `spec.etag`), `size_mismatch`
(server size ≠ `expectedBytes`), `file_system`.

## HTTP statuses

One table on all three sides (`src/downloads/engine/http-policy.ts`, `android/…/HttpPolicy.kt`, `ios/HttpPolicy.swift`):

| status                                       | engine                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 2xx / 206                                    | transfer (a 206 only when it continues the same strong ETag, see below)                              |
| 408, 425, 429, 500–599                       | `retrying`, next attempt after Retry-After (delta-seconds or HTTP-date, ≤ 1 h) or 2 s → 60 s backoff |
| every other 4xx (403, 404, 409, 410, 416, …) | `failed` at once, `kind: 'http'`, `httpStatus`                                                       |
| network errors                               | `retrying` with backoff, `waiting_network` while offline                                             |

- A response with Retry-After does not use up an attempt (the server is up and schedules us); everything else counts
  toward 8 attempts without ≥ 1 MiB progress, then `failed` (`http` with the last status, or `network`).
- Retry-After waits at least 2 s and at most 1 h; server-directed waiting without any byte progress ends after 12 h
  (`failed http` with the last status and `retryAfterMs`). A pending `retryAt` survives network changes (the task shows
  `waiting_*` and returns to `retrying` until it is due). An invalid 206 is an ordinary attempt.
- `410 download_expired`: renew on the server, then `resume(id)` (the capability URL stays the same); the bytes on disk are
  kept. 416 drops the partial file, so `resume(id)` starts over.
- iOS: before spending resume data on a new GET the engine sends a HEAD with the same request; only a usable answer
  (2xx, or 405/501 = no HEAD support) starts the transfer. Without a usable network the task is handed to nsurlsessiond
  directly (it waits, also while the app is suspended).
- Tests: jest (`http-policy.test.ts`), `cd client/android && ./gradlew :offline-downloads:testDebugUnitTest`,
  `cd client/modules/offline-downloads && xcrun swiftc -parse-as-library ios/HttpPolicy.swift
ios/Tests/HttpPolicyCheck.swift -o /tmp/http-policy && /tmp/http-policy`.

## Resume and validators

- Android appends **only** to bytes proven to be the same file: `Range: bytes=<part length>-` + `If-Range: <strong
ETag>`, and the 206 must carry that strong ETag (and the pinned one, if any) and a complete `Content-Range: bytes
<offset>-<total−1>/<total>` whose total equals the known total and `expectedBytes`. Anything else drops the partial:
  pinned ETag differs or is missing → `failed validator_changed`; otherwise an ordinary retry from 0 (`restarts` + 1). A
  weak or missing validator never resumes. `200` restarts: the partial is truncated and fsynced **before** the new
  validator is recorded, so the registry never describes other bytes. A complete part is re-validated by fetching its
  last byte. Every `416` fails (`http 416`) and drops the partial.
- Android durability: the part is fsynced every 16 MiB and at the end; only fsynced bytes are checkpointed, and after a
  crash recovery keeps that prefix. The registry is written temp → fsync → rename → directory fsync.
- iOS: background `URLSession` download tasks with **resume data** (the OS resumes with Range + If-Range). Every task
  carries `id#generation`; callbacks count only for the current generation in its session. The response is validated
  (status, pinned/strong ETag, Content-Range, sizes) on the first progress of each generation, again after a relaunch
  (adopted tasks) and again at the final callback before anything is published. Resume data stays until the resumed
  response is validated: transient answers (429/5xx, network) keep it; `416`, `validator_changed` and `size_mismatch`
  drop it. A pause racing the final callback keeps the task paused with the file staged; `resume()` completes it.
  A task that finished while the app was not running is adopted when iOS relaunches the app to deliver it (also when
  its events arrive before or without `getAllTasks`; 30 s watchdog) and published, never fetched again.
- iOS limits: a user force quit cancels the session's tasks; the next launch continues from the resume data. Before
  spending resume data the engine sends a HEAD (under a background-task assertion; when it expires the GET goes to the
  background session without it). The HEAD lowers but cannot rule out a 429/503 on the following GET; the OS then
  discards its partial file (seen on the iOS 26.5 simulator: HEAD 200, GET 503, next GET without Range), so the next
  attempt starts over (`restarts` + 1). Redirects are followed by the OS.

## Platforms

- **Android 14+**: one user-initiated data transfer (UIDT) job (`DownloadJobService`, `RUN_USER_INITIATED_JOBS`) runs
  the whole queue with one progress notification. Its network constraint is INTERNET (+ NOT_METERED with Wi-Fi only),
  VPNs allowed, validation not required (LAN-only servers). JobScheduler restarts it after the process died and when
  the constraint is met again; once (Android TV 14 emulator) a job stayed ready but unstarted after a kill, so the visible
  app replaces a pending, unattached job (`onForeground`). UIDT jobs can only be scheduled while the app is visible: the
  engine schedules on `start`/`resume`/`setWifiOnly` and again when the app comes to the foreground.
- **Android ≤ 13** (and a fallback when the job cannot be scheduled): a `dataSync` foreground service
  (`DownloadService`, `START_STICKY`, partial wake lock) runs the queue and waits for the network itself.
- **User stop** (Android): Task Manager "Stop" kills the process without `onStopJob`; the next start reads the exit
  history (Android 11+, `REASON_USER_REQUESTED` / `REASON_USER_STOPPED`) and pauses every unfinished task (no automatic
  restart until `resume`). A job stopped with `STOP_REASON_USER` pauses everything (also `retrying`) and is not
  rescheduled; other kills re-queue as before.
- **Notifications** (Android): channel `offline_downloads` (low importance), strings in `res/values{,-de}`; actions
  **Pause** / **Cancel** (every unfinished download; the engine then emits `paused` / `cancelled` the app did not
  request); a tap opens `streamarr://downloads` (the app start where nothing handles it); a summary ("2 downloads
  finished") when the queue empties. `requestNotificationPermission()` asks for POST_NOTIFICATIONS on 13+;
  without it the transfer still runs (the notification is hidden).
- **iOS/iPadOS**: no Info.plist keys or background modes are needed (background URLSession). The AppDelegate hook
  (`handleEventsForBackgroundURLSession`) is an `ExpoAppDelegateSubscriber`. Two sessions: `…offline-downloads.wifi`
  (no expensive/constrained networks) and `…offline-downloads.any`; changing Wi-Fi only moves running tasks over with
  their resume data. Concurrency is the engine's own queue (tasks are created only for free slots; iOS wakes the app in
  the background when one finishes, and the next one starts then).
- **Apple TV / web**: `isSupported: false` (no durable storage for large files on tvOS; no downloads on web).

## Storage

- Android: `filesDir/downloads` (internal, app-private, not cache). Auto Backup does not include it: the app's backup
  rules (expo-secure-store `configureAndroidBackup`) only include shared preferences — a test guards this.
  `volumes()` adds app-specific dirs on mounted SD/USB volumes with the id `volume-<StorageVolume UUID>` (stable per
  medium, never reassigned). A missing volume fails its unfinished tasks with `file_system` / `volume_unavailable`; they
  continue by themselves when it is mounted again (mount broadcasts, foreground, pump).
- iOS: `Application Support/downloads`, `isExcludedFromBackup` on the root directory (which excludes everything below it,
  also files other code writes there, e.g. artwork via expo-file-system — Application Support is inside its allowed
  paths) and on every finished file; the root is recreated and excluded again on launch, `start()` and `storage()`.
  Free space is `volumeAvailableCapacityForImportantUsage` (plain available capacity where a volume reports 0).
- Free space: a transfer needs its remaining bytes plus those of every other running transfer on the volume plus 64 MiB;
  checked before writing and again every 64 MiB (else `disk_full`, partial and resume data kept).
- `deletePath()` removes files and directories recursively on both platforms (missing is fine; the root itself is
  refused).
- `contentUriFor()` (Android, internal volume): FileProvider `content://<package>.offline-downloads/internal/…` with a
  read grant for another package (e.g. a separate player process).

## Test server

`node scripts/download-test-server.mjs --help` (port 39320, Android emulator: `http://10.0.2.2:39320`). Per-file status
rules: `/admin/fail?name=<substring>&status=429&count=2&retryAfter=40` (`retryAfter=date:40` sends an HTTP-date).
