import type { DeviceProfile } from '@modules/media-caps';
import type { ReactNode } from 'react';

import { AppError } from '@/api/errors';
import { createFakeDownloadEngine, type FakeDownloadEngine } from '@/downloads/engine/fake';

import type { ArtworkFetcher } from '@/downloads/artwork';
import { newDownloadId, workPartsOf } from '@/downloads/keys';
import { DownloadManager } from '@/downloads/manager';
import { DownloadsContextForTests, setDownloadsOverride } from '@/downloads/provider';
import type { DownloadsServerApi, WorkSnapshot } from '@/downloads/server';
import { createMemoryDownloadsStorage, DownloadStore } from '@/downloads/store';
import type { ResumeRules } from '@/lib/resume-rules';
import type {
  DownloadPrepareRequest,
  DownloadResponse,
  OfflineDownload,
  OfflineMetadata,
  ViewerPolicy,
} from '@/downloads/types';

export const TEST_ACCOUNT_KEY = 'http://dev.test#v-anna';
const GB = 1024 ** 3;
const DAY = 24 * 3_600_000;

export const testDeviceProfile: DeviceProfile = {
  platform: 'android',
  engines: [
    {
      engine: 'native',
      containers: ['mp4', 'mkv'],
      videoCodecs: [{ codec: 'h264', maxWidth: 1920, maxHeight: 1080, maxBitDepth: 8 }],
      audioCodecs: [{ codec: 'aac', maxChannels: 2 }],
      subtitleFormats: ['srt'],
      hls: true,
      maxAudioChannels: 2,
    },
  ],
  vlcAvailable: true,
};

type ServerCall =
  'prepare' | 'get' | 'list' | 'renew' | 'complete' | 'remove' | 'snapshot' | 'policy' | 'access';

export type FakeDownloadsServer = DownloadsServerApi & {
  /** Every call as `name:argument`. */
  calls: string[];
  records: Map<string, DownloadResponse>;
  /** Next call of `name` rejects with this error (once). */
  failNext(name: ServerCall, error: unknown): void;
  /** Preparations finish on their own (`ready` on the first poll); false keeps them `resolving`. */
  autoReady: boolean;
  /** Bytes of a prepared file per work id (default 1 GiB). */
  sizes: Record<string, number>;
  /** Ends a preparation: `ready` (with overrides) or `failed` with a code. */
  ready(downloadId: string, patch?: Partial<DownloadResponse>): void;
  failPreparation(downloadId: string, code: string, actions?: string[]): void;
  snapshots: Record<string, WorkSnapshot>;
  /** `/viewer/me` permissions the manager reads after a 403 (default: unrestricted, downloads allowed). */
  viewerPolicy: ViewerPolicy;
  /** Works the viewer's age policy now excludes, with the `age_restricted` params (§ 13) renew answers. */
  restrictedWorks: Record<string, Record<string, string>>;
  /** The age gate's verdict per work (default: rated, no minimum age). */
  ages: Record<string, { minimumAge: number | null; rated: boolean }>;
  /** A security sign-out: `fileUrlRevoked` with no URL until the next renewal hands out a new one. */
  revoke(downloadId: string): void;
};

