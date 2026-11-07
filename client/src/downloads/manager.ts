import type { DeviceProfile } from '@modules/media-caps';

import { isAppError } from '@/api/errors';
import { serverNow } from '@/lib/server-clock';
import type {
  DownloadEngine,
  DownloadError,
  DownloadSettings as EngineSettings,
  DownloadTask,
  StorageInfo,
} from '@/downloads/engine';

import { artworkExtension, type ArtworkFetcher } from './artwork';
import { allowedAgain, isBlockedDownload } from './blocked';
import { downloadFolder, filePathOf, newDownloadId, normalizeSeasonId, workPartsOf } from './keys';
import type { DownloadsServerApi } from './server';
import type { DownloadStore } from './store';
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
/** A work counts as watched from here (docs/viewers.md: played at 90 %). */
export const PLAYED_FRACTION = 0.9;

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
/** The server prepared it: the engine transfers (or transferred) the file. */
export const isPrepared = (download: OfflineDownload) =>
  download.relativePath !== null && download.sizeBytes !== null && download.engine !== null;
/** Bytes this download still needs on the device. */
export const remainingBytes = (download: OfflineDownload) =>
  download.state === 'done' || download.state === 'failed'
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
};

type Listener = () => void;
const IO_CODE = 'io';
/** The reason shown while the engine waits to retry (Retry-After of 429/503, other 5xx, the network). */
function retryCode(error: DownloadError): string {
  if (error.httpStatus === 429) return 'too_many_downloads';
  if (error.httpStatus === 503) return 'download_source_unavailable';
  return error.kind === 'http' ? 'http' : 'network';
}

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
/** Statuses the engine retries natively; after its deadline they wait here instead of failing. */
const isRetriableStatus = (status: number) =>
  status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
