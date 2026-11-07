import type { DeviceProfile } from '@modules/media-caps';

import { isAppError } from '@/api/errors';
import { DEFAULT_RESUME_RULES, resumePointOf, type ResumeRules } from '@/lib/resume-rules';
import { serverNow, serverOfAccountKey, serverStamp } from '@/lib/server-clock';
import type {
  DownloadEngine,
  DownloadError,
  DownloadSettings as EngineSettings,
  DownloadTask,
  StorageInfo,
} from '@/downloads/engine';

import { artworkExtension, type ArtworkFetcher } from './artwork';
import { allowedAgain, isBlockedDownload } from './blocked';
import { accessVerified } from './library';
import {
  ARTWORK_FOLDER,
  downloadFolder,
  filePathOf,
  newDownloadId,
  normalizeSeasonId,
  workPartsOf,
} from './keys';
import type { DownloadsServerApi } from './server';
import type { CleanupJob, DownloadStore } from './store';
import type {
  DownloadRequestItem,
  DownloadResponse,
  DownloadSettings,
  LocalPosition,
  OfflineArtwork,
  OfflineDownload,
  OfflineDownloadError,
  OfflineDownloadState,
  ViewerPolicy,
} from './types';

/** Server preparations in flight per device; the rest stay `queued`. */
export const MAX_PREPARING = 2;
/** Long-poll wait of `GET …/downloads/{id}` (the server caps it at 10 s). */
export const PREPARE_WAIT_MS = 10_000;
/** Pause between polls that came back early (the server's `pollAfterMs` wins when larger). */
export const MIN_POLL_GAP_MS = 1_000;
/** Kept free on top of what queued downloads still need. */
export const STORAGE_RESERVE_BYTES = 256 * 1024 ** 2;
/** Waiting on the server: first retry, doubled up to the cap. */
export const SERVER_RETRY_MS = 30_000;
export const SERVER_RETRY_MAX_MS = 5 * 60_000;
/** Re-check of `waiting_space` downloads while the app runs. */
export const SPACE_RECHECK_MS = 60_000;
/** A link this close to `expiresAt` counts as expired (clock skew between device and server). */
const RENEW_SKEW_MS = 5 * 60_000;
/** File links of unfinished downloads are renewed this long before they expire (they live 30 days). */
export const RENEW_AHEAD_MS = 3 * 24 * 3_600_000;

const ACTIVE: readonly OfflineDownloadState[] = [
  'queued',
  'preparing',
  'downloading',
  'paused',
  'waiting_wifi',
  'waiting_network',
  'waiting_server',
  'waiting_space',
  'waiting_volume',
  'verifying',
];

export const isActiveDownload = (download: OfflineDownload) => ACTIVE.includes(download.state);
/** A profile with age rules: only such a profile needs a download's age verdict. */
const restricted = (policy: ViewerPolicy) => policy.maxAge !== null || policy.blockUnrated;
/** Unsaved preparations wait this long at most for the launch list (a POST sent again is idempotent anyway). */
export const ADOPT_WAIT_MS = 10_000;
/** Prepared on the server perhaps, but its answer was never saved here. */
const isUnsaved = (download: OfflineDownload) =>
  !download.downloadId && !isPrepared(download) && !isRemovingDownload(download);
/** States a preparation can be left in when the app died before it saved the server's answer. */
const ADOPTABLE: readonly OfflineDownloadState[] = ['queued', 'preparing', 'waiting_server'];
/** Device ids compare trimmed and ASCII case-insensitively (older server rows report them lower-cased). */
export const sameDevice = (a: string | null | undefined, b: string) =>
  a != null && asciiLower(a.trim()) === asciiLower(b.trim());
const asciiLower = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
/** States a dropped continuation can leave stuck (the waits move on by themselves, pause is the viewer's). */
const TRANSFERRING: readonly OfflineDownloadState[] = ['queued', 'preparing', 'downloading'];
/** Being deleted: shown subdued without actions, never counted, never downloaded again until it is gone. */
export const isRemovingDownload = (download: Pick<OfflineDownload, 'state'>) =>
  download.state === 'removing';
/** The server prepared it: the engine transfers (or transferred) the file. */
export const isPrepared = (download: OfflineDownload) =>
  download.relativePath !== null && download.sizeBytes !== null && download.engine !== null;
/** Bytes this download still needs on the device. */
export const remainingBytes = (download: OfflineDownload) =>
  download.state === 'done' || download.state === 'failed' || download.state === 'removing'
    ? 0
    : Math.max(0, (download.sizeBytes ?? download.estimatedBytes ?? 0) - download.bytesWritten);

export type DownloadManagerDeps = {
  engine: DownloadEngine;
  store: DownloadStore;
  /** Server calls of an owner; null while no signed-in profile of that key is on this device. */
  serverFor(accountKey: string): DownloadsServerApi | null;
  deviceProfile(): Promise<DeviceProfile>;
  deviceName?(): string;
  artwork: ArtworkFetcher;
  /** Android notification line (localized by the caller). */
  notificationTitle?(download: OfflineDownload): string;
  now?(): number;
  /** Shortens the long-poll and the gap between polls in tests. */
  prepareWaitMs?: number;
  pollGapMs?: number;
  /** Gap before a cancel/remove whose transfer is still ending is asked again (tests shorten it). */
  pendingRetryMs?: number;
  /** How long unsaved preparations wait for the launch list (default `ADOPT_WAIT_MS`). */
  adoptWaitMs?: number;
  /** How long a sign-out with "Delete downloads" waits for the server (tests shorten it). */
  signOutFlushMs?: number;
  /** The resume thresholds a profile's server last sent; null = never sent (its defaults apply). */
  resumeRules?(accountKey: string): ResumeRules | null;
};

type Listener = () => void;
const IO_CODE = 'io';
/** The reason shown while the engine waits to retry (Retry-After of 429/503, other 5xx, the network). */
function retryCode(error: DownloadError): string {
  if (error.httpStatus === 429) return 'too_many_downloads';
  if (error.httpStatus === 503) return 'download_source_unavailable';
  return error.kind === 'http' ? 'http' : 'network';
}

/** `restartReason` of the viewer's Retry: prepared anew, without a restart error or count. */
const RETRY_REASON = 'retry';
/** `restartReason` when the server already holds this download as completed (e.g. a reinstall). */
const SERVER_COMPLETED_REASON = 'server_completed';
/** Restarts that are no fault of the transfer: no restart error once prepared anew. */
const QUIET_RESTARTS = new Set([RETRY_REASON, SERVER_COMPLETED_REASON]);
/** The server no longer holds a usable record: Retry prepares the download anew. */
const PREPARE_AGAIN = new Set([
  'file_missing',
  'download_not_found',
  'unknown_download',
  'download_not_ready',
  'download_expired',
  'download_source_gone',
]);

/** The engine's `file_system` message for a removable volume that is not mounted (the download waits for it). */
export const VOLUME_UNAVAILABLE = 'volume_unavailable';
/** Never retry sooner than this, whatever Retry-After says (the engine's own floor). */
export const MIN_RETRY_MS = 2_000;
/** Nor later than this (the engine caps Retry-After at 1 h). */
export const MAX_RETRY_MS = 3_600_000;
/** A `cancelled` event this soon after the manager's own cancel is that cancel, not the viewer's. */
const OWN_CANCEL_MS = 30_000;
/** First gap between the calls of a cancel/remove whose transfer is still ending (each call itself waits up to 30 s). */
export const PENDING_RETRY_MS = 1_000;
/** The gap doubles per pending answer up to 30 × the first one. */
export const pendingRetryDelay = (attempts: number, base = PENDING_RETRY_MS) =>
  Math.min(base * 30, base * 2 ** Math.max(0, attempts - 1));
/** Sign-out with "Delete downloads" tells the server for at most this long while its session still works. */
export const SIGN_OUT_FLUSH_MS = 5_000;
/** At most this many DELETEs of one profile are in flight at once. */
export const DELETE_CONCURRENCY = 4;
/** A DELETE without an answer by then stays queued; the flush moves on (fetch itself may never time out). */
export const DELETE_TIMEOUT_MS = 30_000;
/** The engine's answers when a stopped transfer has not ended yet (`io: cancel_pending`): asked again, never a failure. */
const PENDING_STOPS = ['cancel_pending', 'remove_pending'];
/** A cleanup job waiting for its volume (persisted as a number: JSON has no Infinity). */
const AT_MOUNT = Number.MAX_SAFE_INTEGER;
/** First retry of an unanswered age verdict check; it doubles up to an hour. */
export const ACCESS_RETRY_MS = 60_000;
/** A failed request is asked again within the hour; a server that cannot rate the title at least daily. */
export const ACCESS_RETRY_MAX_MS = 3_600_000;
export const UNRATEABLE_RETRY_MAX_MS = 24 * 3_600_000;
const accessRetryDelay = (attempts: number, max = ACCESS_RETRY_MAX_MS) =>
  Math.min(max, ACCESS_RETRY_MS * 2 ** Math.max(0, attempts - 1));
/** First retry of a failed file cleanup; it doubles up to an hour. */
export const CLEANUP_RETRY_MS = 30_000;
const cleanupRetryDelay = (attempts: number) =>
  Math.min(3_600_000, CLEANUP_RETRY_MS * 2 ** Math.max(0, attempts - 1));
/** Engine tasks that are forgotten with `remove`; anything else is cancelled. */
const FINISHED_TASK: readonly DownloadTask['state'][] = ['completed', 'failed', 'cancelled'];
/** Statuses the engine retries natively; after its deadline they wait here instead of failing. */
const isRetriableStatus = (status: number) =>
  status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
/** States a late engine event (a final progress after `completed`) must never turn back into a transfer. */
const SETTLED: readonly OfflineDownloadState[] = ['verifying', 'done', 'failed', 'removing'];

/** A blocked download asks the server again at most this often, unless the permissions just changed. */
export const UNBLOCK_GAP_MS = 60_000;

/** The file URL's own 403 reasons (docs/api.md § 14); `renew` answers them with the same checks. */
const FORBIDDEN_CODES: ReadonlySet<string> = new Set(['downloads_not_allowed', 'age_restricted']);

/** Resolves after `ms` or on abort, whichever comes first; leaves no listener behind. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/** Retry-After as a delay (at least `MIN_RETRY_MS`); undefined keeps the manager's own backoff. */
function retryDelay(retryAfterMs: number | undefined): number | undefined {
  return retryAfterMs === undefined
    ? undefined
    : Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, retryAfterMs));
}

function errorOf(
  code: string,
  at: number,
  extra: Partial<OfflineDownloadError> = {}
): OfflineDownloadError {
  return { code, at, ...extra };
}

function engineCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** Exactly `io` with `cancel_pending` / `remove_pending`; any other `io` is a real error. */
export function isPendingStop(error: unknown): boolean {
  if (engineCode(error) !== IO_CODE || !(error instanceof Error)) return false;
  return PENDING_STOPS.some(
    (detail) => error.message === `${IO_CODE}: ${detail}` || error.message === detail
  );
}

const workRemoving = () => Object.assign(new Error('work_removing'), { code: 'work_removing' });

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `work`'s value, or `fallback` if it fails or takes longer than `ms`; leaves no timer behind. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const settle = (value: T) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(settle, () => settle(fallback));
  });
}