export function createFakeDownloadsServer(baseUrl = 'http://dev.test'): FakeDownloadsServer {
  const records = new Map<string, DownloadResponse>();
  const byRef = new Map<string, string>();
  const failures = new Map<ServerCall, unknown[]>();
  const calls: string[] = [];
  let next = 0;

  const call = (name: ServerCall, argument: string) => {
    calls.push(`${name}:${argument}`);
    const queued = failures.get(name);
    if (queued?.length) throw queued.shift();
  };
  const need = (downloadId: string) => {
    const record = records.get(downloadId);
    if (!record) throw new AppError('download_not_found', { status: 404 });
    return record;
  };

  const server: FakeDownloadsServer = {
    baseUrl,
    calls,
    records,
    autoReady: true,
    sizes: {},
    snapshots: {},
    viewerPolicy: { maxAge: null, blockUnrated: false, allowDownloads: true, at: 0 },
    restrictedWorks: {},
    ages: {},
    async policy() {
      call('policy', '');
      return server.viewerPolicy;
    },
    revoke(downloadId) {
      records.set(downloadId, { ...need(downloadId), fileUrlRevoked: true, fileUrl: null });
    },
    failNext(name, error) {
      failures.set(name, [...(failures.get(name) ?? []), error]);
    },
    ready(downloadId, patch = {}) {
      const record = need(downloadId);
      const size = server.sizes[record.workId ?? ''] ?? GB;
      records.set(downloadId, {
        ...record,
        state: 'ready',
        releaseId: record.requestedReleaseId,
        fileUrl: `/api/v1/offline/cap-${downloadId}`,
        sizeBytes: size,
        fileName: `${record.workId}.mkv`,
        container: 'mkv',
        eTag: `"etag-${downloadId}"`,
        engine: 'native',
        mediaInfo: {
          container: 'mkv',
          durationTicks: 42 * 60 * 10_000_000,
          audioTracks: [
            { index: 1, codec: 'aac', language: 'de', deliveredAs: 'original', selected: true },
            { index: 2, codec: 'aac', language: 'en', deliveredAs: 'original', selected: false },
          ],
          subtitleTracks: [
            { index: 3, codec: 'srt', language: 'de', deliveredAs: 'embedded', selected: false },
          ],
        } as DownloadResponse['mediaInfo'],
        expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
        pollAfterMs: 0,
        ...patch,
      });
    },
    failPreparation(downloadId, code, actions = ['otherVersion']) {
      const record = need(downloadId);
      records.set(downloadId, {
        ...record,
        state: 'failed',
        error: { code, message: code },
        suggestedActions: actions,
      } as DownloadResponse);
    },
    async prepare(body: DownloadPrepareRequest) {
      call('prepare', body.workId ?? '');
      const deviceId = body.deviceId?.trim() || null;
      const clientRef = body.clientRef?.trim() || null;
      // Like the server: idempotent per device (trimmed, ASCII case-insensitive) and clientRef.
      const key = clientRef
        ? `${deviceId?.replace(/[A-Z]/g, (c) => c.toLowerCase())}|${clientRef}`
        : null;
      const known = key ? byRef.get(key) : undefined;
      if (known && records.has(known)) return records.get(known)!;
      next += 1;
      const downloadId = `srv-${next}`;
      const now = new Date().toISOString();
      const record = {
        downloadId,
        state: 'queued',
        workId: body.workId ?? null,
        requestedReleaseId: body.releaseId ?? null,
        createdAt: now,
        updatedAt: now,
        thisDevice: true,
        deviceId,
        clientRef,
        attempts: [],
        pollAfterMs: 0,
      } as DownloadResponse;
      records.set(downloadId, record);
      if (key) byRef.set(key, downloadId);
      return record;
    },
    async get(downloadId) {
      call('get', downloadId);
      const record = need(downloadId);
      if (
        server.autoReady &&
        record.state !== 'ready' &&
        record.state !== 'failed' &&
        record.state !== 'completed'
      )
        server.ready(downloadId);
      else if (!server.autoReady && record.state === 'queued')
        records.set(downloadId, { ...record, state: 'resolving' });
      return records.get(downloadId)!;
    },
    async list() {
      call('list', '');
      return {
        items: [...records.values()],
        limits: { allowed: true, maxConcurrentDownloads: 2, activeDownloads: 0 },
      };
    },
    async renew(downloadId) {
      call('renew', downloadId);
      const record = need(downloadId);
      // Like the server: renew applies the file URL's checks (docs/api.md § 14).
      if (!server.viewerPolicy.allowDownloads)
        throw new AppError('downloads_not_allowed', { status: 403 });
      const restricted = record.workId ? server.restrictedWorks[record.workId] : undefined;
      if (restricted) throw new AppError('age_restricted', { status: 403, params: restricted });
      const renewed = {
        ...record,
        fileUrl: record.fileUrlRevoked
          ? `/api/v1/offline/cap-${downloadId}-renewed`
          : record.fileUrl,
        fileUrlRevoked: false,
        expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
      };
      records.set(downloadId, renewed);
      return renewed;
    },
    async complete(downloadId, bytes) {
      call('complete', `${downloadId}:${bytes}`);
      const record = need(downloadId);
      const done = { ...record, state: 'completed', fileUrl: null };
      records.set(downloadId, done);
      return done;
    },
    async remove(downloadId) {
      call('remove', downloadId);
      // Like the server: an unknown or already deleted record answers 404.
      if (!records.delete(downloadId)) throw new AppError('download_not_found', { status: 404 });
    },
    async access(workId) {
      call('access', workId);
      const verdict = server.ages[workId] ?? { minimumAge: null, rated: true };
      return { ...verdict, accessVerified: true, accessCheckedAt: Date.now() };
    },
    async snapshot(workId) {
      call('snapshot', workId);
      return (
        server.snapshots[workId] ?? {
          meta: {
            title: `Title ${workId}`,
            seriesTitle: workPartsOf(workId)?.kind === 'episode' ? 'Series' : null,
            overview: 'Overview',
            runtimeMinutes: 42,
          },
          artwork: { poster: `https://image.test/${workId}/poster.jpg`, backdrop: null },
        }
      );
    },
  };
  return server;
}