/** States a late engine event (a final progress after `completed`) must never turn back into a transfer. */
const SETTLED: readonly OfflineDownloadState[] = ['verifying', 'done', 'failed'];

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
    const next = this.store.update(id, patch);
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
    const created: OfflineDownload[] = [];
    for (const item of items) {
      const parts = workPartsOf(item.workId);
      if (!parts) throw Object.assign(new Error('invalid_work_id'), { code: 'invalid_work_id' });
      const existing = this.store
        .forAccount(accountKey)
        .find((download) => download.workId === item.workId);
      if (existing && existing.state !== 'failed') {
        created.push(existing);
        continue;
      }
      if (existing) await this.remove(existing.id);
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
    this.polls.get(id)?.abort();
    if (isPrepared(record)) await this.engine.pause(id).catch(() => undefined);
    this.set(id, { state: 'paused', retryAt: null });
    this.pump();
  }

  async resume(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record || (record.state !== 'paused' && !record.state.startsWith('waiting_'))) return;
    this.backoff.delete(id);
    await this.continueTransfer(record);
  }

  /** A failed download tries again: a failed server preparation is prepared anew, a transfer continues. */
  async retry(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record) return;
    if (record.state !== 'failed' && !record.state.startsWith('waiting_')) return;
    this.backoff.delete(id);
    const prepareFailed = !isPrepared(record) || PREPARE_AGAIN.has(record.error?.code ?? '');
    if (prepareFailed) {
      await this.cancelTask(id);
      if (record.relativePath)
        await this.engine.deletePath(record.relativePath, record.volumeId).catch(() => undefined);
      await this.forgetServerRecord(record);
      this.set(id, {
        state: 'queued',
        error: null,
        retryAt: null,
        downloadId: null,
        serverState: null,
        relativePath: null,
        sizeBytes: null,
        etag: null,
        bytesWritten: 0,
      });
      this.pump();
      return;
    }
    await this.continueTransfer(record);
  }

  /** Stops and deletes a download (file, artwork, partial data and the server record). */
  async remove(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record) return;
    this.polls.get(id)?.abort();
    this.polls.delete(id);
    this.backoff.delete(id);
    this.store.delete(id);
    this.emit();
    if (this.supported) {
      const task = await this.engine.get(id).catch(() => null);
      if (task) {
        // Finished, failed and the viewer's cancelled tombstones are forgotten; anything running is cancelled.
        if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled')
          await this.engine.remove(id).catch(() => undefined);
        else await this.engine.cancel(id).catch(() => undefined);
      }
      await this.engine
        .deletePath(downloadFolder(record.accountKey, record.id), record.volumeId)
        .catch(() => undefined);
      if (record.relativePath)
        await this.engine.deletePath(record.relativePath, record.volumeId).catch(() => undefined);
    }
    await this.forgetServerRecord(record);
    this.pump();
    void this.recheckSpace();
  }

  /** Same as `remove` (an unfinished download is cancelled the same way). */
  cancel(id: string): Promise<void> {
    return this.remove(id);
  }

  async removeMany(ids: string[]): Promise<void> {
    for (const id of ids) await this.remove(id);
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

  /** Every download of a profile (sign-out or removal with "delete downloads"). */
  async removeAll(accountKey: string): Promise<void> {
    await this.removeMany(this.store.forAccount(accountKey).map((download) => download.id));
    this.store.deletePositions(accountKey);
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
  }

  private readonly unblockedAt = new Map<string, number>();
  private readonly policyAskedAt = new Map<string, number>();

  /**
   * Downloads blocked by `downloads_not_allowed` / `age_restricted` whose persisted permissions allow them again
   * (launch, reconnect, every `/viewer/me` refresh): the server is asked, and a transfer it serves continues on its bytes.
   */
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
      await this.unblock(record.id);
    }
    // Still blocked by the last known permissions: they are read again (an admin may have changed them meanwhile).
    for (const owner of stale) {
      if (now - (this.policyAskedAt.get(owner) ?? -Infinity) < UNBLOCK_GAP_MS) continue;
      this.policyAskedAt.set(owner, now);
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
    try {
      const renewed = await server.renew(record.downloadId, this.store.installId());
      if (!this.store.get(id) || !renewed.fileUrl) return;
      const url = server.baseUrl + renewed.fileUrl;
      this.set(id, {
        state: 'queued',
        error: null,
        retryAt: null,
        expiresAt: renewed.expiresAt ?? null,
      });
      const task = await this.engine.get(id).catch(() => null);
      if (!task) {
        await this.enqueue(id, url);
        return;
      }
      await this.engine.resume(id, { url }).catch(() => undefined);
      const fresh = await this.engine.get(id).catch(() => null);
      if (fresh) await this.onTask(fresh);
    } catch (error) {
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

  /** Saves the viewer's position of a work (any download of it); `played` from 90 %. */
  recordPosition(
    accountKey: string,
    workId: string,
    seconds: number,
    durationSeconds: number | null,
    at: number = serverNow(this.now())
  ): LocalPosition {
    const previous = this.store.position(accountKey, workId);
    const played =
      !!durationSeconds && durationSeconds > 0 && seconds >= durationSeconds * PLAYED_FRACTION;
    const position: LocalPosition = {
      seconds: played ? 0 : Math.max(0, seconds),
      durationSeconds: durationSeconds ?? previous?.durationSeconds ?? null,
      at,
      played: played || (!!previous?.played && seconds < 1),
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
    for (const record of this.store.all()) {
      if (record.state === 'waiting_server' && (record.retryAt ?? 0) <= now)
        void this.continueTransfer(record);
      if (record.state === 'preparing' && record.downloadId && !this.polls.has(record.id))
        void this.poll(record.id);
    }
    void this.recheckSpace();
    void this.completePending();
    void this.renewExpiring();
    void this.recheckBlocked();
    this.pump();
  }

  /** Profiles that just signed in: their downloads waiting for a sign-in continue now, not at their backoff time. */
  resumeSignedOut(accountKeys: readonly string[]): void {
    const owners = new Set(accountKeys);
    const now = this.now();
    for (const record of this.store.all())
      if (
        owners.has(record.accountKey) &&
        record.state === 'waiting_server' &&
        record.error?.code === 'signed_out'
      )
        this.set(record.id, { retryAt: now });
    this.wake();
  }

  /** Downloads on a volume that came back: waiting ones continue, finished ones play again. */
  private async recheckVolumes(): Promise<void> {
    const waiting = this.store
      .all()
      .filter(
        (record) => record.state === 'waiting_volume' || record.error?.code === VOLUME_UNAVAILABLE
      );
    if (!waiting.length) return;
    const volumes = await this.engine.volumes().catch(() => null);
    if (!volumes) return;
    const mounted = new Set(volumes.map((volume) => volume.id));
    for (const record of waiting) {
      if (!mounted.has(record.volumeId)) continue;
      if (record.state === 'done') {
        this.set(record.id, { error: null });
        continue;
      }
      if (record.state !== 'waiting_volume') continue;
      // The engine continues by itself when the volume returns; only a task still failed is resumed here.
      const task = await this.engine.get(record.id).catch(() => null);
      if (task && task.state !== 'failed') await this.onTask(task);
      else await this.continueTransfer(record);
    }
  }

  /** Unfinished downloads keep a valid file link (a long Wi-Fi or space wait outlives 30 days otherwise). */
  private async renewExpiring(): Promise<void> {
    const now = serverNow(this.now());
    for (const record of this.store.all()) {
      const expires = Date.parse(record.expiresAt ?? '');
      if (!record.downloadId || !isPrepared(record) || !isActiveDownload(record)) continue;
      if (!Number.isFinite(expires) || expires - now > RENEW_AHEAD_MS) continue;
      const server = this.deps.serverFor(record.accountKey);
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
      .filter((download) => download.state === 'waiting_server' && download.retryAt)
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
    try {
      const device = await this.deps.deviceProfile();
      const response = await server.prepare({
        workId: record.workId,
        releaseId: record.releaseId,
        device,
        engine: this.engineChoice.get(id) ?? 'auto',
        deviceName: this.deps.deviceName?.(),
        deviceId: this.store.installId(),
        clientRef: id,
      });
      const current = this.store.get(id);
      if (!current) {
        if (response.downloadId) await server.remove(response.downloadId).catch(() => undefined);
        return;
      }
      // Paused meanwhile: keep the server's id; Resume polls it and starts the transfer.
      const paused = current.state === 'paused';
      this.set(id, {
        downloadId: response.downloadId,
        serverState: paused ? null : response.state,
        ...(paused ? null : { state: 'preparing' as const }),
      });
      if (paused) return;
      if (!(await this.handleServerState(id, response))) void this.poll(id);
    } catch (error) {
      this.prepareError(id, error);
    } finally {
      this.busy.delete(id);
      this.pump();
    }
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
    try {
      for (;;) {
        const current = this.store.get(id);
        if (!current?.downloadId || current.state !== 'preparing' || controller.signal.aborted)
          return;
        const response = await server.get(current.downloadId, {
          waitMs: this.deps.prepareWaitMs ?? PREPARE_WAIT_MS,
          deviceId: this.store.installId(),
          signal: controller.signal,
        });
        if (controller.signal.aborted || !this.store.get(id)) return;
        if (await this.handleServerState(id, response)) return;
        const gap = Math.max(response.pollAfterMs ?? 0, this.deps.pollGapMs ?? MIN_POLL_GAP_MS);
        await abortableDelay(gap, controller.signal);
      }
    } catch (error) {
      if (!controller.signal.aborted) this.prepareError(id, error);
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
      case 'completed': {
        // The server already holds this download as completed (e.g. a reinstall): prepare a fresh one.
        const record = this.store.get(id)!;
        await this.forgetServerRecord(record);
        this.set(id, { downloadId: null, state: 'queued', serverState: null });
        this.pump();
        return true;
      }
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
        : await this.renewedUrl(id, server, record.downloadId ?? response.downloadId ?? '');
    if (!url || !this.store.get(id)) return;
    if (record.state === 'paused') {
      this.pendingUrls.set(id, url);
      return;
    }
    await this.enqueue(id, url);
  }

  private async enqueue(id: string, url: string): Promise<void> {
    const before = this.store.get(id);
    if (!before?.relativePath || before.sizeBytes === null) return;
    const available = await this.availableBytes(id).catch(() => Infinity);
    // Removed or paused while the space was measured: nothing may start.
    const record = this.store.get(id);
    if (!record?.relativePath || record.sizeBytes === null) return;
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
      this.pendingUrls.delete(id);
      if (!this.store.get(id)) {
        await this.discardTask(id, record);
        return;
      }
      if (task.url !== url && (task.state === 'failed' || task.state === 'paused'))
        await this.engine.resume(id, { url });
      else await this.onTask(task);
    } catch (error) {
      this.fail(id, 'file_system', { params: { engineCode: engineCode(error) ?? IO_CODE } });
    }
  }

  private readonly pendingUrls = new Map<string, string>();
  /** Cancels the manager asked for (retry, restart): their `cancelled` events are not the viewer's. */
  private readonly ownCancels = new Map<string, number>();

  private async cancelTask(id: string): Promise<void> {
    this.ownCancels.set(id, this.now());
    await this.engine.cancel(id).catch(() => undefined);
  }

  /** An engine task whose download is gone (removed while it was being started). */
  private async discardTask(id: string, record: OfflineDownload): Promise<void> {
    await this.engine.cancel(id).catch(() => undefined);
    await this.engine.remove(id).catch(() => undefined);
    await this.engine
      .deletePath(downloadFolder(record.accountKey, record.id), record.volumeId)
      .catch(() => undefined);
  }

  /** Continues a paused / waiting / failed transfer, or prepares again when nothing was prepared. */
  private async continueTransfer(record: OfflineDownload): Promise<void> {
    const id = record.id;
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
    const task = await this.engine.get(id).catch(() => null);
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
      const fresh = await this.engine.get(id).catch(() => null);
      if (fresh) await this.onTask(fresh);
      return;
    }
    if (await this.fileComplete(this.store.get(id)!)) {
      await this.verify(id);
      return;
    }
    const url = this.pendingUrls.get(id) ?? (await this.freshUrl(id));
    if (url) await this.enqueue(id, url);
  }

  /** The capability URL from the server (needed when the engine lost the task). */
  private async freshUrl(id: string): Promise<string | null> {
    const record = this.store.get(id);
    const server = record ? this.deps.serverFor(record.accountKey) : null;
    if (!record?.downloadId || !server) {
      if (record) this.waitForServer(id, errorOf('signed_out', this.now()));
      return null;
    }
    try {
      const response = await server.get(record.downloadId, { deviceId: this.store.installId() });
      if (response.state === 'ready' && response.fileUrlRevoked)
        return await this.renewedUrl(id, server, record.downloadId);
      if (response.state === 'ready' && response.fileUrl) return server.baseUrl + response.fileUrl;
      if (response.state === 'failed') await this.handleServerState(id, response);
      else this.fail(id, 'download_not_found', { actions: ['retry'] });
      return null;
    } catch (error) {
      this.onRecordError(id, error);
      return null;
    }
  }

  private async onTask(task: DownloadTask): Promise<void> {
    const record = this.store.get(task.id);
    if (!record || record.state === 'done') return;
    // Being verified: only the end of the task matters, not a late running/progress-like state.
    if (record.state === 'verifying' && task.state !== 'completed' && task.state !== 'failed')
      return;
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
    let response: DownloadResponse;
    try {
      response = await server.get(record.downloadId, { deviceId: this.store.installId() });
    } catch (error) {
      this.onRecordError(id, error);
      return;
    }
    if (!this.store.get(id)) return;
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
    const expired = Number.isFinite(expires) && expires <= serverNow(at) + RENEW_SKEW_MS;
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
    await this.renewAndResume(id, server, record.downloadId);
  }

  private async renewAndResume(
    id: string,
    server: DownloadsServerApi,
    downloadId: string
  ): Promise<void> {
    const url = await this.renewedUrl(id, server, downloadId);
    if (!url || !this.store.get(id)) return;
    // Revoked before the transfer began, the engine has no task yet: it starts on the new URL.
    if (await this.engine.get(id).catch(() => null))
      await this.engine.resume(id, { url }).catch(() => undefined);
    else await this.enqueue(id, url);
  }

  /** `renew` (with this device's id): the new or extended file URL; null when it waits or failed (recorded). */
  private async renewedUrl(
    id: string,
    server: DownloadsServerApi,
    downloadId: string
  ): Promise<string | null> {
    try {
      const renewed = await server.renew(downloadId, this.store.installId());
      if (!this.store.get(id)) return null;
      this.set(id, { expiresAt: renewed.expiresAt ?? null, error: null });
      if (renewed.fileUrl) return server.baseUrl + renewed.fileUrl;
      this.fail(id, 'download_not_found', { actions: ['retry'] });
      return null;
    } catch (error) {
      this.onRecordError(id, error);
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

  /**
   * 403: downloads turned off or the age rules now exclude the work. `renew` applies the file URL's checks, so its 403
   * names the reason (with the age params); the transfer ends, the record keeps the reason, a finished file stays.
   */
  private async onForbidden(id: string, server: DownloadsServerApi, status: number): Promise<void> {
    const record = this.store.get(id);
    if (!record) return;
    let refusal: { code: string; params?: Record<string, string> } | null = null;
    if (record.downloadId && record.state !== 'done') {
      try {
        const renewed = await server.renew(record.downloadId, this.store.installId());
        if (!this.store.get(id)) return;
        // Allowed again (the policy changed back): continue with the renewed link.
        this.set(id, { expiresAt: renewed.expiresAt ?? null, error: null });
        const url = renewed.fileUrl ? server.baseUrl + renewed.fileUrl : undefined;
        await this.engine.resume(id, url ? { url } : undefined).catch(() => undefined);
        return;
      } catch (error) {
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
      this.store.setPolicy(record.accountKey, policy);
    } catch (error) {
      // Signed out (e.g. the account was disabled): the record waits for the next sign-in.
      if (!refusal && isAppError(error) && error.status === 401) {
        this.waitForServer(id, errorOf('signed_out', this.now(), { status: 401 }));
        return;
      }
    }
    if (!this.store.get(id)) return;
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
    this.fail(id, refusal.code, { status, params: refusal.params, actions: ['remove'] });
  }

  /** The file changed under the download: start over once (fresh preparation), then fail. */
  private async restart(id: string, reason: string): Promise<void> {
    const record = this.store.get(id);
    if (!record) return;
    if (record.restarts >= 1) {
      this.fail(id, reason, { actions: ['retry', 'otherVersion'] });
      return;
    }
    await this.cancelTask(id);
    if (record.relativePath)
      await this.engine.deletePath(record.relativePath, record.volumeId).catch(() => undefined);
    await this.forgetServerRecord(record);
    this.set(id, {
      restarts: record.restarts + 1,
      downloadId: null,
      relativePath: null,
      sizeBytes: null,
      etag: null,
      bytesWritten: 0,
      state: 'queued',
      error: errorOf(reason, this.now()),
    });
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
      await server.complete(record.downloadId, record.sizeBytes ?? record.bytesWritten);
      this.set(id, { serverCompleted: true, error: null });
    } catch (error) {
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

  private async completePending(): Promise<void> {
    for (const record of this.store.all())
      if (record.state === 'done' && !record.serverCompleted)
        await this.completeOnServer(record.id);
  }

  private async recheckSpace(): Promise<void> {
    if (!this.supported || this.disposed) return;
    await this.recheckVolumes();
    for (const record of this.store.all()) {
      if (record.state !== 'waiting_space') continue;
      const available = await this.availableBytes(record.id).catch(() => 0);
      const needed = (record.sizeBytes ?? record.estimatedBytes ?? 0) - record.bytesWritten;
      if (needed <= available) await this.continueTransfer(record);
    }
  }

  // ---- server record and snapshot -------------------------------------------------------------

  private readonly pendingDeletes: { accountKey: string; downloadId: string }[] = [];

  private async forgetServerRecord(record: OfflineDownload): Promise<void> {
    if (!record.downloadId) return;
    const server = this.deps.serverFor(record.accountKey);
    try {
      if (!server) throw new Error('signed_out');
      await server.remove(record.downloadId);
    } catch (error) {
      if (isAppError(error) && error.status === 404) return;
      this.pendingDeletes.push({ accountKey: record.accountKey, downloadId: record.downloadId });
      this.store.setPendingDeletes(this.pendingDeletes);
    }
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
        const path = `${folder}/art/${kind}.${artworkExtension(url)}`;
        artwork[kind] = (await this.deps.artwork.fetch(url, path, record.volumeId)) ? path : null;
      }
      if (!this.store.get(id)) {
        await this.engine.deletePath(folder, record.volumeId).catch(() => undefined);
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
    const tasks = await this.engine.list().catch(() => [] as DownloadTask[]);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
      if (this.store.get(task.id)) continue;
      if (task.state === 'completed' || task.state === 'failed') {
        await this.engine.remove(task.id).catch(() => undefined);
        await this.engine.deletePath(task.relativePath, task.volumeId).catch(() => undefined);
      } else if (task.state === 'cancelled') {
        // A tombstone whose record is gone already (removed live, the engine kept it over a kill).
        await this.engine.remove(task.id).catch(() => undefined);
      } else await this.engine.cancel(task.id).catch(() => undefined);
      // Only once the task is gone may its folder go (the engine refuses paths of unfinished tasks).
      const folder = task.relativePath.slice(0, task.relativePath.lastIndexOf('/'));
      if (folder.endsWith(`/${task.id}`))
        await this.engine.deletePath(folder, task.volumeId).catch(() => undefined);
    }
    for (const record of this.store.all()) {
      // Started or polled in this session already (a download started right at launch).
      if (this.busy.has(record.id) || this.polls.has(record.id)) continue;
      const task = byId.get(record.id);
      // Cancelled outside the app (notification) while JS was not running, whatever the record's state.
      if (task?.state === 'cancelled') {
        await this.remove(record.id);
        continue;
      }
      if (record.state === 'done') {
        if (task) await this.engine.remove(record.id).catch(() => undefined);
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
        if (record.state === 'paused' && task.state !== 'paused' && task.state !== 'completed')
          await this.engine.pause(record.id).catch(() => undefined);
        else await this.onTask(task);
        continue;
      }
      if (record.state === 'paused' || record.state === 'waiting_space') continue;
      await this.continueTransfer(record);
    }
    this.loadPendingDeletes();
    await this.reconcileServers();
    if (this.store.settings().deleteWatched) {
      const owners = new Set(this.store.all().map((download) => download.accountKey));
      for (const owner of owners) await this.removeWatched(owner);
    }
    for (const record of this.store.all()) if (!record.meta.title) void this.snapshot(record.id);
    void this.recheckBlocked(undefined, true);
    this.pump();
    this.emit();
  }

  private loadPendingDeletes(): void {
    this.pendingDeletes.splice(0, this.pendingDeletes.length, ...this.store.pendingDeletes());
  }

  /** Per profile with a server: deletes server records this device no longer has, completes finished ones. */
  async reconcileServers(): Promise<void> {
    const owners = new Set([
      ...this.store.all().map((download) => download.accountKey),
      ...this.pendingDeletes.map((entry) => entry.accountKey),
      ...this.knownOwners,
    ]);
    for (const owner of owners) {
      const server = this.deps.serverFor(owner);
      if (!server) continue;
      for (const entry of this.pendingDeletes.filter((item) => item.accountKey === owner)) {
        const ok = await server
          .remove(entry.downloadId)
          .then(() => true)
          .catch((error: unknown) => isAppError(error) && error.status === 404);
        if (ok) this.pendingDeletes.splice(this.pendingDeletes.indexOf(entry), 1);
      }
      this.store.setPendingDeletes(this.pendingDeletes);
      // A preparation this app started but never recorded keeps its clientRef: it claims its record again first.
      const unsaved = this.store
        .forAccount(owner)
        .some((download) => !download.downloadId && !isPrepared(download));
      if (unsaved) continue;
      const list = await server.list(this.store.installId()).catch(() => null);
      if (!list) continue;
      const known = new Set(
        this.store
          .forAccount(owner)
          .map((download) => download.downloadId)
          .filter(Boolean)
      );
      for (const item of list.items ?? []) {
        if (!item.thisDevice || !item.downloadId || known.has(item.downloadId)) continue;
        await server.remove(item.downloadId).catch(() => undefined);
      }
    }
    await this.completePending();
  }

  private knownOwners: string[] = [];

  /** Profiles whose server records are checked even without local downloads (signed in on this device). */
  setKnownOwners(owners: string[]): void {
    this.knownOwners = owners;
  }
}
