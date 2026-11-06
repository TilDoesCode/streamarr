import type { DeviceProfile } from '@modules/media-caps';

import { isAppError } from '@/api/errors';
import type {
  DownloadEngine,
  DownloadError,
  DownloadSettings as EngineSettings,
  DownloadTask,
  StorageInfo,
} from '@/downloads/engine';

import { artworkExtension, type ArtworkFetcher } from './artwork';
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
/** A second `410` this soon after a renewal means the source itself is gone. */
export const RENEW_WINDOW_MS = 60_000;
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

/**
 * The device's download queue: server preparation → engine transfer → size check → `POST …/complete`.
 * Every step is written to the store first, so `reconcile()` continues after an app kill at any point.
 */
export class DownloadManager {
  readonly store: DownloadStore;
  private readonly engine: DownloadEngine;
  private readonly deps: DownloadManagerDeps;
  private readonly now: () => number;
  private readonly polls = new Map<string, AbortController>();
  private readonly busy = new Set<string>();
  private readonly backoff = new Map<string, number>();
  /** When a download's capability was renewed last (a second 410 right after means the source is gone). */
  private readonly renewed = new Map<string, number>();
  private readonly snapshots = new Map<string, Promise<void>>();
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
        if (!record || record.state === 'done') return;
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

  /** Queues movies/episodes for `accountKey`; an existing unfinished or done download of a work is returned as is. */
  async start(accountKey: string, items: DownloadRequestItem[]): Promise<OfflineDownload[]> {
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
    this.renewed.delete(id);
    const prepareFailed = !isPrepared(record) || record.error?.code === 'download_not_found';
    if (prepareFailed) {
      await this.forgetServerRecord(record);
      this.set(id, {
        state: 'queued',
        error: null,
        retryAt: null,
        downloadId: null,
        serverState: null,
        relativePath: null,
        sizeBytes: null,
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
        if (task.state === 'completed' || task.state === 'failed')
          await this.engine.remove(id).catch(() => undefined);
        else await this.engine.cancel(id).catch(() => undefined);
      }
      await this.engine
        .deletePath(downloadFolder(record.accountKey, record.id), record.volumeId)
        .catch(() => undefined);
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
    at: number = this.now()
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
    this.pump();
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
      if (!this.store.get(id)) {
        if (response.downloadId) await server.remove(response.downloadId).catch(() => undefined);
        return;
      }
      this.set(id, { downloadId: response.downloadId, serverState: response.state });
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
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, gap);
          controller.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) this.prepareError(id, error);
    } finally {
      if (this.polls.get(id) === controller) this.polls.delete(id);
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
    if (error.status === 404 && error.code === 'download_not_found') {
      this.fail(id, 'download_not_found', { status: 404, actions: ['retry'] });
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
    if (!response.fileUrl || sizeBytes === null) {
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
      state: 'queued',
    });
    void this.snapshot(id);
    await this.enqueue(id, server.baseUrl + response.fileUrl);
  }