/** Artwork "downloads" into the fake engine's file map. */
export function createFakeArtworkFetcher(engine?: FakeDownloadEngine): ArtworkFetcher & {
  fetched: string[];
  fail: boolean;
} {
  const fetcher = {
    fetched: [] as string[],
    fail: false,
    async fetch(url: string, relativePath: string, volumeId: string) {
      if (fetcher.fail) return false;
      fetcher.fetched.push(url);
      engine?.controls.writeFile(relativePath, 1024, volumeId);
      return true;
    },
  };
  return fetcher;
}

export type TestDownloads = {
  manager: DownloadManager;
  engine: FakeDownloadEngine;
  server: FakeDownloadsServer;
  store: DownloadStore;
  storage: ReturnType<typeof createMemoryDownloadsStorage>;
  artwork: ReturnType<typeof createFakeArtworkFetcher>;
  /** Owner keys that have no server (signed out). */
  signedOut: Set<string>;
  /** Builds a second manager over the same storage and engine (an app restart). */
  restart(): DownloadManager;
};

/** A manager over the fake engine, an in-memory store and a fake server (unit tests; not attached). */
export function createTestDownloads(
  options: {
    engine?: FakeDownloadEngine;
    server?: FakeDownloadsServer;
    storage?: ReturnType<typeof createMemoryDownloadsStorage>;
    now?: () => number;
    /** Bound of the sign-out flush (default: the app's 5 s). */
    signOutFlushMs?: number;
    /** How long unsaved preparations wait for the launch list (default: the app's 10 s). */
    adoptWaitMs?: number;
    /** Another server (session) per profile; the rest use `server`. */
    servers?: Record<string, FakeDownloadsServer>;
    /** The resume thresholds a profile's server sent (default: none, the server defaults apply). */
    resumeRules?: (accountKey: string) => ResumeRules | null;
  } = {}
): TestDownloads {
  const engine = options.engine ?? createFakeDownloadEngine();
  const server = options.server ?? createFakeDownloadsServer();
  const storage = options.storage ?? createMemoryDownloadsStorage();
  const artwork = createFakeArtworkFetcher(engine);
  const signedOut = new Set<string>();
  const build = () => {
    const store = new DownloadStore({ storage, now: options.now });
    return new DownloadManager({
      engine,
      store,
      serverFor: (key) => (signedOut.has(key) ? null : (options.servers?.[key] ?? server)),
      deviceProfile: async () => testDeviceProfile,
      deviceName: () => 'Test device',
      artwork,
      notificationTitle: (download) => download.meta.title,
      now: options.now,
      prepareWaitMs: 1,
      pollGapMs: 1,
      pendingRetryMs: 1,
      signOutFlushMs: options.signOutFlushMs,
      adoptWaitMs: options.adoptWaitMs,
      resumeRules: options.resumeRules,
    });
  };
  const manager = build();
  return {
    manager,
    engine,
    server,
    store: manager.store,
    storage,
    artwork,
    signedOut,
    restart: build,
  };
}

