// Native download engine (DL-N); state and error semantics: client/modules/offline-downloads/README.md.

export type DownloadState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting_network'
  | 'waiting_wifi'
  | 'retrying'
  | 'completed'
  | 'failed'
  /**
   * After `cancel(id)`: state event only, the task is forgotten. Cancelled outside the app (Android notification):
   * a tombstone in `list()` (bytes 0, no error, partial deleted, path free) until `remove(id)`, also across restarts.
   */
  | 'cancelled';

export type DownloadErrorKind =
  | 'network'
  | 'http'
  | 'disk_full'
  | 'validator_changed'
  | 'size_mismatch'
  | 'file_system'
  | 'cancelled'
  | 'unknown';

/**
 * `file_system` with message `volume_unavailable`: the task's SD card / USB volume is missing; the engine continues the
 * task by itself when the volume returns (ids are never reassigned to another medium).
 */
export type DownloadError = {
  kind: DownloadErrorKind;
  /** English, not localized (diagnostics only), except the stable `volume_unavailable`. */
  message: string;
  httpStatus?: number;
  /** The server's Retry-After (408/425/429/5xx) as the wait in ms (2 s … 1 h); `retryAt` on the task is the next attempt. */
  retryAfterMs?: number;
};

export type DownloadSpec = {
  /** Caller-chosen, unique and stable (the JS manager's download id). */
  id: string;
  /** GET target (capability URL). Redirects: same origin keeps the headers, another origin drops them, https→http fails. */
  url: string;
  /** Only `Accept-Language` / `User-Agent`; anything else rejects with `invalid_argument` (capability URLs need none). */
  headers?: Record<string, string>;
  /**
   * Final location under the volume root, e.g. `acc-1/work-42/Movie.mkv`; written as `<path>.part` until complete, so
   * a path ending in `.part`, or with a segment ending in a dot or space (FAT/exFAT drop those), rejects with
   * `invalid_argument`. The task owns both paths (case-insensitive, trailing dots/spaces ignored) until `cancel`/`remove`
   * and while its transfer is still ending: another task whose path equals either of them, lies below them or is a
   * directory above them rejects with `invalid_state` (a `cancelled` tombstone owns nothing). So does a path (or its
   * `.part`) that is an existing directory; one that appears there later fails the task at publish (`file_system`,
   * message `invalid_state: <name> is a directory`, not retried).
   */
  relativePath: string;
  /** Exact size if known: checked against the server's size and used for the free-space check before the start. */
  expectedBytes?: number;
  /** Strong ETag the file must have; a different one fails with `validator_changed` instead of downloading another file. */
  etag?: string;
  /** Android notification line (e.g. "Sherlock · S2 E3"). */
  notificationTitle?: string;
  /** Storage volume (`volumes()`), default `internal`. */
  volumeId?: string;
};

export type DownloadTask = {
  id: string;
  url: string;
  relativePath: string;
  volumeId: string;
  /** `file://` of the final file (exists once `completed`). Resolve again after an app update: iOS container paths change. */
  uri: string;
  state: DownloadState;
  bytesWritten: number;
  /** Null until the server reported a size (and no `expectedBytes`). */
  totalBytes: number | null;
  /** Validator of the bytes on disk (from the first response). */
  etag: string | null;
  /**
   * How often the download lost every byte it had and started over from 0: a changed validator (If-Range answered with
   * 200), an unusable partial or resume data, 416, or a partial file deleted between launches (D-02, N5-02).
   */
  restarts: number;
  /** Ordinary failed attempts since the last MiB of progress (8 → `failed`); Retry-After answers do not count. */
  attempts: number;
  /** Epoch ms of the next attempt while `retrying` (display: the wait runs on a clock wall-clock changes cannot move). */
  retryAt?: number;
  error?: DownloadError;
  createdAt: number;
  updatedAt: number;
};

export type DownloadProgressEvent = {
  id: string;
  bytesWritten: number;
  totalBytes: number | null;
  /** Smoothed over the last seconds. */
  bytesPerSecond: number;
};

export type DownloadStateEvent = { id: string; state: DownloadState; task: DownloadTask };

export type DownloadSettings = {
  /** Default true: only unmetered networks (Wi-Fi, Ethernet). */
  wifiOnly: boolean;
  /** Default 2, 1–6. Tasks beyond it stay `queued`. */
  maxConcurrent: number;
};

export type StorageInfo = { freeBytes: number; totalBytes: number };

export type StorageVolume = StorageInfo & {
  /** `internal` (app-private internal storage) or `volume-<uuid>` (Android app-specific dir on an SD card / USB volume). */
  id: string;
  uri: string;
  removable: boolean;
};

/** POST_NOTIFICATIONS (Android 13+); `granted` elsewhere, where no permission is needed. */
export type NotificationPermission = 'granted' | 'denied' | 'undetermined';

export type Subscription = { remove(): void };

/**
 * The engine's clock (N2-04): it ignores every wall-clock change (NTP, the user), so durations measured with it survive
 * a clock correction. Compare `elapsedMs` values only under the same `bootId`.
 */
