# offline-downloads

Native download engine for offline playback (DL-N). JS entry and contract: `src/downloads/engine` (`downloadEngine`,
`types.ts`, in-memory `fake.ts`). Decision record and device evidence: `docs/client/journal/DL-N.md`.

## Model

- One HTTP(S) GET per file into `<root>/<relativePath>.part`, renamed to `<relativePath>` when complete (size checked).
  Store `relativePath` (+ `volumeId`), never absolute URIs: the iOS container path changes with app updates.
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
| 2xx / 206                                    | transfer (416 with a complete part = completed)                                                      |
| 408, 425, 429, 500–599                       | `retrying`, next attempt after Retry-After (delta-seconds or HTTP-date, ≤ 1 h) or 2 s → 60 s backoff |
| every other 4xx (403, 404, 409, 410, 416, …) | `failed` at once, `kind: 'http'`, `httpStatus`                                                       |
| network errors                               | `retrying` with backoff, `waiting_network` while offline                                             |

- A response with Retry-After does not use up an attempt (the server is up and schedules us); everything else counts
  toward 8 attempts without ≥ 1 MiB progress, then `failed` (`http` with the last status, or `network`).
- `410 download_expired`: renew on the server, then `resume(id)` (the capability URL stays the same); the bytes on disk are
  kept. 416 drops the partial file (it no longer fits), so `resume(id)` starts over.
- iOS: before spending resume data on a new GET the engine sends a HEAD with the same request; only a usable answer
  (2xx, or 405/501 = no HEAD support) starts the transfer, so a 503/429 never costs the partial file. Without a usable
  network the task is handed to nsurlsessiond directly (it waits, also while the app is suspended).
- Tests: jest (`http-policy.test.ts`), `cd client/android && ./gradlew :offline-downloads:testDebugUnitTest`,
  `cd client/modules/offline-downloads && xcrun swiftc -parse-as-library ios/HttpPolicy.swift
ios/Tests/HttpPolicyCheck.swift -o /tmp/http-policy && /tmp/http-policy`.

## Resume and validators

- Android: `Range: bytes=<part length>-` + `If-Range: <strong ETag>` (Last-Modified if there is no strong ETag; no
  validator → start over). `206` appends; `200` means the file changed: truncate and start over (`restarts` + 1); `416`
  with a complete part finishes. `Accept-Encoding: identity` keeps sizes exact.
- iOS: background `URLSession` download tasks. Pause/kill keep **resume data** (the OS resumes with Range + If-Range and
  starts over on a changed validator). A user swipe-kill cancels the session's tasks; on the next launch the engine
  continues them from the resume data. A changed URL or headers on `resume()` drops the resume data (fresh request).

## Platforms

- **Android 14+**: one user-initiated data transfer (UIDT) job (`DownloadJobService`, `RUN_USER_INITIATED_JOBS`) runs
  the whole queue with one progress notification. Its network constraint is INTERNET (+ NOT_METERED with Wi-Fi only),
  VPNs allowed, validation not required (LAN-only servers). JobScheduler restarts it after the process died and when
  the constraint is met again; once (Android TV 14 emulator) a job stayed ready but unstarted after a kill, so the visible
  app replaces a pending, unattached job (`onForeground`). UIDT jobs can only be scheduled while the app is visible: the
  engine schedules on `start`/`resume`/`setWifiOnly` and again when the app comes to the foreground.
- **Android ≤ 13** (and a fallback when the job cannot be scheduled): a `dataSync` foreground service
  (`DownloadService`, `START_STICKY`, partial wake lock) runs the queue and waits for the network itself.
- **Notifications** (Android): channel `offline_downloads` (low importance), strings in `res/values{,-de}`; a summary
  ("2 downloads finished") when the queue empties. `requestNotificationPermission()` asks for POST_NOTIFICATIONS on 13+;
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
  `volumes()` adds app-specific dirs on non-emulated (SD/USB) storage for boxes with little internal space; files there
  vanish with the medium and are readable only by this app.
- iOS: `Application Support/downloads`, `isExcludedFromBackup` on the root directory (which excludes everything below it,
  also files other code writes there, e.g. artwork via expo-file-system — Application Support is inside its allowed
  paths) and on every finished file; the root is recreated and excluded again on launch, `start()` and `storage()`.
  Free space is `volumeAvailableCapacityForImportantUsage`.
- `deletePath()` removes files and directories recursively on both platforms (missing is fine; the root itself is
  refused).
- `contentUriFor()` (Android, internal volume): FileProvider `content://<package>.offline-downloads/internal/…` with a
  read grant for another package (e.g. a separate player process).

## Test server

`node scripts/download-test-server.mjs --help` (port 39320, Android emulator: `http://10.0.2.2:39320`). Per-file status
rules: `/admin/fail?name=<substring>&status=429&count=2&retryAfter=40` (`retryAfter=date:40` sends an HTTP-date).