/** A download record for UI tests (done by default). */
export function fakeOfflineDownload(
  patch: Partial<OfflineDownload> & { workId?: string; meta?: Partial<OfflineMetadata> } = {}
): OfflineDownload {
  const workId = patch.workId ?? 'tmdb-movie-603';
  const parts = workPartsOf(workId) ?? {
    kind: 'movie' as const,
    seriesId: null,
    seasonId: null,
    seasonNumber: null,
    episodeNumber: null,
  };
  const id = patch.id ?? newDownloadId(1_700_000_000_000);
  const done = (patch.state ?? 'done') === 'done';
  return {
    id,
    accountKey: TEST_ACCOUNT_KEY,
    downloadId: `srv-${id}`,
    serverState: null,
    workId,
    ...parts,
    releaseId: 'rel-1',
    sourceReleaseId: 'rel-1',
    version: null,
    engine: 'native',
    mediaInfo: null,
    fileName: `${workId}.mkv`,
    container: 'mkv',
    relativePath: `test/${id}/${workId}.mkv`,
    volumeId: 'internal',
    etag: '"etag"',
    sizeBytes: GB,
    estimatedBytes: GB,
    bytesWritten: done ? GB : 0,
    state: 'done',
    error: null,
    retryAt: null,
    restarts: 0,
    expiresAt: null,
    serverCompleted: done,
    artwork: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    completedAt: done ? 1_700_000_000_000 : null,
    ...patch,
    meta: { title: `Title ${workId}`, ...patch.meta },
  };
}

/** Puts records into a test store (and their files into the fake engine when done). */
export function seedDownloads(
  test: Pick<TestDownloads, 'store' | 'engine'>,
  downloads: OfflineDownload[]
) {
  for (const download of downloads) {
    test.store.put(download);
    if (download.state === 'done' && download.relativePath)
      test.engine.controls.writeFile(
        download.relativePath,
        download.sizeBytes ?? 0,
        download.volumeId
      );
  }
}

/** Provides a test manager to the downloads hooks without the app's providers' side effects. */
export function DownloadsTestProvider({
  test,
  children,
}: {
  test: Pick<TestDownloads, 'manager' | 'engine'>;
  children: ReactNode;
}) {
  return (
    <DownloadsContextForTests value={{ manager: test.manager, engine: test.engine }}>
      {children}
    </DownloadsContextForTests>
  );
}

/** App-level tests: the next app render uses a fake engine, memory store and artwork (call after `resetWorld()`). */
export function installTestDownloads(engine: FakeDownloadEngine = createFakeDownloadEngine()) {
  const storage = createMemoryDownloadsStorage();
  const store = new DownloadStore({ storage });
  const artwork = createFakeArtworkFetcher(engine);
  setDownloadsOverride({ engine, store, artwork });
  return { engine, store, storage, artwork };
}

/** The world's profile anna (`jest/mylist-world`) as a download owner. */
export const WORLD_OWNER = 'http://dev.test#v-anna';

/** A movie and two episodes of anna plus a movie of another profile, installed for the next app render. */
export function installOfflineLibrary() {
  const test = installTestDownloads();
  seedDownloads(test, [
    fakeOfflineDownload({
      id: 'd-movie',
      accountKey: WORLD_OWNER,
      workId: 'tmdb-movie-603',
      meta: { title: 'The Matrix' },
    }),
    fakeOfflineDownload({
      id: 'd-e1',
      accountKey: WORLD_OWNER,
      workId: 'tmdb-tv-1396-s02e01',
      meta: { title: 'Belgravia', seriesTitle: 'Sherlock' },
    }),
    fakeOfflineDownload({
      id: 'd-e2',
      accountKey: WORLD_OWNER,
      workId: 'tmdb-tv-1396-s02e02',
      meta: { title: 'Baskerville', seriesTitle: 'Sherlock' },
    }),
    fakeOfflineDownload({
      id: 'd-other',
      accountKey: 'http://dev.test#v-ben',
      workId: 'tmdb-movie-999',
      meta: { title: 'Ben Only' },
    }),
  ]);
  return test;
}