  private async enqueue(id: string, url: string): Promise<void> {
    const record = this.store.get(id);
    if (!record?.relativePath || record.sizeBytes === null) return;
    const available = await this.availableBytes(id).catch(() => Infinity);
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
      if (task.url !== url && (task.state === 'failed' || task.state === 'paused'))
        await this.engine.resume(id, { url });
      else await this.onTask(task);
    } catch (error) {
      this.fail(id, 'file_system', { params: { engineCode: engineCode(error) ?? IO_CODE } });
    }
  }

  private readonly pendingUrls = new Map<string, string>();

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
    if (task && task.state !== 'cancelled') {
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
      if (response.state === 'ready' && response.fileUrl) return server.baseUrl + response.fileUrl;
      if (response.state === 'failed') await this.handleServerState(id, response);
      else this.fail(id, 'download_not_found', { actions: ['retry'] });
      return null;
    } catch (error) {
      this.prepareError(id, error);
      return null;
    }
  }

  private async onTask(task: DownloadTask): Promise<void> {
    const record = this.store.get(task.id);
    if (!record || record.state === 'done') return;
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
        this.set(task.id, { state: 'paused', bytesWritten: task.bytesWritten });
        return;
      case 'waiting_network':
      case 'waiting_wifi':
        this.set(task.id, { state: task.state, error: null, bytesWritten: task.bytesWritten });
        return;
      case 'retrying':
        this.set(task.id, {
          state: 'waiting_server',
          retryAt: task.retryAt ?? null,
          bytesWritten: task.bytesWritten,
          error: task.error
            ? errorOf(task.error.kind, this.now(), { status: task.error.httpStatus })
            : null,
        });
        return;
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
        this.waitForServer(id, errorOf('network', at));
        return;
      case 'http':
        return this.onHttpFailure(id, status ?? 0);
      case 'cancelled':
        return;
      default:
        this.fail(id, kind === 'file_system' ? 'file_system' : 'unknown');
    }
  }

  private async onHttpFailure(id: string, status: number): Promise<void> {
    const at = this.now();
    if (status === 410) {
      if (at - (this.renewed.get(id) ?? -Infinity) < RENEW_WINDOW_MS) {
        this.fail(id, 'download_source_gone', { status });
        return;
      }
      this.renewed.set(id, at);
      const record = this.store.get(id);
      const server = record ? this.deps.serverFor(record.accountKey) : null;
      if (!record?.downloadId || !server) {
        this.waitForServer(id, errorOf('signed_out', at));
        return;
      }
      try {
        const renewed = await server.renew(record.downloadId);
        this.set(id, { expiresAt: renewed.expiresAt ?? record.expiresAt, error: null });
        const url = renewed.fileUrl ? server.baseUrl + renewed.fileUrl : undefined;
        await this.engine.resume(id, url ? { url } : undefined);
      } catch (error) {
        if (isAppError(error) && error.status === 404) this.fail(id, 'download_not_found');
        else this.prepareError(id, error);
      }
      return;
    }
    if (status === 429 || status === 503 || status >= 500 || status === 0) {
      this.waitForServer(
        id,
        errorOf(status === 429 ? 'too_many_downloads' : 'http', at, { status })
      );
      return;
    }
    if (status === 403) {
      this.fail(id, 'downloads_not_allowed', { status });
      return;
    }
    if (status === 409) {
      await this.restart(id, 'download_source_changed');
      return;
    }
    if (status === 404) {
      this.fail(id, 'download_not_found', { status, actions: ['retry'] });
      return;
    }
    this.fail(id, 'http', { status, params: { status: String(status) } });
  }

  /** The file changed under the download: start over once (fresh preparation), then fail. */
  private async restart(id: string, reason: string): Promise<void> {
    const record = this.store.get(id);
    if (!record) return;
    if (record.restarts >= 1) {
      this.fail(id, reason, { actions: ['retry'] });
      return;
    }
    await this.engine.cancel(id).catch(() => undefined);
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
    try {
      await server.complete(record.downloadId, record.sizeBytes ?? record.bytesWritten);
      this.set(id, { serverCompleted: true });
    } catch (error) {
      // A record the server no longer has needs no completion.
      if (isAppError(error) && (error.status === 404 || error.status === 409))
        this.set(id, { serverCompleted: true });
    }
  }

  private async completePending(): Promise<void> {
    for (const record of this.store.all())
      if (record.state === 'done' && !record.serverCompleted)
        await this.completeOnServer(record.id);
  }

  private async recheckSpace(): Promise<void> {
    if (!this.supported || this.disposed) return;
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
      if (!this.store.get(id)) return;
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

  /**
   * Engine ↔ store ↔ server at launch: re-attaches running transfers, picks up files that finished while the
   * app was gone, cleans orphans on both sides and continues preparations.
   */
  async reconcile(): Promise<void> {
    if (!this.supported) return;
    const tasks = await this.engine.list().catch(() => [] as DownloadTask[]);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
      if (this.store.get(task.id)) continue;
      if (task.state === 'completed' || task.state === 'failed') {
        await this.engine.remove(task.id).catch(() => undefined);
        await this.engine.deletePath(task.relativePath, task.volumeId).catch(() => undefined);
      } else await this.engine.cancel(task.id).catch(() => undefined);
    }
    for (const record of this.store.all()) {
      const task = byId.get(record.id);
      if (record.state === 'done') {
        if (task) await this.engine.remove(record.id).catch(() => undefined);
        if (!(await this.fileComplete(record)))
          this.fail(record.id, 'file_missing', { actions: ['retry'] });
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
        // A preparation this app started but never recorded (killed between POST and save) keeps its clientRef.
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