/** The device's download queue (prepare → transfer → size check → complete), stored first at every step so a kill never loses it. */
export class DownloadManager {
  readonly store: DownloadStore;
  private readonly engine: DownloadEngine;
  private readonly deps: DownloadManagerDeps;
  private readonly now: () => number;
  private readonly polls = new Map<string, AbortController>();
  private readonly busy = new Set<string>();
  private readonly backoff = new Map<string, number>();
  /** Downloads that started over once after a 416 in this session. */
  private readonly restartedRange = new Set<string>();
  private readonly snapshots = new Map<string, Promise<void>>();
  /** Completions the server refused with `size_mismatch` in this session (not repeated until the next launch). */
  private readonly completeRejected = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private subscriptions: { remove(): void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private spaceTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(deps: DownloadManagerDeps) {
    this.deps = deps;
    this.engine = deps.engine;
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
  }

  get supported(): boolean {
    return this.engine.isSupported;
  }

  /** Subscribes to the engine, pushes the stored settings and reconciles; returns the detach function. */
  attach(): () => void {
    if (!this.supported) return () => undefined;
    this.disposed = false;
    this.subscriptions = [
      this.engine.addStateListener((event) => void this.onTask(event.task)),
      this.engine.addProgressListener((event) => {
        const record = this.store.get(event.id);
        if (!record || SETTLED.includes(record.state)) return;
        this.store.update(
          event.id,
          {
            bytesWritten: event.bytesWritten,
            ...(event.totalBytes && !record.sizeBytes ? { sizeBytes: event.totalBytes } : null),
            ...(record.state !== 'downloading' && record.state !== 'paused'
              ? { state: 'downloading' as const, error: null, retryAt: null }
              : null),
          },
          { persist: record.state === 'downloading' ? false : true }
        );
        this.store.setLive(event.id, { bytesPerSecond: event.bytesPerSecond });
      }),
    ];
    this.spaceTimer = setInterval(() => void this.recheckSpace(), SPACE_RECHECK_MS);
    void this.syncSettings();
    void this.reconcile();
    return () => this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.subscriptions.forEach((subscription) => subscription.remove());
    this.subscriptions = [];
    this.polls.forEach((controller) => controller.abort());
    this.polls.clear();
    if (this.timer) clearTimeout(this.timer);
    if (this.spaceTimer) clearInterval(this.spaceTimer);
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    if (this.adoptTimer) clearTimeout(this.adoptTimer);
    this.accessTimers.forEach((timer) => clearTimeout(timer));
    this.accessTimers.clear();
    this.cleanupTimer = null;
    this.adoptTimer = null;
    this.timer = null;
    this.spaceTimer = null;
    this.store.flush();
  }

  /** Fires after every manager-side step (tests await quiet states through it). */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  private set(id: string, patch: Partial<OfflineDownload>): OfflineDownload | undefined {
    const current = this.store.get(id);
    // Being removed: late server answers and engine events never bring it back.
    if (!current || isRemovingDownload(current)) return current;
    const next = this.store.update(id, patch);
    if (patch.state && patch.state !== 'waiting_server') this.engineWaits.delete(id);
    if (patch.state && patch.state !== 'downloading') this.store.setLive(id, null);
    this.emit();
    return next;
  }

  private fail(id: string, code: string, extra: Partial<OfflineDownloadError> = {}): void {
    this.set(id, {
      state: 'failed',
      error: errorOf(code, this.now(), extra),
      retryAt: null,
      serverState: null,
    });
  }

  // ---- public actions -------------------------------------------------------------------------

  private starting: Promise<unknown> = Promise.resolve();

  /** Queues movies/episodes for `accountKey`; an existing unfinished or done download of a work is returned as is. */
  start(accountKey: string, items: DownloadRequestItem[]): Promise<OfflineDownload[]> {
    // One start at a time: two starts of a work must find each other's record (one clientRef).
    const run = this.starting.then(() => this.startNow(accountKey, items));
    this.starting = run.catch(() => undefined);
    return run;
  }

  private async startNow(
    accountKey: string,
    items: DownloadRequestItem[]
  ): Promise<OfflineDownload[]> {
    if (!this.supported) throw Object.assign(new Error('not_supported'), { code: 'not_supported' });
    const existingOf = (workId: string) =>
      this.store.forAccount(accountKey).find((download) => download.workId === workId);
    for (const item of items)
      if (!workPartsOf(item.workId))
        throw Object.assign(new Error('invalid_work_id'), { code: 'invalid_work_id' });
    // A work still being removed is not downloaded again until it is gone; a failed one is replaced.
    if (items.some((item) => isRemovingDownload(existingOf(item.workId) ?? { state: 'queued' })))
      throw workRemoving();
    for (const item of items) {
      const existing = existingOf(item.workId);
      // intent: removes the failed record before new ones are created; nothing of it is written after
      if (existing?.state === 'failed') await this.remove(existing.id);
    }
    if (items.some((item) => existingOf(item.workId)?.state === 'removing')) throw workRemoving();
    const created: OfflineDownload[] = [];
    for (const item of items) {
      const parts = workPartsOf(item.workId)!;
      const existing = existingOf(item.workId);
      if (existing) {
        created.push(existing);
        continue;
      }
      const now = this.now();
      const id = newDownloadId(now);
      const record: OfflineDownload = {
        id,
        accountKey,
        downloadId: null,
        serverState: null,
        workId: item.workId,
        ...parts,
        releaseId: item.releaseId,
        sourceReleaseId: null,
        version: item.candidate?.version ?? null,
        engine: null,
        mediaInfo: null,
        fileName: null,
        container: null,
        relativePath: null,
        volumeId: 'internal',
        etag: null,
        sizeBytes: null,
        estimatedBytes: item.candidate?.sizeBytes ?? null,
        bytesWritten: 0,
        state: 'queued',
        error: null,
        retryAt: null,
        restarts: 0,
        expiresAt: null,
        serverCompleted: false,
        meta: { title: '', ...item.meta },
        artwork: {},
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      this.store.put(record);
      this.engineChoice.set(id, item.engine ?? 'auto');
      created.push(record);
      void this.snapshot(id);
    }
    this.emit();
    this.pump();
    return created;
  }

  private readonly engineChoice = new Map<string, 'auto' | 'native' | 'vlc'>();

  async pause(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record || !isActiveDownload(record) || record.state === 'verifying') return;
    this.bumpIntent(id, 'pause');
    this.polls.get(id)?.abort();
    // Paused before the engine is asked: a late event of the transfer finds the newer intent already.
    this.set(id, { state: 'paused', retryAt: null });
    if (isPrepared(record)) await this.engine.pause(id).catch(() => undefined);
    this.pump();
  }

  async resume(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record || (record.state !== 'paused' && !record.state.startsWith('waiting_'))) return;
    this.backoff.delete(id);
    // A newer intent: an older launch snapshot or continuation never pauses it again.
    this.bumpIntent(id);
    await this.continueTransfer(record);
  }