export type EngineClock = {
  /** Sleep-inclusive ms since boot: Android `SystemClock.elapsedRealtime()`, iOS `mach_continuous_time`. */
  elapsedMs: number;
  /**
   * Changes on every reboot, never with the wall clock. Android: `/proc/sys/kernel/random/boot_id` (else
   * `Settings.Global.BOOT_COUNT`); iOS: `kern.bootsessionuuid` (else `kern.boottime`). The unsupported stub and a native
   * module without `clock` use a per-process id with `performance.now()`.
   */
  bootId: string;
};

export type DownloadEngine = {
  /** False on web, Apple TV and builds without the native module; every call then rejects with `not_supported`. */
  readonly isSupported: boolean;
  /** `file://` root of the internal volume (trailing slash); null where unsupported. */
  readonly rootUri: string | null;

  /** Synchronous and never throws, also unsupported (see `EngineClock`). */
  clock(): EngineClock;

  /** Free and total bytes of a volume (default internal). iOS: capacity for important usage. */
  storage(volumeId?: string): Promise<StorageInfo>;
  /** Internal first; Android adds app-specific dirs on removable/secondary storage. */
  volumes(): Promise<StorageVolume[]>;

  /**
   * Queues a download. An existing id returns that task unchanged (call `resume` to continue it), also a `cancelled`
   * tombstone: `remove` it first to download again under the same id.
   */
  start(spec: DownloadSpec): Promise<DownloadTask>;
  pause(id: string): Promise<void>;
  /** Continues a paused or failed task from the bytes on disk; `update` swaps a renewed URL or headers. */
  resume(id: string, update?: { url?: string; headers?: Record<string, string> }): Promise<void>;
  /**
   * Stops the task and resolves once its transfer has ended; deletes its partial file and forgets it (no tombstone), so
   * the path is free afterwards. A completed file stays (delete it with `deletePath`). A tombstone is forgotten; if its
   * transfer is still ending (a notification Cancel that timed out), `cancel` waits for it like `remove` does.
   * If the transfer has not ended after 30 s, rejects with `io` / `cancel_pending`: the cancel continues and the path
   * stays claimed; calling `cancel(id)` again waits again and resolves once it ended.
   */
  cancel(id: string): Promise<void>;
  /**
   * Forgets a finished (completed/failed) task or a `cancelled` tombstone after the caller recorded it; a completed file
   * stays, a failed task's partial is deleted. Resolves once a transfer still ending for it (e.g. stopped by a missing
   * volume) has ended; after 30 s rejects with `io` / `remove_pending` (call again). Idempotent: an unknown id resolves.
   */
  remove(id: string): Promise<void>;
  /** Every task the engine knows, including ones finished while JS was not running. */
  list(): Promise<DownloadTask[]>;
  get(id: string): Promise<DownloadTask | null>;

  getSettings(): Promise<DownloadSettings>;
  setWifiOnly(wifiOnly: boolean): Promise<void>;
  setMaxConcurrent(maxConcurrent: number): Promise<void>;

  getNotificationPermission(): Promise<NotificationPermission>;
  /** Android 13+: asks once (the system remembers a denial). */
  requestNotificationPermission(): Promise<NotificationPermission>;

  /** About every 500 ms per running task; after a `completed` state event exactly one final progress event follows. */
  addProgressListener(listener: (event: DownloadProgressEvent) => void): Subscription;
  addStateListener(listener: (event: DownloadStateEvent) => void): Subscription;

  /** `file://` for a path under a volume root (no I/O). */
  uriFor(relativePath: string, volumeId?: string): string;
  /** Android: `content://` (FileProvider) for another app's player, read access granted to `grantPackage`; null on iOS. */
  contentUriFor(
    relativePath: string,
    options?: { volumeId?: string; grantPackage?: string }
  ): Promise<string | null>;
  exists(relativePath: string, volumeId?: string): Promise<boolean>;
  /** Size in bytes, null if missing. */
  fileSize(relativePath: string, volumeId?: string): Promise<number | null>;
  /**
   * File or directory (recursive); missing is fine. `invalid_state` if it touches the final or `.part` path of any
   * registered task that is not completed (queued, running, waiting, retrying, paused, failed) or still draining; a
   * completed file and a tombstone's path are the caller's.
   */
  deletePath(relativePath: string, volumeId?: string): Promise<void>;
  /**
   * Atomic rename within one volume: replaces an existing file; a directory target (an empty one too) rejects with
   * `invalid_state`, and so does a path under the same rule as `deletePath`.
   */
  move(fromRelativePath: string, toRelativePath: string, volumeId?: string): Promise<void>;
  /** Hex sha256 of a file (reads it whole: seconds for GBs). */
  sha256(relativePath: string, volumeId?: string): Promise<string>;
};

/** Stable codes of rejected calls: `error.code`, and the message starts with the code. */
export type DownloadEngineErrorCode =
  'not_supported' | 'not_found' | 'invalid_argument' | 'invalid_state' | 'io';

export type DownloadEngineError = Error & { code: DownloadEngineErrorCode };
