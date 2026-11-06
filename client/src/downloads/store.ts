import type { KeyValueStorage } from '@/accounts/account-store';

import { accountFolder } from './keys';
import type {
  DownloadSettings,
  LocalPosition,
  OfflineDownload,
  OfflineDownloadState,
} from './types';

export const DOWNLOADS_STORAGE_ID = 'streamarr.downloads';
/** Bump with a step in `MIGRATIONS` whenever a stored shape changes incompatibly. */
export const DOWNLOADS_SCHEMA = 1;
/** Progress is kept in memory and written at most this often (state changes are written at once). */
export const PROGRESS_WRITE_MS = 5_000;
/** Positions kept per account (the newest win). */
const MAX_POSITIONS = 1_000;

export type DownloadsStorage = KeyValueStorage & { getAllKeys(): string[] };

export const DEFAULT_SETTINGS: DownloadSettings = {
  wifiOnly: true,
  maxConcurrent: 2,
  deleteWatched: false,
};

const STATES: readonly OfflineDownloadState[] = [
  'queued',
  'preparing',
  'downloading',
  'paused',
  'waiting_wifi',
  'waiting_network',
  'waiting_server',
  'waiting_space',
  'verifying',
  'done',
  'failed',
];

const RECORD = 'd/';
const POSITIONS = 'p/';
const recordKey = (download: Pick<OfflineDownload, 'accountKey' | 'id'>) =>
  `${RECORD}${accountFolder(download.accountKey)}/${download.id}`;

type Migration = (storage: DownloadsStorage) => void;
/** `MIGRATIONS[n]` upgrades schema n to n + 1. */
const MIGRATIONS: Record<number, Migration> = {};

function parse<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Fills fields an older or newer app version did not write; null for records that cannot be used. */
export function normalizeDownload(raw: unknown): OfflineDownload | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<OfflineDownload>;
  const id = text(value.id);
  const accountKey = text(value.accountKey);
  const workId = text(value.workId);
  const releaseId = text(value.releaseId);
  if (!id || !accountKey || !workId || !releaseId) return null;
  const state = STATES.includes(value.state as OfflineDownloadState)
    ? (value.state as OfflineDownloadState)
    : 'failed';
  const createdAt = count(value.createdAt) ?? 0;
  return {
    id,
    accountKey,
    downloadId: text(value.downloadId),
    serverState: text(value.serverState),
    workId,
    kind: value.kind === 'episode' ? 'episode' : 'movie',
    seriesId: text(value.seriesId),
    seasonId: text(value.seasonId),
    seasonNumber: count(value.seasonNumber),
    episodeNumber: count(value.episodeNumber),
    releaseId,
    sourceReleaseId: text(value.sourceReleaseId),
    version: value.version ?? null,
    engine: value.engine === 'vlc' || value.engine === 'native' ? value.engine : null,
    mediaInfo: value.mediaInfo ?? null,
    fileName: text(value.fileName),
    container: text(value.container),
    relativePath: text(value.relativePath),
    volumeId: text(value.volumeId) ?? 'internal',
    etag: text(value.etag),
    sizeBytes: count(value.sizeBytes),
    estimatedBytes: count(value.estimatedBytes),
    bytesWritten: count(value.bytesWritten) ?? 0,
    state,
    error:
      value.error && typeof value.error.code === 'string'
        ? value.error
        : state === 'failed'
          ? { code: 'unknown', at: createdAt }
          : null,
    retryAt: count(value.retryAt),
    restarts: count(value.restarts) ?? 0,
    expiresAt: text(value.expiresAt),
    serverCompleted: value.serverCompleted === true,
    meta: { title: '', ...value.meta },
    artwork: { ...value.artwork },
    createdAt,
    updatedAt: count(value.updatedAt) ?? createdAt,
    completedAt: count(value.completedAt),
  };
}

export type DownloadStoreOptions = {
  storage: DownloadsStorage;
  now?: () => number;
  newInstallId?: () => string;
};

export type PendingDelete = { accountKey: string; downloadId: string };

/** Live transfer numbers that are never persisted. */
export type LiveTransfer = { bytesPerSecond: number };

/** Downloads, positions and settings of this device (every account), in memory and in MMKV. */
export class DownloadStore {
  private readonly storage: DownloadsStorage;
  private readonly now: () => number;
  private readonly newInstallId: () => string;
  private records = new Map<string, OfflineDownload>();
  private readonly live = new Map<string, LiveTransfer>();
  private readonly dirty = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private version = 0;
  private list: OfflineDownload[] | null = null;

  constructor(options: DownloadStoreOptions) {
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
    this.newInstallId =
      options.newInstallId ??
      (() =>
        `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random()
          .toString(36)
          .slice(2, 12)}`);
    this.load();
  }