  /** A failed download tries again: a failed server preparation is prepared anew, a transfer continues. */
  async retry(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record) return;
    if (record.state !== 'failed' && !record.state.startsWith('waiting_')) return;
    this.backoff.delete(id);
    this.bumpIntent(id);
    const prepareFailed = !isPrepared(record) || PREPARE_AGAIN.has(record.error?.code ?? '');
    if (prepareFailed) {
      // Marked first, like a restart: a Pause, sign-out or relaunch meanwhile leaves the rest to the next Resume.
      this.set(id, { state: 'queued', error: null, retryAt: null, restartReason: RETRY_REASON });
      await this.finishRestart(id);
      return;
    }
    await this.continueTransfer(record);
  }

  /** `removing` at once, then engine task, media, record and artwork; the server record follows from the outbox. */
  remove(id: string): Promise<void> {
    return this.markRemoving(id) ? this.finishRemoval(id) : Promise.resolve();
  }

  /** Same as `remove` (an unfinished download is cancelled the same way). */
  cancel(id: string): Promise<void> {
    return this.remove(id);
  }

  async removeMany(ids: string[]): Promise<void> {
    const marked = ids.filter((id) => this.markRemoving(id));
    await Promise.all(marked.map((id) => this.finishRemoval(id)));
  }

  removeSeason(accountKey: string, seasonId: string): Promise<void> {
    const season = normalizeSeasonId(seasonId);
    return this.removeMany(
      this.store
        .forAccount(accountKey)
        .filter((download) => download.seasonId === season)
        .map((download) => download.id)
    );
  }

  removeSeries(accountKey: string, seriesId: string): Promise<void> {
    return this.removeMany(
      this.store
        .forAccount(accountKey)
        .filter((download) => download.seriesId === seriesId)
        .map((download) => download.id)
    );
  }

  /** "Delete downloads" at sign-out: the server hears of them for at most 5 s, the files go later; `forget` drops the rest. */
  async removeForSignOut(accountKey: string, { forget = false } = {}): Promise<void> {
    const ids = this.store.forAccount(accountKey).map((download) => download.id);
    for (const id of ids) {
      if (!this.markRemoving(id)) continue;
      const downloadId = this.store.get(id)?.downloadId ?? null;
      this.queueServerDelete(accountKey, downloadId);
      // The outbox owns the server record now: the local removal never queues it again.
      if (downloadId) this.store.update(id, { downloadId: null });
    }
    this.store.deletePositions(accountKey);
    for (const id of ids) void this.finishRemoval(id);
    await within(
      this.flushDeletes(accountKey),
      this.deps.signOutFlushMs ?? SIGN_OUT_FLUSH_MS,
      undefined
    );
    if (!forget) return;
    this.bumpSession(accountKey);
    this.forgotten.add(accountKey);
    this.store.setPendingDeletes(
      this.store.pendingDeletes().filter((entry) => entry.accountKey !== accountKey)
    );
  }

  /** Profiles removed from this device in this run: a late server answer queues nothing for them. */
  private readonly forgotten = new Set<string>();

  /** Every download of a profile, waiting until the files are gone (the active profile's "delete all"). */
  async removeAll(accountKey: string): Promise<void> {
    await this.removeMany(this.store.forAccount(accountKey).map((download) => download.id));
    this.store.deletePositions(accountKey);
    await this.flushDeletes(accountKey);
  }

  private readonly removals = new Map<string, Promise<void>>();

  /** The synchronous first step of every removal; false when there is no such download. */
  private markRemoving(id: string): boolean {
    const record = this.store.get(id);
    if (!record) return false;
    this.bumpIntent(id, 'remove');
    this.accessRetry.delete(id);
    this.polls.get(id)?.abort();
    this.polls.delete(id);
    this.backoff.delete(id);
    this.pendingUrls.delete(id);
    if (!isRemovingDownload(record)) {
      this.store.update(id, { state: 'removing' });
      this.store.setLive(id, null);
      this.emit();
    }
    return true;
  }

  private finishRemoval(id: string): Promise<void> {
    const running = this.removals.get(id);
    if (running) return running;
    const run = this.removeNow(id).finally(() => this.removals.delete(id));
    this.removals.set(id, run);
    return run;
  }

  private async removeNow(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record || !isRemovingDownload(record)) return;
    // The transfer must have ended before its files go (the engine keeps its paths until then).
    if (this.supported && !(await this.stopTask(id))) return;
    // The files' job is written before the record goes: a deletion that fails (volume gone, I/O) is retried later.
    const job = this.supported ? this.addCleanup(record) : null;
    // Still held after a real engine error: the job waits until the engine lets the paths go.
    const released = this.supported && (await this.pathsReleased(id));
    if (released && record.relativePath) await this.tryDelete(record.relativePath, record.volumeId);
    // Read again: a sign-out with "Delete downloads" may have handed it to the outbox meanwhile.
    this.queueServerDelete(record.accountKey, this.store.get(id)?.downloadId ?? null);
    this.store.delete(id);
    this.emit();
    const folder =
      released && (await this.tryDelete(downloadFolder(record.accountKey, id), record.volumeId));
    if (job) await this.settleCleanup(job, folder);
    void this.flushDeletes(record.accountKey);
    this.pump();
    void this.recheckSpace();
  }

  // ---- cleanup jobs ---------------------------------------------------------------------------

  private addCleanup(record: OfflineDownload): CleanupJob {
    const job: CleanupJob = {
      id: record.id,
      accountKey: record.accountKey,
      volumeId: record.volumeId,
      paths: [
        ...(record.relativePath ? [record.relativePath] : []),
        downloadFolder(record.accountKey, record.id),
      ],
      bytes:
        record.state === 'done' ? (record.sizeBytes ?? record.bytesWritten) : record.bytesWritten,
      attempts: 0,
      nextAt: 0,
    };
    this.putCleanupJob(job);
    return job;
  }

  /** Every job change reads the stored list at that moment: another removal's job is never written over. */
  private putCleanupJob(job: CleanupJob): void {
    this.store.setCleanupJobs([
      ...this.store.cleanupJobs().filter((item) => item.id !== job.id),
      job,
    ]);
  }

  private dropCleanupJob(id: string): void {
    this.store.setCleanupJobs(this.store.cleanupJobs().filter((item) => item.id !== id));
  }

  private async tryDelete(path: string, volumeId: string): Promise<boolean> {
    return this.engine.deletePath(path, volumeId).then(
      () => true,
      () => false
    );
  }

  /** Done: the job goes; failed: it waits for the volume's return or its next backoff step. */
  private async settleCleanup(job: CleanupJob, done: boolean): Promise<void> {
    if (done) {
      this.dropCleanupJob(job.id);
      this.emit();
      return;
    }
    const volumes = await this.engine.volumes().catch(() => null);
    // Settled meanwhile (another run deleted the files): it stays gone.
    const current = this.store.cleanupJobs().find((item) => item.id === job.id);
    if (!current) return;
    const mounted = !volumes || volumes.some((volume) => volume.id === job.volumeId);
    const attempts = Math.max(current.attempts, job.attempts) + 1;
    this.putCleanupJob({
      ...current,
      attempts,
      // A missing volume is asked for at its return; anything else on a doubling delay.
      nextAt: mounted ? this.now() + cleanupRetryDelay(attempts) : AT_MOUNT,
    });
    this.scheduleCleanup();
  }

  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleCleanup(): void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = null;
    const next = Math.min(...this.store.cleanupJobs().map((job) => job.nextAt));
    if (next >= AT_MOUNT || this.disposed) return;
    this.cleanupTimer = setTimeout(
      () => {
        this.cleanupTimer = null;
        void this.runCleanups();
      },
      Math.max(0, next - this.now())
    );
  }

  private cleaning: Promise<void> | null = null;

  /** Retries due jobs (`force`: every job, e.g. at launch); `mounted` restricts a volume's return to its own jobs. */
  private runCleanups(force = false, mounted?: ReadonlySet<string>): Promise<void> {
    if (this.cleaning) return this.cleaning;
    const run = this.cleanNow(force, mounted).finally(() => {
      this.cleaning = null;
    });
    this.cleaning = run;
    return run;
  }

  private async cleanNow(force: boolean, mounted?: ReadonlySet<string>): Promise<void> {
    if (!this.supported || this.disposed) return;
    const now = this.now();
    for (const { id } of this.store.cleanupJobs()) {
      // Read again: a job settled or replaced while an earlier one ran is never worked from an old copy.
      const job = this.store.cleanupJobs().find((item) => item.id === id);
      if (!job) continue;
      const due = force || job.nextAt <= now || (!!mounted && mounted.has(job.volumeId));
      // A live record or a registered unfinished task still owns these paths (N3-02).
      if (!due || this.store.get(job.id) || !(await this.pathsReleased(job.id))) continue;
      let done = true;
      for (const path of job.paths) done = (await this.tryDelete(path, job.volumeId)) && done;
      await this.settleCleanup(job, done);
    }
  }

  /** Done downloads whose local position says played (≥ 90 %). */
  removeWatched(accountKey: string): Promise<void> {
    const positions = this.store.positions(accountKey);
    return this.removeMany(
      this.store
        .forAccount(accountKey)
        .filter((download) => download.state === 'done' && positions[download.workId]?.played)
        .map((download) => download.id)
    );
  }

  settings(): DownloadSettings {
    return this.store.settings();
  }

  async setWifiOnly(wifiOnly: boolean): Promise<void> {
    this.store.setSettings({ wifiOnly });
    if (this.supported) await this.engine.setWifiOnly(wifiOnly);
  }

  async setMaxConcurrent(maxConcurrent: number): Promise<void> {
    const value = Math.min(6, Math.max(1, Math.round(maxConcurrent)));
    this.store.setSettings({ maxConcurrent: value });
    if (this.supported) await this.engine.setMaxConcurrent(value);
  }

  setDeleteWatched(deleteWatched: boolean): void {
    this.store.setSettings({ deleteWatched });
    if (deleteWatched) for (const record of this.store.all()) void this.deleteIfWatched(record.id);
  }

  private readonly holds = new Map<string, number>();

  /** The player plays this download's file: no automatic deletion until the returned release runs. */
  holdFile(id: string): () => void {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.holds.get(id) ?? 1) - 1;
      if (left > 0) this.holds.set(id, left);
      else this.holds.delete(id);
      void this.deleteIfWatched(id);
    };
  }

  /** "Delete watched": a played, finished download goes as soon as no player holds its file. */
  private async deleteIfWatched(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record || record.state !== 'done' || this.holds.has(id)) return;
    if (!this.store.settings().deleteWatched) return;
    if (this.store.position(record.accountKey, record.workId)?.played) await this.remove(id);
  }

  /** The file of a finished download is still there with its size; a missing one fails with `file_missing`. */
  async verifyLocalFile(id: string): Promise<boolean> {
    const record = this.store.get(id);
    if (!record || record.state !== 'done') return false;
    // intent: a finished file takes no Pause or sign-out, and set() never writes over a removal
    if (await this.fileComplete(record)) return true;
    await this.onFileGone(record, ['retry', 'remove']);
    return false;
  }

  /** Re-reads the viewer's permissions (online) so downloads lock or unlock by the current age rules. */
  async refreshPolicy(accountKey: string): Promise<void> {
    const policy = await this.deps
      .serverFor(accountKey)
      ?.policy()
      .catch(() => null);
    if (policy) this.notePolicy(accountKey, policy);
  }

  /** A fresh `/viewer/me` answer: kept for offline locks; downloads it allows again are asked for at once. */
  notePolicy(accountKey: string, policy: ViewerPolicy): void {
    const before = this.store.policy(accountKey);
    this.store.setPolicy(accountKey, policy);
    const changed =
      !before ||
      before.allowDownloads !== policy.allowDownloads ||
      before.maxAge !== policy.maxAge ||
      before.blockUnrated !== policy.blockUnrated;
    void this.recheckBlocked(accountKey, changed);
    // Unrestricted now: its pending age checks are dropped with their timer.
    this.scheduleAccess(accountKey);
    // Newly restricted: verdicts read without age rules are asked for now, not at the next launch.
    if (changed && restricted(policy)) void this.revalidateAccess(accountKey);
  }

  private readonly unblockedAt = new Map<string, number>();
  private readonly policyAskedAt = new Map<string, number>();

  /** Blocked downloads the persisted permissions allow again are asked for (launch, reconnect, `/viewer/me` refresh). */
  async recheckBlocked(accountKey?: string, force = false): Promise<void> {
    if (!this.supported || this.disposed) return;
    const now = this.now();
    const stale = new Set<string>();
    for (const record of this.store.all()) {
      if (accountKey && record.accountKey !== accountKey) continue;
      if (!isBlockedDownload(record)) continue;
      if (!allowedAgain(record, this.store.policy(record.accountKey))) {
        stale.add(record.accountKey);
        continue;
      }
      if (!force && now - (this.unblockedAt.get(record.id) ?? -Infinity) < UNBLOCK_GAP_MS) continue;
      this.unblockedAt.set(record.id, now);
      // intent: unblock re-checks its own download; the loop reads the next record from the store
      await this.unblock(record.id);
    }
    // Still blocked by the last known permissions: they are read again (an admin may have changed them meanwhile).
    for (const owner of stale) {
      if (now - (this.policyAskedAt.get(owner) ?? -Infinity) < UNBLOCK_GAP_MS) continue;
      this.policyAskedAt.set(owner, now);
      // intent: the profile policy only
      await this.refreshPolicy(owner);
    }
  }

  private async unblock(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record) return;
    // A finished file needs nothing from the server: its lock follows the persisted permissions again.
    if (record.state === 'done') {
      this.set(id, { error: null });
      return;
    }
    // Refused before it was prepared: it is prepared anew.
    if (!isPrepared(record)) {
      await this.retry(id);
      return;
    }
    if (record.state !== 'failed' || this.busy.has(id)) return;
    const server = this.deps.serverFor(record.accountKey);
    if (!server || !record.downloadId) return;
    // `renew` runs the file URL's checks (GET only checks the session): its answer is the proof the file is served.
    const intent = this.intentOf(id);
    try {
      const renewed = await server.renew(record.downloadId, this.store.installId());
      if (!this.store.get(id) || !renewed.fileUrl || this.stale(id, intent)) return;
      const url = server.baseUrl + renewed.fileUrl;
      this.set(id, {
        state: 'queued',
        error: null,
        retryAt: null,
        expiresAt: renewed.expiresAt ?? null,
      });
      const task = await this.engine.get(id).catch(() => null);
      if (this.stale(id, intent)) return;
      if (!task) {
        await this.enqueue(id, url);
        return;
      }
      await this.engine.resume(id, { url }).catch(() => undefined);
      // Paused, removed or signed out while the engine resumed: the native task follows that intent.
      if (this.stale(id, intent)) return this.followIntent(id);
      const fresh = await this.engine.get(id).catch(() => null);
      if (fresh && !this.stale(id, intent)) await this.onTask(fresh);
    } catch (error) {
      if (this.stale(id, intent)) return;
      if (!this.store.get(id) || !isAppError(error)) return;
      // Still refused (maybe for the other reason): it stays blocked with the server's answer.
      if (error.status === 403 && FORBIDDEN_CODES.has(error.code))
        this.fail(id, error.code, {
          status: 403,
          params: error.params ? { ...error.params } : undefined,
          actions: ['remove'],
        });
      // Signed out or unreachable: it stays blocked and is asked again at the next sign-in or reconnect.
      else if (error.status !== 401 && !error.isTransient) this.onRecordError(id, error);
    }
  }

  storage(): Promise<StorageInfo> {
    return this.engine.storage();
  }

  /** Bytes queued and running downloads still need (all profiles share the device). */
  committedBytes(exceptId?: string): number {
    return this.store
      .all()
      .filter((download) => download.id !== exceptId)
      .reduce((sum, download) => sum + remainingBytes(download), 0);
  }

  /** Free space a new download may use: free − committed − reserve (never negative). */
  async availableBytes(exceptId?: string): Promise<number> {
    const { freeBytes } = await this.engine.storage();
    return Math.max(0, freeBytes - this.committedBytes(exceptId) - STORAGE_RESERVE_BYTES);
  }

  /** The resume thresholds of `accountKey`'s server: what it last sent, its defaults until then. */
  resumeRules(accountKey: string): ResumeRules {
    return this.deps.resumeRules?.(accountKey) ?? DEFAULT_RESUME_RULES;
  }

  /** Saves the viewer's position of a work (any download of it) under its server's resume rules, `at` on its clock. */
  recordPosition(
    accountKey: string,
    workId: string,
    seconds: number,
    durationSeconds: number | null,
    { at, restarted = false }: { at?: number; restarted?: boolean } = {}
  ): LocalPosition {
    const previous = this.store.position(accountKey, workId);
    const point = resumePointOf(seconds, durationSeconds, this.resumeRules(accountKey));
    const played = point.played;
    const stamp =
      at === undefined
        ? serverStamp(serverOfAccountKey(accountKey), this.now())
        : { at, estimated: false, uncertaintyMs: 0 };
    const position: LocalPosition = {
      seconds: point.seconds,
      durationSeconds: durationSeconds ?? previous?.durationSeconds ?? null,
      at: stamp.at,
      played: played || (!!previous?.played && seconds < 1),
      ...(stamp.estimated ? { estimated: true, uncertaintyMs: stamp.uncertaintyMs } : {}),
      ...(restarted ? { restarted } : {}),
    };
    this.store.setPosition(accountKey, workId, position);
    if (position.played)
      for (const record of this.store.forAccount(accountKey))
        if (record.workId === workId) void this.deleteIfWatched(record.id);
    return position;
  }

  /** Re-checks waiting downloads now (reconnect, sign-in, app foreground). */
  wake(): void {
    if (!this.supported || this.disposed) return;
    const now = this.now();
    for (const owner of this.dueAccessOwners(now)) void this.revalidateAccess(owner);
    for (const record of this.store.all()) {
      if (
        record.state === 'waiting_server' &&
        (record.retryAt ?? 0) <= now &&
        !this.engineWaits.has(record.id)
      )
        void this.continueTransfer(record);
      if (record.state === 'preparing' && record.downloadId && !this.polls.has(record.id))
        void this.poll(record.id);
    }
    void this.recheckSpace();
    void this.completePending();
    void this.renewExpiring();
    void this.recheckBlocked();
    for (const owner of new Set(this.store.pendingDeletes().map((entry) => entry.accountKey)))
      void this.flushDeletes(owner);
    void this.runCleanups();
    this.pump();
  }

  /** Profiles that just signed in: their downloads waiting for a sign-in continue now, not at their backoff time. */
  resumeSignedOut(accountKeys: readonly string[]): void {
    const owners = new Set(accountKeys);
    // A new session: queued DELETEs go out with it, whatever the old one still waits for.
    for (const owner of owners) this.bumpSession(owner);
    const now = this.now();
    for (const record of this.store.all())
      if (
        owners.has(record.accountKey) &&
        record.state === 'waiting_server' &&
        record.error?.code === 'signed_out'
      ) {
        // The new session drives it: a continuation of the old one still in flight is dropped quietly.
        this.bumpIntent(record.id);
        this.set(record.id, { retryAt: now });
      }
    this.wake();
  }

  /** Downloads on a volume that came back: waiting ones continue, finished ones play again. */
  private async recheckVolumes(): Promise<void> {
    const waiting = this.store
      .all()
      .filter(
        (record) => record.state === 'waiting_volume' || record.error?.code === VOLUME_UNAVAILABLE
      );
    const parkedJobs = this.store.cleanupJobs().some((job) => job.nextAt >= AT_MOUNT);
    if (!waiting.length && !parkedJobs) return;
    // intent: the waiting records are read again one by one below
    const volumes = await this.engine.volumes().catch(() => null);
    if (!volumes) return;
    const mounted = new Set(volumes.map((volume) => volume.id));
    // intent: cleanup jobs only; the records are read again below
    if (parkedJobs) await this.runCleanups(false, mounted);
    for (const listed of waiting) {
      const record = this.store.get(listed.id);
      if (!record || !mounted.has(record.volumeId)) continue;
      if (record.state === 'done') {
        if (record.error?.code === VOLUME_UNAVAILABLE) this.set(record.id, { error: null });
        continue;
      }
      if (record.state !== 'waiting_volume') continue;
      const intent = this.intentOf(record.id);
      // The engine continues by itself when the volume returns; only a task still failed is resumed here.
      const task = await this.engine.get(record.id).catch(() => null);
      if (this.stale(record.id, intent)) continue;
      // intent: onTask and continueTransfer re-check their own download; the loop reads the next one afresh
      if (task && task.state !== 'failed') await this.onTask(task);
      // intent: as above
      else await this.continueTransfer(this.store.get(record.id) ?? record);
    }
  }

  /** Unfinished downloads keep a valid file link (a long Wi-Fi or space wait outlives 30 days otherwise). */
  private async renewExpiring(): Promise<void> {
    for (const record of this.store.all()) {
      const expires = Date.parse(record.expiresAt ?? '');
      if (!record.downloadId || !isPrepared(record) || !isActiveDownload(record)) continue;
      const now = serverNow(serverOfAccountKey(record.accountKey), this.now());
      if (!Number.isFinite(expires) || expires - now > RENEW_AHEAD_MS) continue;
      const server = this.deps.serverFor(record.accountKey);
      // intent: only the link's expiry is written, never a state
      const renewed = await server
        ?.renew(record.downloadId, this.store.installId())
        .catch(() => null);
      if (renewed?.expiresAt && this.store.get(record.id))
        this.set(record.id, { expiresAt: renewed.expiresAt });
    }
  }

  // ---- scheduling -----------------------------------------------------------------------------

  /** Starts server preparations for queued downloads, oldest first, up to `MAX_PREPARING`. */
  private pump(): void {
    if (!this.supported || this.disposed) return;
    const all = this.store.all();
    let slots = MAX_PREPARING - all.filter((download) => download.state === 'preparing').length;
    for (const record of all) {
      if (slots <= 0) break;
      if (record.state !== 'queued' || isPrepared(record) || this.busy.has(record.id)) continue;
      // A restart prepares it itself, once its old server record is gone.
      if (record.restartReason || this.busy.has(`restart:${record.id}`)) continue;
      if (this.adopting.has(record.id)) continue;
      slots -= 1;
      void this.prepare(record.id);
    }
    this.schedule();
  }

  /** One timer for the earliest `retryAt`. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = this.store
      .all()
      .filter(
        (download) =>
          download.state === 'waiting_server' &&
          download.retryAt &&
          !this.engineWaits.has(download.id)
      )
      .reduce((min, download) => Math.min(min, download.retryAt!), Infinity);
    if (next === Infinity || this.disposed) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.wake();
      },
      Math.max(0, next - this.now())
    );
  }

  private waitForServer(id: string, error: OfflineDownloadError, retryAfterMs?: number): void {
    const previous = this.backoff.get(id) ?? 0;
    const delay =
      retryAfterMs ?? Math.min(SERVER_RETRY_MAX_MS, previous ? previous * 2 : SERVER_RETRY_MS);
    this.backoff.set(id, delay);
    this.engineWaits.delete(id);
    this.set(id, { state: 'waiting_server', error, retryAt: this.now() + delay });
    this.schedule();
  }

  // ---- preparation ----------------------------------------------------------------------------

  private async prepare(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record) return;
    const server = this.deps.serverFor(record.accountKey);
    if (!server) {
      this.waitForServer(id, errorOf('signed_out', this.now()));
      return;
    }
    this.busy.add(id);
    this.set(id, { state: 'preparing', error: null, retryAt: null, serverState: 'queued' });
    const owner = record.accountKey;
    const intent = this.intentOf(id);
    const lifecycle = this.lifecycleOf(id);
    try {
      const device = await this.deps.deviceProfile();
      // Paused, removed or signed out before the POST: nothing is asked for (Resume or the sign-in prepares).
      if (this.stale(id, intent)) return;
      this.postStarted(owner);
      const response = await server
        .prepare({
          workId: record.workId,
          releaseId: record.releaseId,
          device,
          engine: this.engineChoice.get(id) ?? 'auto',
          deviceName: this.deps.deviceName?.(),
          deviceId: this.store.installId(),
          clientRef: id,
        })
        .finally(() => this.postEnded(owner));
      // Paused or signed out meanwhile: the server's id is kept (Resume or the sign-in poll it, adoption finds it).
      if (this.stale(id, intent)) {
        if (this.lifecycleOf(id) === lifecycle)
          this.keepServerRecord(id, owner, response.downloadId ?? null);
        return;
      }
      this.set(id, { downloadId: response.downloadId, serverState: response.state });
      // intent: handleServerState re-checks its own intent; poll reads the record afresh
      if (!(await this.handleServerState(id, response))) void this.poll(id);
    } catch (error) {
      // A rejection after a newer intent never writes over it (a sign-out parked it, a Pause stays).
      if (this.stale(id, intent)) return;
      this.prepareError(id, error);
    } finally {
      this.busy.delete(id);
      this.pump();
    }
  }

  /** A preparation answer that a newer intent overtook: its server record stays this download's (or goes with it). */
  private keepServerRecord(id: string, owner: string, downloadId: string | null): void {
    const current = this.store.get(id);
    if (!current || isRemovingDownload(current)) {
      this.queueServerDelete(owner, downloadId);
      void this.flushDeletes(owner);
      return;
    }
    if (downloadId) this.set(id, { downloadId, serverState: null });
  }

  private async poll(id: string): Promise<void> {
    const record = this.store.get(id);
    const server = record ? this.deps.serverFor(record.accountKey) : null;
    if (!record?.downloadId || !server) {
      if (record && !server) this.waitForServer(id, errorOf('signed_out', this.now()));
      return;
    }
    const controller = new AbortController();
    this.polls.get(id)?.abort();
    this.polls.set(id, controller);
    const intent = this.intentOf(id);
    try {
      for (;;) {
        const current = this.store.get(id);
        if (!current?.downloadId || current.state !== 'preparing' || controller.signal.aborted)
          return;
        if (this.stale(id, intent)) return;
        const response = await server.get(current.downloadId, {
          waitMs: this.deps.prepareWaitMs ?? PREPARE_WAIT_MS,
          deviceId: this.store.installId(),
          signal: controller.signal,
        });
        if (this.stale(id, intent) || controller.signal.aborted || !this.store.get(id)) return;
        // intent: handleServerState re-checks its own intent; the loop re-checks before the next request
        if (await this.handleServerState(id, response)) return;
        const gap = Math.max(response.pollAfterMs ?? 0, this.deps.pollGapMs ?? MIN_POLL_GAP_MS);
        // intent: the loop re-checks the intent before the next request
        await abortableDelay(gap, controller.signal);
      }
    } catch (error) {
      if (controller.signal.aborted || this.stale(id, intent)) return;
      this.prepareError(id, error);
    } finally {
      if (this.polls.get(id) === controller) this.polls.delete(id);
      // The preparation slot is free: the next queued download may prepare.
      this.pump();
    }
  }

  /** True once the preparation ended (ready, failed, completed). */
  private async handleServerState(id: string, response: DownloadResponse): Promise<boolean> {
    switch (response.state) {
      case 'ready':
        await this.onReady(id, response);
        return true;
      case 'failed':
        this.fail(id, response.error?.code ?? 'download_failed', {
          params: response.error?.params ?? undefined,
          actions: response.suggestedActions ?? undefined,
        });
        return true;
      case 'completed':
        if (!this.store.get(id)) return true;
        // A fresh one, like a restart: prepared only once the old record is deleted (a Pause, sign-out or relaunch waits).
        this.set(id, {
          state: 'queued',
          serverState: null,
          retryAt: null,
          restartReason: SERVER_COMPLETED_REASON,
        });
        await this.finishRestart(id);
        return true;
      default:
        this.set(id, { serverState: response.state });
        return false;
    }
  }

  private prepareError(id: string, error: unknown): void {
    if (!this.store.get(id)) return;
    if (!isAppError(error)) {
      this.fail(id, 'unknown');
      return;
    }
    if (error.status === 501) {
      this.fail(id, 'server_unsupported', { status: error.status });
      return;
    }
    // The server re-checks the session at answer time: a 401 waits for the next sign-in, never fails.
    if (error.status === 401) {
      this.waitForServer(id, errorOf('signed_out', this.now(), { status: 401 }));
      return;
    }
    if (error.status === 404 && error.code === 'download_not_found') {
      this.fail(id, 'download_not_found', { status: 404, actions: ['retry'] });
      return;
    }
    if (error.code === 'download_source_gone') {
      this.fail(id, error.code, { status: error.status, actions: ['otherVersion'] });
      return;
    }
    if (error.isTransient) {
      this.waitForServer(
        id,
        errorOf(error.code, this.now(), { status: error.status, params: error.params }),
        error.retryAfter ? error.retryAfter * 1000 : undefined
      );
      return;
    }
    this.fail(id, error.code, { status: error.status, params: error.params });
  }

  // ---- transfer -------------------------------------------------------------------------------

  private async onReady(id: string, response: DownloadResponse): Promise<void> {
    const record = this.store.get(id);
    const server = record ? this.deps.serverFor(record.accountKey) : null;
    if (!record || !server) return;
    const intent = this.intentOf(id);
    const sizeBytes = response.sizeBytes ?? null;
    // Ready but revoked (a security sign-out while it was prepared): the URL comes with the next renewal.
    if ((!response.fileUrl && !response.fileUrlRevoked) || sizeBytes === null) {
      this.fail(id, 'download_failed', { params: { reason: 'incomplete_ready' } });
      return;
    }
    this.set(id, {
      serverState: null,
      sizeBytes,
      fileName: response.fileName ?? null,
      container: response.container ?? null,
      etag: response.eTag ?? null,
      engine: response.engine === 'vlc' ? 'vlc' : 'native',
      mediaInfo: response.mediaInfo ?? null,
      version: response.version ?? record.version,
      sourceReleaseId: response.releaseId ?? record.releaseId,
      expiresAt: response.expiresAt ?? null,
      relativePath: filePathOf(record.accountKey, id, response.fileName),
      ...(record.state === 'paused' ? null : { state: 'queued' as const }),
    });
    void this.snapshot(id);
    const url =
      response.fileUrl && !response.fileUrlRevoked
        ? server.baseUrl + response.fileUrl
        : await this.renewedUrl(id, server, record.downloadId ?? response.downloadId ?? '', intent);
    // A newer intent kept the renewed link (renewedUrl); the transfer starts with the next Resume.
    if (!url || !this.store.get(id) || this.stale(id, intent)) return;
    if (record.state === 'paused') {
      this.pendingUrls.set(id, url);
      return;
    }
    await this.enqueue(id, url);
  }

  private async enqueue(id: string, url: string): Promise<void> {
    const before = this.store.get(id);
    if (!before?.relativePath || before.sizeBytes === null) return;
    const intent = this.intentOf(id);
    const available = await this.availableBytes(id).catch(() => Infinity);
    // Removed, paused or signed out while the space was measured: nothing may start.
    if (this.stale(id, intent)) {
      if (this.store.get(id)?.state === 'paused') this.pendingUrls.set(id, url);
      return;
    }
    const record = this.store.get(id);
    if (!record?.relativePath || record.sizeBytes === null || isRemovingDownload(record)) return;
    if (record.state === 'paused') {
      this.pendingUrls.set(id, url);
      return;
    }
    if (record.sizeBytes - record.bytesWritten > available) {
      this.set(id, {
        state: 'waiting_space',
        error: errorOf('disk_full', this.now(), {
          params: {
            needed: String(record.sizeBytes - record.bytesWritten),
            available: String(available),
          },
        }),
      });
      this.pendingUrls.set(id, url);
      return;
    }
    try {
      // A tombstone is the viewer's cancel (the manager's own cancels leave none): never start it again.
      const old = await this.engine.get(id).catch(() => null);
      if (old?.state !== 'cancelled' && this.stale(id, intent)) {
        if (this.store.get(id)?.state === 'paused') this.pendingUrls.set(id, url);
        return;
      }
      if (old?.state === 'cancelled') {
        await this.remove(id);
        return;
      }
      const task = await this.engine.start({
        id,
        url,
        relativePath: record.relativePath,
        expectedBytes: record.sizeBytes,
        etag: record.etag ?? undefined,
        volumeId: record.volumeId,
        notificationTitle: this.deps.notificationTitle?.(record) ?? record.meta.title,
      });
      // Removed, paused or signed out while the task was being started: the native task follows that intent.
      if (this.stale(id, intent)) {
        this.pendingUrls.delete(id);
        const current = this.store.get(id);
        if (!current || isRemovingDownload(current)) await this.discardTask(id, record);
        else await this.followIntent(id);
        return;
      }
      this.pendingUrls.delete(id);
      if (task.url !== url && (task.state === 'failed' || task.state === 'paused'))
        await this.engine.resume(id, { url });
      else await this.onTask(task);
    } catch (error) {
      // A rejection after a newer intent never writes `failed` over it; a paused one starts on Resume.
      if (this.stale(id, intent)) {
        if (this.store.get(id)?.state === 'paused') this.pendingUrls.set(id, url);
        return;
      }
      this.fail(id, 'file_system', { params: { engineCode: engineCode(error) ?? IO_CODE } });
    }
  }

  private readonly pendingUrls = new Map<string, string>();

  /** Per download, bumped by pause, removal and sign-out: a continuation of an older intent may only update the link. */
  private readonly intents = new Map<string, number>();

  /** Downloads whose latest intent bump was a sign-out (pause and removal set their own state; a sign-out does not). */
  private readonly signOutIntents = new Set<string>();

  /** Downloads the viewer paused here: the engine's own resume (still pending) or its events never undo that. */
  private readonly pauseIntents = new Set<string>();
  /** Paused downloads whose native task was already told to follow (once per pause). */
  private readonly pauseFollowed = new Set<string>();

  /** Per download, bumped when a restart resets it: an answer for the record before the reset never attaches. */
  private readonly lifecycles = new Map<string, number>();

  private lifecycleOf(id: string): number {
    return this.lifecycles.get(id) ?? 0;
  }

  /** What an operation captures at its start: the download's intent and its profile's session. */
  private intentOf(id: string): string {
    const owner = this.store.get(id)?.accountKey;
    return `${this.intents.get(id) ?? 0}/${owner ? this.sessionOf(owner) : ''}`;
  }

  private bumpIntent(id: string, kind?: 'pause' | 'remove' | 'signOut'): void {
    this.intents.set(id, (this.intents.get(id) ?? 0) + 1);
    if (kind === 'signOut') this.signOutIntents.add(id);
    else this.signOutIntents.delete(id);
    this.pauseFollowed.delete(id);
    if (kind === 'pause') this.pauseIntents.add(id);
    else this.pauseIntents.delete(id);
  }

  /** Whether a continuation is dropped; one a sign-out dropped leaves its download waiting for the next sign-in. */
  private stale(id: string, intent: string): boolean {
    if (this.intentOf(id) === intent) return false;
    if (this.signOutIntents.has(id)) this.parkSignedOut(id);
    return true;
  }

  /** Paused by the viewer here, or parked by a sign-out: engine events never move it on. */
  private heldByIntent(record: OfflineDownload): boolean {
    if (record.state === 'paused') return this.pauseIntents.has(record.id);
    return (
      record.state === 'waiting_server' &&
      record.error?.code === 'signed_out' &&
      this.signOutIntents.has(record.id)
    );
  }

  /** A stale continuation got a native task going: it follows the newer intent (paused or signed out → paused). */
  private async followIntent(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record || isRemovingDownload(record) || this.pauseFollowed.has(id)) return;
    if (record.state !== 'paused' && record.error?.code !== 'signed_out') return;
    this.pauseFollowed.add(id);
    await this.engine.pause(id).catch(() => undefined);
  }

  private parkSignedOut(id: string): void {
    const record = this.store.get(id);
    if (!record || !TRANSFERRING.includes(record.state)) return;
    this.waitForServer(id, errorOf('signed_out', this.now()));
  }

  /** `waiting_server` because the engine retries by itself (`retrying`): its own deadline, not `retryAt`, ends the wait. */
  private readonly engineWaits = new Set<string>();
  /** Cancels the manager asked for (retry, restart): their `cancelled` events are not the viewer's. */
  private readonly ownCancels = new Map<string, number>();

  private async cancelTask(id: string): Promise<void> {
    this.ownCancels.set(id, this.now());
    await this.stopTask(id, 'cancel');
  }

  /** An engine task whose download is gone or going (removed while it was being started). */
  private async discardTask(id: string, record: OfflineDownload): Promise<void> {
    if (!(await this.stopTask(id)) || !(await this.pathsReleased(id))) return;
    await this.engine
      .deletePath(downloadFolder(record.accountKey, record.id), record.volumeId)
      .catch(() => undefined);
  }

  private readonly stops = new Map<string, Promise<boolean>>();

  /** No unfinished engine task holds this id's paths any more: gone, completed or a tombstone (N3-02). */
  private async pathsReleased(id: string): Promise<boolean> {
    // A failed lookup defers to the engine, which refuses held paths itself (better than leaking the files).
    const task = await this.engine.get(id).catch(() => null);
    return !task || task.state === 'completed' || task.state === 'cancelled';
  }

  /** An engine task without a record (removed live, killed before the engine forgot it): stopped, then its files go. */
  private async sweepOrphan(task: DownloadTask): Promise<void> {
    if (!(await this.stopTask(task.id)) || !(await this.pathsReleased(task.id))) return;
    if (task.state === 'completed' || task.state === 'failed')
      await this.engine.deletePath(task.relativePath, task.volumeId).catch(() => undefined);
    const folder = task.relativePath.slice(0, task.relativePath.lastIndexOf('/'));
    if (folder.endsWith(`/${task.id}`))
      await this.engine.deletePath(folder, task.volumeId).catch(() => undefined);
  }

  /** Ends a task (cancel, or remove once finished) and its transfer; false if the app stopped while it was still ending. */
  private stopTask(id: string, call?: 'cancel'): Promise<boolean> {
    const running = this.stops.get(id);
    if (running) return running;
    const run = this.endTask(id, call).finally(() => this.stops.delete(id));
    this.stops.set(id, run);
    return run;
  }

  private async endTask(id: string, forced?: 'cancel'): Promise<boolean> {
    let call: 'cancel' | 'remove' | null = forced ?? null;
    let pending = 0;
    for (;;) {
      if (!call) {
        const task = await this.engine.get(id).catch(() => null);
        if (!task) return true;
        call = FINISHED_TASK.includes(task.state) ? 'remove' : 'cancel';
      }
      try {
        await (call === 'cancel' ? this.engine.cancel(id) : this.engine.remove(id));
        return true;
      } catch (error) {
        // Started again meanwhile (remove refuses unfinished tasks): a cancel ends any task.
        if (engineCode(error) === 'invalid_state' && call === 'remove') call = 'cancel';
        // A real error: the launch cleans up whatever the engine still holds.
        else if (!isPendingStop(error)) return true;
        else pending += 1;
      }
      if (this.disposed) return false;
      await delay(pendingRetryDelay(pending, this.deps.pendingRetryMs));
    }
  }

  /** Continues a paused / waiting / failed transfer, or prepares again when nothing was prepared. */
  private async continueTransfer(record: OfflineDownload): Promise<void> {
    const id = record.id;
    if (isRemovingDownload(this.store.get(id) ?? record)) return;
    if (this.store.get(id)?.restartReason) {
      await this.finishRestart(id);
      return;
    }
    if (!isPrepared(record)) {
      this.set(id, {
        state: record.downloadId ? 'preparing' : 'queued',
        error: null,
        retryAt: null,
      });
      if (record.downloadId) void this.poll(id);
      this.pump();
      return;
    }
    const intent = this.intentOf(id);
    const task = await this.engine.get(id).catch(() => null);
    if (task?.state !== 'cancelled' && this.stale(id, intent)) return;
    // The viewer cancelled it outside the app: a wake that gets here before the launch check removes it too.
    if (task?.state === 'cancelled') {
      await this.remove(id);
      return;
    }
    const refused = task?.state === 'failed' && task.error?.kind === 'http';
    const refusal = refused ? task.error?.httpStatus : undefined;
    if (refusal === 410 || refusal === 403 || refusal === 404) {
      await this.onRefusedFile(id, refusal);
      return;
    }
    if (task) {
      this.set(id, { state: 'queued', error: null, retryAt: null });
      await this.engine.resume(id).catch(() => undefined);
      // Paused, removed or signed out while the engine resumed: that intent wins, the task follows it.
      if (this.stale(id, intent)) {
        await this.followIntent(id);
        return;
      }
      const fresh = await this.engine.get(id).catch(() => null);
      if (fresh && !this.stale(id, intent)) await this.onTask(fresh);
      return;
    }
    const complete = await this.fileComplete(this.store.get(id)!);
    if (this.stale(id, intent)) return;
    if (complete) {
      await this.verify(id);
      return;
    }
    // No native task (a Pause before it started, or the engine lost it): it starts again from here.
    this.set(id, { state: 'queued', error: null, retryAt: null });
    const url = this.pendingUrls.get(id) ?? (await this.freshUrl(id, intent));
    if (!url || this.stale(id, intent)) return;
    await this.enqueue(id, url);
  }

  /** The capability URL from the server (needed when the engine lost the task). */
  private async freshUrl(id: string, intent = this.intentOf(id)): Promise<string | null> {
    const record = this.store.get(id);
    const server = record ? this.deps.serverFor(record.accountKey) : null;
    if (!record?.downloadId || !server) {
      if (record) this.waitForServer(id, errorOf('signed_out', this.now()));
      return null;
    }
    try {
      const response = await server.get(record.downloadId, { deviceId: this.store.installId() });
      if (this.stale(id, intent)) return null;
      if (response.state === 'ready' && response.fileUrlRevoked)
        return await this.renewedUrl(id, server, record.downloadId, intent);
      if (response.state === 'ready' && response.fileUrl) return server.baseUrl + response.fileUrl;
      if (response.state === 'failed') await this.handleServerState(id, response);
      else this.fail(id, 'download_not_found', { actions: ['retry'] });
      return null;
    } catch (error) {
      if (this.stale(id, intent)) return null;
      this.onRecordError(id, error);
      return null;
    }
  }

  private async onTask(task: DownloadTask): Promise<void> {
    const record = this.store.get(task.id);
    if (!record || record.state === 'done' || isRemovingDownload(record)) return;
    // Being verified: only the end of the task matters, not a late running/progress-like state.
    if (record.state === 'verifying' && task.state !== 'completed' && task.state !== 'failed')
      return;
    // A newer Pause or sign-out wins over what the engine still reports (a resume or start it was carrying out).
    if (this.heldByIntent(record) && !FINISHED_TASK.includes(task.state)) {
      if (task.state === 'paused') this.set(task.id, { bytesWritten: task.bytesWritten });
      else void this.followIntent(task.id);
      return;
    }
    switch (task.state) {
      case 'queued':
        if (record.state !== 'paused') this.set(task.id, { state: 'queued', error: null });
        return;
      case 'running':
        this.set(task.id, {
          state: 'downloading',
          error: null,
          retryAt: null,
          bytesWritten: task.bytesWritten,
        });
        this.backoff.delete(task.id);
        return;
      case 'paused':
        // Also the viewer's Pause in the notification or a system stop: it stays paused until resumed.
        if (record.state === 'failed') return;
        this.set(task.id, { state: 'paused', retryAt: null, bytesWritten: task.bytesWritten });
        return;
      case 'cancelled': {
        const own = this.ownCancels.get(task.id);
        this.ownCancels.delete(task.id);
        if (own !== undefined && this.now() - own < OWN_CANCEL_MS) return;
        // The viewer cancelled it outside the app (Android notification): the same as removing it here.
        await this.remove(task.id);
        return;
      }
      case 'waiting_network':
      case 'waiting_wifi':
        this.set(task.id, { state: task.state, error: null, bytesWritten: task.bytesWritten });
        return;
      case 'retrying': {
        // The engine's wait runs on a clock its `retryAt` (display) does not follow: no timer here may cut it short.
        this.engineWaits.add(task.id);
        const at = this.now();
        const after = task.error?.retryAfterMs;
        this.set(task.id, {
          state: 'waiting_server',
          retryAt: task.retryAt ?? (after !== undefined ? at + after : null),
          bytesWritten: task.bytesWritten,
          error: task.error
            ? errorOf(retryCode(task.error), at, { status: task.error.httpStatus })
            : null,
        });
        return;
      }
      case 'completed':
        await this.verify(task.id);
        return;
      case 'failed':
        await this.onTaskFailed(task.id, task.error);
        return;
      default:
        return;
    }
  }

  private async onTaskFailed(id: string, error: DownloadError | undefined): Promise<void> {
    const kind = error?.kind ?? 'unknown';
    const status = error?.httpStatus;
    const at = this.now();
    switch (kind) {
      case 'disk_full':
        this.set(id, {
          state: 'waiting_space',
          error: errorOf('disk_full', at),
          retryAt: null,
        });
        return;
      case 'validator_changed':
      case 'size_mismatch':
        await this.restart(id, kind);
        return;
      case 'network':
        this.waitForServer(id, errorOf('network', at), retryDelay(error?.retryAfterMs));
        return;
      case 'http':
        return this.onHttpFailure(id, status ?? 0, error?.retryAfterMs);
      case 'cancelled':
        return;
      default:
        if (kind === 'file_system' && error?.message === VOLUME_UNAVAILABLE) {
          this.waitForVolume(id);
          return;
        }
        this.fail(id, kind === 'file_system' ? 'file_system' : 'unknown');
    }
  }

  /** The removable volume of this download is not mounted: the record and its bytes stay until it returns. */
  private waitForVolume(id: string): void {
    this.set(id, {
      state: 'waiting_volume',
      error: errorOf(VOLUME_UNAVAILABLE, this.now()),
      retryAt: null,
    });
  }

  /** Whether the record's volume is known to be gone (the internal one never is; an unanswered engine counts as present). */
  private async volumeMissing(record: OfflineDownload): Promise<boolean> {
    if (record.volumeId === 'internal') return false;
    const volumes = await this.engine.volumes().catch(() => null);
    return !!volumes && !volumes.some((volume) => volume.id === record.volumeId);
  }

  /** A finished file that is not where it should be: an unmounted volume keeps it (not playable), else `file_missing`. */
  private async onFileGone(record: OfflineDownload, actions: string[]): Promise<void> {
    // intent: a finished file takes no Pause or sign-out, and set() never writes over a removal
    if (await this.volumeMissing(record)) {
      if (this.store.get(record.id))
        this.set(record.id, { error: errorOf(VOLUME_UNAVAILABLE, this.now()) });
      return;
    }
    if (this.store.get(record.id)) this.fail(record.id, 'file_missing', { actions });
  }

  private async onHttpFailure(id: string, status: number, retryAfterMs?: number): Promise<void> {
    const at = this.now();
    if (status === 410 || status === 403 || status === 404) {
      await this.onRefusedFile(id, status);
      return;
    }
    if (status === 416) {
      // The engine dropped the partial file: start the same file over once.
      if (this.restartedRange.has(id)) {
        this.fail(id, 'range_not_satisfiable', { status, actions: ['retry'] });
        return;
      }
      this.restartedRange.add(id);
      this.set(id, { bytesWritten: 0 });
      await this.engine.resume(id).catch(() => undefined);
      return;
    }
    // The engine's retries ended (e.g. 12 h of Retry-After without progress): wait here and resume it later.
    if (isRetriableStatus(status)) {
      this.waitForServer(
        id,
        errorOf(status === 429 ? 'too_many_downloads' : 'http', at, { status }),
        retryDelay(retryAfterMs)
      );
      return;
    }
    // 409 the server found another file; 412 an If-Match named an old ETag: the same file is gone either way.
    if (status === 409 || status === 412) {
      await this.restart(id, 'download_source_changed');
      return;
    }
    this.fail(id, 'http', { status, params: { status: String(status) } });
  }

  /** The file URL refused (410/404/403): the server record says why (never the engine's English diagnostic). */
  private async onRefusedFile(id: string, status: number): Promise<void> {
    const record = this.store.get(id);
    const server = record ? this.deps.serverFor(record.accountKey) : null;
    const at = this.now();
    if (!record?.downloadId || !server) {
      if (record) this.waitForServer(id, errorOf('signed_out', at, { status }));
      return;
    }
    if (status === 403) {
      await this.onForbidden(id, server, status);
      return;
    }
    const intent = this.intentOf(id);
    let response: DownloadResponse;
    try {
      response = await server.get(record.downloadId, { deviceId: this.store.installId() });
    } catch (error) {
      if (!this.stale(id, intent)) this.onRecordError(id, error);
      return;
    }
    // Paused, removed or signed out meanwhile: Resume asks again.
    if (!this.store.get(id) || this.stale(id, intent)) return;
    if (response.state === 'failed') {
      this.fail(id, response.error?.code ?? 'download_source_gone', {
        status,
        params: response.error?.params ?? undefined,
        actions: response.suggestedActions ?? ['otherVersion'],
      });
      return;
    }
    if (response.state !== 'ready') {
      this.fail(id, 'download_not_found', { status, actions: ['retry'] });
      return;
    }
    const expires = Date.parse(response.expiresAt ?? '');
    const expired =
      Number.isFinite(expires) &&
      expires <= serverNow(serverOfAccountKey(record.accountKey), at) + RENEW_SKEW_MS;
    // A 410 for a ready, valid, unrevoked link is a dead source; a 404 is a URL older than the current one.
    if (status === 410 && !response.fileUrlRevoked && !expired) {
      this.fail(id, 'download_source_gone', { status, actions: ['otherVersion'] });
      return;
    }
    if (!response.fileUrlRevoked && !expired && response.fileUrl) {
      await this.engine
        .resume(id, { url: server.baseUrl + response.fileUrl })
        .catch(() => undefined);
      return;
    }
    await this.renewAndResume(id, server, record.downloadId, intent);
  }

  private async renewAndResume(
    id: string,
    server: DownloadsServerApi,
    downloadId: string,
    intent = this.intentOf(id)
  ): Promise<void> {
    const url = await this.renewedUrl(id, server, downloadId, intent);
    if (!url || !this.store.get(id) || this.stale(id, intent)) return;
    // Revoked before the transfer began, the engine has no task yet: it starts on the new URL.
    const task = await this.engine.get(id).catch(() => null);
    if (this.stale(id, intent)) {
      this.pendingUrls.set(id, url);
      return;
    }
    if (task) await this.engine.resume(id, { url }).catch(() => undefined);
    else await this.enqueue(id, url);
  }

  /** `renew` (with this device's id): the new or extended file URL; null when it waits or failed (recorded). */
  private async renewedUrl(
    id: string,
    server: DownloadsServerApi,
    downloadId: string,
    intent = this.intentOf(id)
  ): Promise<string | null> {
    try {
      const renewed = await server.renew(downloadId, this.store.installId());
      // An older intent may keep the new link, never change the state.
      if (this.stale(id, intent) || !this.store.get(id)) {
        if (!this.store.get(id)) return null;
        if (renewed.expiresAt) this.set(id, { expiresAt: renewed.expiresAt });
        if (renewed.fileUrl) this.pendingUrls.set(id, server.baseUrl + renewed.fileUrl);
        return null;
      }
      this.set(id, { expiresAt: renewed.expiresAt ?? null, error: null });
      if (renewed.fileUrl) return server.baseUrl + renewed.fileUrl;
      this.fail(id, 'download_not_found', { actions: ['retry'] });
      return null;
    } catch (error) {
      if (!this.stale(id, intent)) this.onRecordError(id, error);
      return null;
    }
  }

  /** A record call failed: 401 waits for the next sign-in (never deletes), 403 asks the permissions, 404 prepares anew. */
  private onRecordError(id: string, error: unknown): void {
    if (!this.store.get(id)) return;
    const status = isAppError(error) ? error.status : undefined;
    if (status === 401) this.waitForServer(id, errorOf('signed_out', this.now(), { status }));
    else if (status === 403) {
      const server = this.deps.serverFor(this.store.get(id)!.accountKey);
      if (server) void this.onForbidden(id, server, status);
    } else if (status === 404) this.fail(id, 'download_not_found', { status, actions: ['retry'] });
    else if (isAppError(error) && error.code === 'download_not_ready')
      this.fail(id, error.code, { status, actions: ['retry'] });
    else this.prepareError(id, error);
  }

  /** 403: downloads off or age-gated; `renew`'s 403 names the reason, the record keeps it, a finished file stays. */
  private async onForbidden(id: string, server: DownloadsServerApi, status: number): Promise<void> {
    const record = this.store.get(id);
    if (!record) return;
    let refusal: { code: string; params?: Record<string, string> } | null = null;
    const intent = this.intentOf(id);
    if (record.downloadId && record.state !== 'done') {
      try {
        const renewed = await server.renew(record.downloadId, this.store.installId());
        if (this.stale(id, intent) || !this.store.get(id)) {
          if (renewed.expiresAt && this.store.get(id))
            this.set(id, { expiresAt: renewed.expiresAt });
          return;
        }
        // Allowed again (the policy changed back): continue with the renewed link.
        this.set(id, { expiresAt: renewed.expiresAt ?? null, error: null });
        const url = renewed.fileUrl ? server.baseUrl + renewed.fileUrl : undefined;
        await this.engine.resume(id, url ? { url } : undefined).catch(() => undefined);
        return;
      } catch (error) {
        if (this.stale(id, intent)) return;
        if (isAppError(error) && error.status === 401) {
          this.waitForServer(id, errorOf('signed_out', this.now(), { status: 401 }));
          return;
        }
        if (isAppError(error) && error.status === 403 && FORBIDDEN_CODES.has(error.code))
          refusal = { code: error.code, params: error.params ? { ...error.params } : undefined };
      }
    }
    let policy: ViewerPolicy | null = null;
    try {
      policy = await server.policy();
    } catch (error) {
      if (this.stale(id, intent)) return;
      // Signed out (e.g. the account was disabled): the record waits for the next sign-in.
      if (!refusal && isAppError(error) && error.status === 401) {
        this.waitForServer(id, errorOf('signed_out', this.now(), { status: 401 }));
        return;
      }
    }
    if (this.stale(id, intent) || !this.store.get(id)) return;
    if (policy) this.store.setPolicy(record.accountKey, policy);
    refusal ??= {
      code: policy && !policy.allowDownloads ? 'downloads_not_allowed' : 'age_restricted',
    };
    const current = this.store.get(id)!;
    const error = errorOf(refusal.code, this.now(), {
      status,
      params: refusal.params,
      actions: ['remove'],
    });
    if (current.state === 'done') {
      this.set(id, { error });
      return;
    }
    await this.engine.pause(id).catch(() => undefined);
    if (this.stale(id, intent)) return;
    this.fail(id, refusal.code, { status, params: refusal.params, actions: ['remove'] });
  }

  /** The file changed under the download: start over once (fresh preparation), then fail. */
  private async restart(id: string, reason: string): Promise<void> {
    const record = this.store.get(id);
    if (!record) return;
    if (record.restarts >= 1 && !record.restartReason) {
      this.fail(id, reason, { actions: ['retry', 'otherVersion'] });
      return;
    }
    // Marked before the first await: a Pause or sign-out meanwhile leaves the rest to the next Resume.
    if (!record.restartReason)
      this.set(id, { restarts: record.restarts + 1, restartReason: reason });
    await this.finishRestart(id);
  }

  /** The steps of a restart; each await rechecks the intent, and a newer one keeps the record (bytes included). */
  private async finishRestart(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record?.restartReason || this.busy.has(`restart:${id}`)) return;
    this.busy.add(`restart:${id}`);
    const intent = this.intentOf(id);
    try {
      await this.cancelTask(id);
      if (this.stale(id, intent)) return;
      if (record.relativePath)
        await this.engine.deletePath(record.relativePath, record.volumeId).catch(() => undefined);
      if (this.stale(id, intent)) return;
      await this.forgetServerRecord(record);
      if (this.stale(id, intent)) return;
      // The old server record is not gone yet (offline, signed out, a server error): nothing is prepared before it is.
      if (this.deletePending(record.accountKey, record.downloadId)) {
        const owner = record.accountKey;
        const signedOut = !this.deps.serverFor(owner) || this.parked(owner);
        this.waitForServer(id, errorOf(signedOut ? 'signed_out' : 'network', this.now()));
        return;
      }
      // A new lifecycle: whatever the old record still has in flight is stale and never attaches to this one.
      this.bumpIntent(id);
      this.lifecycles.set(id, this.lifecycleOf(id) + 1);
      this.set(id, {
        restartReason: null,
        downloadId: null,
        serverState: null,
        relativePath: null,
        sizeBytes: null,
        etag: null,
        bytesWritten: 0,
        state: 'queued',
        retryAt: null,
        error: QUIET_RESTARTS.has(record.restartReason)
          ? null
          : errorOf(record.restartReason, this.now()),
      });
    } finally {
      this.busy.delete(`restart:${id}`);
    }
    this.pump();
  }

  private async fileComplete(record: OfflineDownload): Promise<boolean> {
    if (!record.relativePath || record.sizeBytes === null) return false;
    const size = await this.engine.fileSize(record.relativePath, record.volumeId).catch(() => null);
    return size === record.sizeBytes;
  }

  private async verify(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record || record.state === 'done' || this.busy.has(`verify:${id}`)) return;
    this.busy.add(`verify:${id}`);
    try {
      this.set(id, { state: 'verifying', error: null, retryAt: null });
      // intent: verifying takes no Pause (pause() returns) or sign-out park; set() never writes over a removal
      if (!(await this.fileComplete(record))) {
        await this.restart(id, 'size_mismatch');
        return;
      }
      this.set(id, {
        state: 'done',
        bytesWritten: record.sizeBytes ?? record.bytesWritten,
        completedAt: this.now(),
        error: null,
      });
      // intent: the record is done; nothing transfers any more
      await this.engine.remove(id).catch(() => undefined);
      void this.snapshot(id);
      await this.completeOnServer(id);
    } finally {
      this.busy.delete(`verify:${id}`);
    }
  }

  private async completeOnServer(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record || record.state !== 'done' || record.serverCompleted || !record.downloadId) return;
    const server = this.deps.serverFor(record.accountKey);
    if (!server) return;
    if (this.completeRejected.has(id)) return;
    try {
      // intent: a finished record takes no Pause or sign-out; only its completion flag is written
      await server.complete(record.downloadId, record.sizeBytes ?? record.bytesWritten);
      this.set(id, { serverCompleted: true, error: null });
    } catch (error) {
      // intent: as above
      if (!isAppError(error)) return;
      // A record the server no longer has needs no completion.
      if (error.status === 404) this.set(id, { serverCompleted: true });
      // Downloads off or the title now age-gated: the file on the device stays playable; ask again next launch.
      else if (error.status === 403) this.completeRejected.add(id);
      else if (error.code === 'size_mismatch') {
        // The file plays here, but the server expected other bytes: say so once per launch.
        this.completeRejected.add(id);
        this.set(id, { error: errorOf(error.code, this.now(), { status: error.status }) });
      }
    }
  }

  private async completePending(owner?: string): Promise<void> {
    for (const record of this.store.all())
      if (
        record.state === 'done' &&
        !record.serverCompleted &&
        (!owner || record.accountKey === owner)
      )
        // intent: completeOnServer reads its record afresh
        await this.completeOnServer(record.id);
  }

  private async recheckSpace(): Promise<void> {
    if (!this.supported || this.disposed) return;
    // intent: the loop below reads every record afresh
    await this.recheckVolumes();
    for (const listed of this.store.all()) {
      if (listed.state !== 'waiting_space') continue;
      const intent = this.intentOf(listed.id);
      const available = await this.availableBytes(listed.id).catch(() => 0);
      if (this.stale(listed.id, intent)) continue;
      const record = this.store.get(listed.id);
      if (record?.state !== 'waiting_space') continue;
      const needed = (record.sizeBytes ?? record.estimatedBytes ?? 0) - record.bytesWritten;
      // intent: continueTransfer re-checks its own download; the loop reads the next one afresh
      if (needed <= available) await this.continueTransfer(record);
    }
  }

  // ---- server record and snapshot -------------------------------------------------------------

  /** A record prepared again under the same clientRef: the server must have forgotten the old one first. */
  private async forgetServerRecord(record: OfflineDownload): Promise<void> {
    this.queueServerDelete(record.accountKey, record.downloadId);
    await this.flushDeletes(record.accountKey);
  }

  /** Persisted before the local record goes: the server learns of it whenever it can (offline, signed out, killed). */
  private queueServerDelete(accountKey: string, downloadId: string | null): void {
    if (!downloadId || this.forgotten.has(accountKey)) return;
    const outbox = this.store.pendingDeletes();
    if (outbox.some((entry) => entry.accountKey === accountKey && entry.downloadId === downloadId))
      return;
    this.store.setPendingDeletes([...outbox, { accountKey, downloadId }]);
  }

  private deletePending(accountKey: string, downloadId: string | null): boolean {
    return (
      !!downloadId &&
      this.store
        .pendingDeletes()
        .some((entry) => entry.accountKey === accountKey && entry.downloadId === downloadId)
    );
  }

  /** Per profile, bumped at sign-in, sign-out and removal: older flushes and scans only acknowledge their own entries. */
  private readonly sessions = new Map<string, number>();

  private sessionOf(owner: string): number {
    return this.sessions.get(owner) ?? 0;
  }

  private bumpSession(owner: string): void {
    this.sessions.set(owner, this.sessionOf(owner) + 1);
  }

  private readonly flushes = new Map<string, { session: number; run: Promise<void> }>();

  /** Sends one profile's queued deletions (404 = already gone); the rest wait for the next reconnect or launch. */
  private flushDeletes(accountKey: string): Promise<void> {
    const session = this.sessionOf(accountKey);
    const running = this.flushes.get(accountKey);
    if (running?.session === session) return running.run.then(() => this.flushDeletes(accountKey));
    const run = this.flushNow(accountKey, session).finally(() => {
      if (this.flushes.get(accountKey)?.run === run) this.flushes.delete(accountKey);
    });
    this.flushes.set(accountKey, { session, run });
    return run;
  }

  /** The session of a profile that answered with 401: its outbox and scans wait for the next sign-in. */
  private readonly unauthorized = new Map<string, number>();

  private parked(owner: string, session = this.sessionOf(owner)): boolean {
    return this.unauthorized.get(owner) === session;
  }

  private async flushNow(accountKey: string, session: number): Promise<void> {
    const server = this.deps.serverFor(accountKey);
    if (!server || this.parked(accountKey, session)) return;
    const queue = this.store
      .pendingDeletes()
      .filter((entry) => entry.accountKey === accountKey)
      .map((entry) => entry.downloadId);
    let stopped = false;
    const current = () => !stopped && this.sessionOf(accountKey) === session;
    const worker = async () => {
      for (let id = queue.shift(); id && current(); id = queue.shift()) {
        const answer = await within(
          server.remove(id).then(
            () => 204,
            (error: unknown) => (isAppError(error) ? (error.status ?? 0) : 0)
          ),
          DELETE_TIMEOUT_MS,
          0
        );
        if (answer === 204 || answer === 404) this.dropServerDelete(accountKey, id);
        if (answer !== 401) continue;
        stopped = true;
        // Only this session is gone: a 401 that arrives after a new sign-in says nothing about the new one.
        if (this.sessionOf(accountKey) === session) this.unauthorized.set(accountKey, session);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, queue.length) }, worker));
  }

  /** Prepare POSTs per profile: a scan never deletes what one of them may just have created. */
  private readonly posting = new Map<string, { open: number; started: number }>();

  private postStarted(owner: string): void {
    const posts = this.posting.get(owner) ?? { open: 0, started: 0 };
    this.posting.set(owner, { open: posts.open + 1, started: posts.started + 1 });
  }

  private postEnded(owner: string): void {
    const posts = this.posting.get(owner);
    if (posts) this.posting.set(owner, { ...posts, open: posts.open - 1 });
  }

  private dropServerDelete(accountKey: string, downloadId: string): void {
    this.store.setPendingDeletes(
      this.store
        .pendingDeletes()
        .filter((entry) => entry.accountKey !== accountKey || entry.downloadId !== downloadId)
    );
  }

  /** Metadata and artwork next to the file, once per download (retried while the title is unknown). */
  snapshot(id: string): Promise<void> {
    const running = this.snapshots.get(id);
    if (running) return running;
    const task = this.takeSnapshot(id).finally(() => this.snapshots.delete(id));
    this.snapshots.set(id, task);
    return task;
  }

  private async takeSnapshot(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record || (record.meta.title && record.artwork.poster !== undefined)) return;
    const server = this.deps.serverFor(record.accountKey);
    if (!server) return;
    try {
      const snapshot = await server.snapshot(record.workId);
      const artwork: OfflineArtwork = {};
      const folder = downloadFolder(record.accountKey, record.id);
      for (const kind of ['poster', 'backdrop', 'still', 'logo'] as const) {
        const url = snapshot.artwork[kind];
        if (!url) {
          artwork[kind] = null;
          continue;
        }
        const path = `${folder}/${ARTWORK_FOLDER}/${kind}.${artworkExtension(url)}`;
        artwork[kind] = (await this.deps.artwork.fetch(url, path, record.volumeId)) ? path : null;
      }
      if (!this.store.get(id)) {
        await this.discardTask(id, record);
        return;
      }
      this.set(id, {
        meta: { ...record.meta, ...snapshot.meta, title: snapshot.meta.title || record.meta.title },
        artwork,
      });
    } catch {
      // Offline or the catalog failed: the next reconcile tries again.
    }
  }

  private readonly accessRetry = new Map<string, { attempts: number; nextAt: number }>();
  private readonly accessRuns = new Map<string, Promise<void>>();
  private readonly accessTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private online = true;

  /** Connectivity from the app: offline, no age-check timers run (the reconnect asks again). */
  setOnline(online: boolean): void {
    this.online = online;
    if (online) return;
    this.accessTimers.forEach((timer) => clearTimeout(timer));
    this.accessTimers.clear();
  }

  /** Unknown or old age verdicts are asked again online (launch, reconnect, wake, their retry timer); one run per profile. */
  revalidateAccess(owner: string): Promise<void> {
    const running = this.accessRuns.get(owner);
    if (running) return running;
    const run = this.checkAccess(owner).finally(() => {
      this.accessRuns.delete(owner);
      this.scheduleAccess(owner, true);
    });
    this.accessRuns.set(owner, run);
    return run;
  }

  /** Whether an age check of a download can do work: the one rule of the worker, the scheduler and `wake`. */
  private accessCheckNeeded(record: OfflineDownload | undefined, now: number): boolean {
    if (!record || isRemovingDownload(record) || accessVerified(record, now)) return false;
    const policy = this.store.policy(record.accountKey);
    return !policy || restricted(policy);
  }

  private async checkAccess(owner: string): Promise<void> {
    const server = this.deps.serverFor(owner);
    if (!server) return;
    for (const record of this.store.forAccount(owner)) {
      if (!this.accessCheckNeeded(record, this.now())) {
        this.accessRetry.delete(record.id);
        continue;
      }
      const retry = this.accessRetry.get(record.id);
      if (retry && retry.nextAt > this.now()) continue;
      const attempts = (retry?.attempts ?? 0) + 1;
      try {
        const verdict = await server.access(record.workId);
        const current = this.store.get(record.id);
        if (current) this.set(record.id, { meta: { ...current.meta, ...verdict } });
        // An answer that is still no verdict (rating_unavailable) is asked again, at most a day later.
        if (verdict.accessVerified === false)
          this.accessRetry.set(record.id, {
            attempts,
            nextAt: this.now() + accessRetryDelay(attempts, UNRATEABLE_RETRY_MAX_MS),
          });
        else this.accessRetry.delete(record.id);
      } catch {
        // Counted from the failure, not the run's start: a slow answer never leaves the retry due at once.
        this.accessRetry.set(record.id, {
          attempts,
          nextAt: this.now() + accessRetryDelay(attempts),
        });
      }
    }
  }

  /** Profiles with an age check due by `now`. */
  private dueAccessOwners(now: number): Set<string> {
    const owners = new Set<string>();
    for (const [id, retry] of this.accessRetry) {
      const record = this.store.get(id);
      if (record && retry.nextAt <= now && this.accessCheckNeeded(record, now))
        owners.add(record.accountKey);
    }
    return owners;
  }

  /** Drops retries that can no longer do work, then runs a profile's next age check at its due time (attached, online). */
  private scheduleAccess(owner: string, afterRun = false): void {
    const previous = this.accessTimers.get(owner);
    if (previous) clearTimeout(previous);
    this.accessTimers.delete(owner);
    const now = this.now();
    const server = this.deps.serverFor(owner);
    let due = Infinity;
    for (const [id, retry] of [...this.accessRetry]) {
      const record = this.store.get(id);
      if (!record || !this.accessCheckNeeded(record, now)) {
        this.accessRetry.delete(id);
        continue;
      }
      if (record.accountKey !== owner) continue;
      let next = retry;
      // Still due right after a run that could ask: the next backoff step, never a 0 ms timer.
      if (afterRun && server && next.nextAt <= now) {
        const attempts = next.attempts + 1;
        next = { attempts, nextAt: now + accessRetryDelay(attempts) };
        this.accessRetry.set(id, next);
      }
      due = Math.min(due, next.nextAt);
    }
    if (due === Infinity) return;
    if (!this.online || this.disposed || !this.subscriptions.length || !server) return;
    this.accessTimers.set(
      owner,
      setTimeout(
        () => {
          this.accessTimers.delete(owner);
          void this.revalidateAccess(owner);
        },
        Math.max(0, due - now)
      )
    );
  }

  // ---- launch ---------------------------------------------------------------------------------

  private async syncSettings(): Promise<void> {
    const engine: EngineSettings | null = await this.engine.getSettings().catch(() => null);
    const stored = this.store.settings();
    if (!engine) return;
    if (engine.wifiOnly !== stored.wifiOnly)
      await this.engine.setWifiOnly(stored.wifiOnly).catch(() => undefined);
    if (engine.maxConcurrent !== stored.maxConcurrent)
      await this.engine.setMaxConcurrent(stored.maxConcurrent).catch(() => undefined);
  }

  /** Launch: re-attaches transfers, picks up files finished meanwhile, cleans orphans on both sides, continues preparations. */
  async reconcile(): Promise<void> {
    if (!this.supported) return;
    // The list is a snapshot of this moment: a record whose intent moves meanwhile asks the engine again.
    const scanned = new Map(
      this.store.all().map((download) => [download.id, this.intentOf(download.id)])
    );
    // intent: the loop below reads each record afresh and compares it with `scanned`
    const tasks = await this.engine.list().catch(() => [] as DownloadTask[]);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    // Stops and removals can wait on a draining transfer for minutes: they never hold up the rest of the launch.
    const background: Promise<unknown>[] = [];
    for (const task of tasks) if (!this.store.get(task.id)) background.push(this.sweepOrphan(task));
    background.push(this.runCleanups(true));
    for (const listed of this.store.all()) {
      const intent = this.intentOf(listed.id);
      const moved = scanned.get(listed.id) !== intent;
      // intent: re-checked right below; a Resume or Pause since the scan makes the listed task too old
      const fresh = moved ? await this.freshTask(listed.id) : undefined;
      if (this.stale(listed.id, intent)) continue;
      // A viewer's action on an earlier await of this loop (Pause, removal) is seen here.
      const record = this.store.get(listed.id);
      if (!record) continue;
      // Started or polled in this session already (a download started right at launch).
      if (this.busy.has(record.id) || this.polls.has(record.id)) continue;
      // Removed before the app stopped: the removal continues where it was.
      if (isRemovingDownload(record)) {
        background.push(this.finishRemoval(record.id));
        continue;
      }
      // An interrupted restart goes on first: its old server record is deleted before anything is prepared.
      if (record.restartReason) {
        if (record.state !== 'paused' && record.state !== 'waiting_server')
          background.push(this.finishRestart(record.id));
        continue;
      }
      const task = moved ? fresh : byId.get(record.id);
      // Cancelled outside the app (notification) while JS was not running, whatever the record's state.
      if (task?.state === 'cancelled') {
        background.push(this.remove(record.id));
        continue;
      }
      if (record.state === 'done') {
        // intent: a finished record takes no Pause or sign-out; set() never writes over a removal
        if (task) await this.engine.remove(record.id).catch(() => undefined);
        // intent: as above
        if (!(await this.fileComplete(record))) await this.onFileGone(record, ['retry']);
        else if (record.error?.code === VOLUME_UNAVAILABLE) this.set(record.id, { error: null });
        continue;
      }
      if (record.state === 'failed') continue;
      if (!isPrepared(record)) {
        if (record.state === 'preparing' && record.downloadId) void this.poll(record.id);
        else if (record.state === 'preparing') this.set(record.id, { state: 'queued' });
        else if (record.state === 'waiting_server' && !record.retryAt)
          this.set(record.id, { state: 'queued' });
        continue;
      }
      if (task) {
        const follows =
          record.state === 'paused' && task.state !== 'paused' && task.state !== 'completed';
        // intent: the native task follows the record's pause; the loop reads the next record afresh
        if (follows) await this.engine.pause(record.id).catch(() => undefined);
        // intent: onTask re-reads its record and holds a newer Pause or sign-out
        if (!follows) await this.onTask(task);
        continue;
      }
      if (record.state === 'paused' || record.state === 'waiting_space') continue;
      // intent: continueTransfer captures and re-checks its own intent
      await this.continueTransfer(record);
    }
    // A preparation the app died before saving may exist on the server: the list is asked before it is prepared again.
    const held = this.store
      .all()
      .filter((download) => isUnsaved(download) && this.deps.serverFor(download.accountKey))
      .map((download) => download.id);
    if (held.length) {
      held.forEach((id) => this.adopting.add(id));
      this.adoptTimer = setTimeout(
        () => this.releaseAdopting(held),
        this.deps.adoptWaitMs ?? ADOPT_WAIT_MS
      );
    }
    // Local work first: queued downloads start and transfers re-attach before any server housekeeping.
    this.pump();
    this.emit();
    background.push(this.reconcileServers());
    if (this.store.settings().deleteWatched) {
      const owners = new Set(this.store.all().map((download) => download.accountKey));
      for (const owner of owners) background.push(this.removeWatched(owner));
    }
    for (const record of this.store.all()) if (!record.meta.title) void this.snapshot(record.id);
    void this.recheckBlocked(undefined, true);
    await Promise.all(background);
  }

  private async freshTask(id: string): Promise<DownloadTask | undefined> {
    return (await this.engine.get(id).catch(() => null)) ?? undefined;
  }

  /** Per profile with a server: deletes server records this device no longer has, completes finished ones. */
  async reconcileServers(): Promise<void> {
    const owners = new Set([
      ...this.store.all().map((download) => download.accountKey),
      ...this.store.pendingDeletes().map((entry) => entry.accountKey),
      ...this.knownOwners,
    ]);
    // Each profile on its own: one whose server hangs never holds up another's.
    await Promise.all(
      [...owners].flatMap((owner) => [
        this.reconcileServer(owner).then(() => this.completePending(owner)),
        this.revalidateAccess(owner),
      ])
    );
  }

  /** A preparation this app started but never recorded keeps its clientRef: it claims its record again first. */
  private unsaved(owner: string): boolean {
    return this.store.forAccount(owner).some(isUnsaved);
  }

  /** Downloads unsaved at launch: they wait for their profile's list (adopted there, else prepared again). */
  private readonly adopting = new Set<string>();
  private adoptTimer: ReturnType<typeof setTimeout> | null = null;

  private releaseAdopting(ids: readonly string[]): void {
    const held = ids.filter((id) => this.adopting.delete(id));
    if (!this.adopting.size && this.adoptTimer) clearTimeout(this.adoptTimer);
    if (!this.adopting.size) this.adoptTimer = null;
    if (held.length) this.pump();
  }

  private async reconcileServer(owner: string): Promise<void> {
    try {
      await this.checkServerRecords(owner);
    } finally {
      this.releaseAdopting(
        [...this.adopting].filter((id) => (this.store.get(id)?.accountKey ?? owner) === owner)
      );
    }
  }

  private async checkServerRecords(owner: string): Promise<void> {
    const server = this.deps.serverFor(owner);
    if (!server) return;
    const session = this.sessionOf(owner);
    await this.flushDeletes(owner);
    // A 401 parks the profile until it signs in again: no list, no orphan deletes.
    if (this.parked(owner, session) || this.sessionOf(owner) !== session) return;
    const posts = this.posting.get(owner)?.started ?? 0;
    const list = await server.list(this.store.installId()).catch(() => null);
    if (!list || this.sessionOf(owner) !== session) return;
    const installId = this.store.installId();
    const items = (list.items ?? []).filter(
      (item) => item.deviceId == null || sameDevice(item.deviceId, installId)
    );
    for (const item of items) {
      const record = item.clientRef ? this.store.get(item.clientRef.trim()) : undefined;
      if (record?.accountKey === owner && sameDevice(item.deviceId, installId))
        // intent: adopt reads its record afresh; the loop moves on to the next item
        await this.adopt(record.id, item);
    }
    // Checked again after the answer: a preparation started meanwhile or still unanswered may be one of these items.
    const posting = this.posting.get(owner);
    if (this.unsaved(owner)) return;
    if ((posting?.open ?? 0) > 0 || (posting?.started ?? 0) !== posts) return;
    const local = this.store.forAccount(owner);
    const known = new Set(local.map((download) => download.downloadId).filter(Boolean));
    const refs = new Set(local.map((download) => download.id));
    let orphans = 0;
    for (const item of items) {
      if (!item.thisDevice || !item.downloadId || known.has(item.downloadId)) continue;
      if (item.clientRef && refs.has(item.clientRef.trim())) continue;
      this.queueServerDelete(owner, item.downloadId);
      orphans += 1;
    }
    if (orphans) await this.flushDeletes(owner);
  }

  /** The server record of a preparation whose answer was never saved: taken over like that answer. */
  private async adopt(id: string, item: DownloadResponse): Promise<void> {
    const record = this.store.get(id);
    if (!record || !item.downloadId || record.downloadId || isPrepared(record)) return;
    // Its POST is still open: that answer is saved as usual.
    if (this.busy.has(id)) return;
    if (record.state === 'paused') {
      this.set(id, { downloadId: item.downloadId });
      return;
    }
    if (!ADOPTABLE.includes(record.state)) return;
    this.set(id, {
      downloadId: item.downloadId,
      state: 'preparing',
      serverState: item.state,
      error: null,
      retryAt: null,
    });
    // intent: handleServerState re-checks its own intent; poll reads the record afresh
    if (!(await this.handleServerState(id, item))) void this.poll(id);
  }

  private knownOwners: string[] = [];

  /** Profiles whose server records are checked even without local downloads (signed in on this device). */
  setKnownOwners(owners: string[]): void {
    // Signed out or removed: whatever that session still has in flight is stale.
    for (const owner of this.knownOwners) {
      if (owners.includes(owner)) continue;
      this.bumpSession(owner);
      for (const record of this.store.forAccount(owner)) this.bumpIntent(record.id, 'signOut');
    }
    this.knownOwners = owners;
    // Signed in again after the profile was removed: its server records count again.
    for (const owner of owners) this.forgotten.delete(owner);
  }
}
