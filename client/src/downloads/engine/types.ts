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

export type DownloadError = {
  kind: DownloadErrorKind;
  /** English, not localized (diagnostics only). */
  message: string;
  httpStatus?: number;
  /** The server's Retry-After (429/503) in ms when it sent one; `retryAt` on the task is the next attempt. */
  retryAfterMs?: number;
};

export type DownloadSpec = {
  /** Caller-chosen, unique and stable (the JS manager's download id). */
  id: string;
  /** GET target (capability URL); redirects are followed. */
  url: string;
  headers?: Record<string, string>;
  /** Final location under the volume root, e.g. `acc-1/work-42/Movie.mkv`; written as `<path>.part` until complete. */
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
  /** How often the transfer started over from 0 because the server's validator changed (If-Range answered with 200). */
  restarts: number;
  /** Failed attempts since the last progress. */
  attempts: number;
  /** Epoch ms of the next attempt while `retrying`. */
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
  /** `internal` (app-private internal storage) or `external-<n>` (Android app-specific dir on SD/USB storage). */
  id: string;
  uri: string;
  removable: boolean;
};

/** POST_NOTIFICATIONS (Android 13+); `granted` elsewhere, where no permission is needed. */
export type NotificationPermission = 'granted' | 'denied' | 'undetermined';

export type Subscription = { remove(): void };

export type DownloadEngine = {
  /** False on web, Apple TV and builds without the native module; every call then rejects with `not_supported`. */
  readonly isSupported: boolean;
  /** `file://` root of the internal volume (trailing slash); null where unsupported. */
  readonly rootUri: string | null;

  /** Free and total bytes of a volume (default internal). iOS: capacity for important usage. */
  storage(volumeId?: string): Promise<StorageInfo>;
  /** Internal first; Android adds app-specific dirs on removable/secondary storage. */
  volumes(): Promise<StorageVolume[]>;

  /** Queues a download. An existing id returns that task unchanged (call `resume` to continue it). */
  start(spec: DownloadSpec): Promise<DownloadTask>;
  pause(id: string): Promise<void>;
  /** Continues a paused or failed task from the bytes on disk; `update` swaps a renewed URL or headers. */
  resume(id: string, update?: { url?: string; headers?: Record<string, string> }): Promise<void>;
  /** Stops the task, deletes its partial file and forgets it. A completed file stays (delete it with `deletePath`). */
  cancel(id: string): Promise<void>;
  /** Forgets a finished (completed/failed) task after the caller recorded it; the file stays. */
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
  /** File or directory (recursive); missing is fine. */
  deletePath(relativePath: string, volumeId?: string): Promise<void>;
  /** Atomic rename within one volume (replaces the target). */
  move(fromRelativePath: string, toRelativePath: string, volumeId?: string): Promise<void>;
  /** Hex sha256 of a file (reads it whole: seconds for GBs). */
  sha256(relativePath: string, volumeId?: string): Promise<string>;
};

/** Stable codes of rejected calls: `error.code`, and the message starts with the code. */
export type DownloadEngineErrorCode =
  'not_supported' | 'not_found' | 'invalid_argument' | 'invalid_state' | 'io';

export type DownloadEngineError = Error & { code: DownloadEngineErrorCode };