  private load(): void {
    const stored = Number(this.storage.getString('schema') ?? 0);
    for (let step = stored; step < DOWNLOADS_SCHEMA; step += 1) MIGRATIONS[step]?.(this.storage);
    if (stored < DOWNLOADS_SCHEMA) this.storage.set('schema', String(DOWNLOADS_SCHEMA));
    const records = new Map<string, OfflineDownload>();
    for (const key of this.storage.getAllKeys()) {
      if (!key.startsWith(RECORD)) continue;
      const record = normalizeDownload(parse(this.storage.getString(key)));
      if (record) records.set(record.id, record);
      else this.storage.remove(key);
    }
    this.records = records;
  }

  /** Re-reads MMKV (tests, another process wrote it). */
  reload(): void {
    this.flush();
    this.load();
    this.changed();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version += 1;
    this.list = null;
    this.listeners.forEach((listener) => listener());
  }

  /** Every download on the device, oldest first (stable reference until the next change). */
  all = (): OfflineDownload[] => {
    this.list ??= [...this.records.values()].sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
    );
    return this.list;
  };

  get(id: string): OfflineDownload | undefined {
    return this.records.get(id);
  }

  forAccount(accountKey: string): OfflineDownload[] {
    return this.all().filter((download) => download.accountKey === accountKey);
  }

  liveOf(id: string): LiveTransfer | undefined {
    return this.live.get(id);
  }

  put(download: OfflineDownload): OfflineDownload {
    this.records.set(download.id, download);
    this.write(download);
    this.changed();
    return download;
  }

  /** Applies `patch`; `persist: false` keeps it in memory until the next timed write (progress). */
  update(
    id: string,
    patch: Partial<OfflineDownload>,
    { persist = true }: { persist?: boolean } = {}
  ): OfflineDownload | undefined {
    const current = this.records.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: this.now() };
    this.records.set(id, next);
    if (persist) this.write(next);
    else this.scheduleWrite(id);
    this.changed();
    return next;
  }

  setLive(id: string, live: LiveTransfer | null): void {
    if (live) this.live.set(id, live);
    else if (!this.live.delete(id)) return;
    this.changed();
  }

  delete(id: string): void {
    const current = this.records.get(id);
    if (!current) return;
    this.records.delete(id);
    this.live.delete(id);
    this.dirty.delete(id);
    this.storage.remove(recordKey(current));
    this.changed();
  }

  private write(download: OfflineDownload): void {
    this.dirty.delete(download.id);
    this.storage.set(recordKey(download), JSON.stringify(download));
  }

  private scheduleWrite(id: string): void {
    this.dirty.add(id);
    this.writeTimer ??= setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, PROGRESS_WRITE_MS);
  }

  /** Writes pending progress now (app background, tests). */
  flush(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    for (const id of [...this.dirty]) {
      const record = this.records.get(id);
      if (record) this.write(record);
    }
    this.dirty.clear();
  }

  positions(accountKey: string): Record<string, LocalPosition> {
    return (
      parse<Record<string, LocalPosition>>(
        this.storage.getString(`${POSITIONS}${accountFolder(accountKey)}`)
      ) ?? {}
    );
  }

  position(accountKey: string, workId: string): LocalPosition | null {
    return this.positions(accountKey)[workId] ?? null;
  }

  setPosition(accountKey: string, workId: string, position: LocalPosition): void {
    const all = { ...this.positions(accountKey), [workId]: position };
    const entries = Object.entries(all);
    const kept =
      entries.length > MAX_POSITIONS
        ? Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_POSITIONS))
        : all;
    this.storage.set(`${POSITIONS}${accountFolder(accountKey)}`, JSON.stringify(kept));
    this.changed();
  }

  deletePositions(accountKey: string): void {
    this.storage.remove(`${POSITIONS}${accountFolder(accountKey)}`);
    this.changed();
  }

  settings(): DownloadSettings {
    return {
      ...DEFAULT_SETTINGS,
      ...parse<Partial<DownloadSettings>>(this.storage.getString('settings')),
    };
  }

  setSettings(patch: Partial<DownloadSettings>): DownloadSettings {
    const next = { ...this.settings(), ...patch };
    this.storage.set('settings', JSON.stringify(next));
    this.changed();
    return next;
  }

  /** Server records to delete once the owner's server answers (removed while offline). */
  pendingDeletes(): PendingDelete[] {
    return parse<PendingDelete[]>(this.storage.getString('pendingDeletes')) ?? [];
  }

  setPendingDeletes(entries: readonly PendingDelete[]): void {
    if (entries.length) this.storage.set('pendingDeletes', JSON.stringify(entries));
    else this.storage.remove('pendingDeletes');
  }

  /** Stable id of this app installation (`deviceId` for the server's per-device list). */
  installId(): string {
    let id = this.storage.getString('installId');
    if (!id) {
      id = this.newInstallId().slice(0, 64);
      this.storage.set('installId', id);
    }
    return id;
  }
}

/** An in-memory `DownloadsStorage` (tests, platforms without downloads). */
export function createMemoryDownloadsStorage(
  seed: Record<string, string> = {}
): DownloadsStorage & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    getString: (key) => entries.get(key),
    set: (key, value) => void entries.set(key, value),
    remove: (key) => entries.delete(key),
    getAllKeys: () => [...entries.keys()],
  };
}
