import { AppError } from '@/api/errors';

import { noteServerDate, resetServerClock } from '@/lib/server-clock';

import { STORAGE_RESERVE_BYTES } from '../manager';
import { createMemoryDownloadsStorage } from '../store';
import {
  createTestDownloads,
  fakeOfflineDownload,
  TEST_ACCOUNT_KEY,
  type TestDownloads,
} from '../../../jest/downloads';
import { resolveLocalPlayTarget } from '../local-play';
import type { OfflineDownloadState } from '../types';

const GB = 1024 ** 3;
const MOVIE = 'tmdb-movie-603';
const EPISODE = 'tmdb-tv-1396-s02e02';

async function settle(rounds = 8) {
  for (let round = 0; round < rounds; round += 1) await new Promise((r) => setTimeout(r, 0));
}

function stateOf(test: TestDownloads, workId = MOVIE): OfflineDownloadState | undefined {
  return test.store.all().find((download) => download.workId === workId)?.state;
}

let detach: (() => void) | null = null;
function attached(test: TestDownloads) {
  detach = test.manager.attach();
  return test;
}

afterEach(() => {
  detach?.();
  detach = null;
});

const SD = 'volume-6f1c2e7a-0b3d-4e52-9a1f-2c8d4b7e9a10';
const SD_VOLUME = {
  id: SD,
  uri: 'file:///sd/',
  removable: true,
  freeBytes: 50 * GB,
  totalBytes: 64 * GB,
};

/** An SD card that is not mounted yet, on the current fake and on DL-N's fix-round fake (`mountVolume`). */
function sdCard(test: TestDownloads) {
  const controls = test.engine.controls as TestDownloads['engine']['controls'] & {
    mountVolume?: (volume: typeof SD_VOLUME) => void;
  };
  let mounted = false;
  if (!controls.mountVolume) {
    const volumes = test.engine.volumes;
    test.engine.volumes = async () => [...(await volumes()), ...(mounted ? [SD_VOLUME] : [])];
  }
  return {
    mount() {
      mounted = true;
      controls.mountVolume?.(SD_VOLUME);
    },
  };
}

describe('download manager', () => {
  it('prepares, transfers, verifies and completes a download', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'rel-1', candidate: { sizeBytes: GB, version: null as never } },
    ]);
    expect(download!.state).toBe('queued');
    await settle();
    expect(stateOf(test)).toBe('downloading');
    const record = test.store.get(download!.id)!;
    expect(record).toMatchObject({
      downloadId: 'srv-1',
      engine: 'native',
      sizeBytes: GB,
      etag: '"etag-srv-1"',
      fileName: `${MOVIE}.mkv`,
    });
    expect(record.relativePath).toMatch(new RegExp(`/${download!.id}/${MOVIE}\\.mkv$`));
    expect(test.engine.controls.tasks()[0]).toMatchObject({
      url: 'http://dev.test/api/v1/offline/cap-srv-1',
      relativePath: record.relativePath,
    });

    test.engine.controls.progress(download!.id, GB / 2, { bytesPerSecond: 1000 });
    expect(test.store.get(download!.id)!.bytesWritten).toBe(GB / 2);
    expect(test.store.liveOf(download!.id)?.bytesPerSecond).toBe(1000);

    test.engine.controls.complete(download!.id);
    await settle();
    expect(stateOf(test)).toBe('done');
    expect(test.store.get(download!.id)).toMatchObject({ serverCompleted: true, bytesWritten: GB });
    expect(test.server.calls).toContain(`complete:srv-1:${GB}`);
    expect(test.engine.controls.tasks()).toEqual([]);
    expect(test.store.get(download!.id)!.meta.title).toBe(`Title ${MOVIE}`);
    expect(test.store.get(download!.id)!.artwork.poster).toMatch(/art\/poster\.jpg$/);
  });

  it('sends the device profile, install id and its own id as clientRef', async () => {
    const test = attached(createTestDownloads());
    const prepare = jest.spyOn(test.server, 'prepare');
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: EPISODE, releaseId: 'rel-2' },
    ]);
    await settle();
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        workId: EPISODE,
        releaseId: 'rel-2',
        clientRef: download!.id,
        deviceId: test.store.installId(),
        deviceName: 'Test device',
        engine: 'auto',
        device: expect.objectContaining({ platform: 'android' }),
      })
    );
    expect(test.store.get(download!.id)).toMatchObject({
      kind: 'episode',
      seriesId: 'tmdb-tv-1396',
      seasonId: 'tmdb-tv-1396-s02',
      seasonNumber: 2,
      episodeNumber: 2,
    });
  });

  it('returns the existing download of a work instead of a second one', async () => {
    const test = attached(createTestDownloads());
    const [first] = await test.manager.start(TEST_ACCOUNT_KEY, [{ workId: MOVIE, releaseId: 'a' }]);
    const [again] = await test.manager.start(TEST_ACCOUNT_KEY, [{ workId: MOVIE, releaseId: 'b' }]);
    expect(again!.id).toBe(first!.id);
    expect(test.store.all()).toHaveLength(1);
  });

  it('maps a failed preparation to failed with the server code and actions', async () => {
    const test = attached(createTestDownloads());
    test.server.autoReady = false;
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    expect(stateOf(test)).toBe('preparing');
    expect(test.store.get(download!.id)!.serverState).toBe('resolving');
    test.server.failPreparation('srv-1', 'not_direct_playable');
    await settle(20);
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'failed',
      error: { code: 'not_direct_playable', actions: ['otherVersion'] },
    });
  });

  it('waits for the server on transport failures and retries on wake', async () => {
    const test = attached(createTestDownloads());
    test.server.failNext('prepare', new AppError('network_unreachable'));
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'waiting_server',
      error: { code: 'network_unreachable' },
    });
    test.store.update(download!.id, { retryAt: 0 });
    test.manager.wake();
    await settle();
    expect(stateOf(test)).toBe('downloading');
  });

  it('fails clearly when downloads are not allowed or the server is too old', async () => {
    const test = attached(createTestDownloads());
    // Off on the server (else the blocked download would be prepared again by itself).
    test.server.viewerPolicy = { ...test.server.viewerPolicy, allowDownloads: false };
    test.server.failNext('prepare', new AppError('downloads_not_allowed', { status: 403 }));
    test.server.failNext('prepare', new AppError('server_error', { status: 501 }));
    await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
      { workId: EPISODE, releaseId: 'r' },
    ]);
    await settle();
    expect(test.store.all().map((d) => [d.state, d.error?.code])).toEqual([
      ['failed', 'downloads_not_allowed'],
      ['failed', 'server_unsupported'],
    ]);
  });

  it('parks a download that does not fit and continues once space frees', async () => {
    const test = attached(createTestDownloads());
    test.engine.controls.setStorage({ freeBytes: GB / 2 });
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'waiting_space',
      error: { code: 'disk_full' },
    });
    test.engine.controls.setStorage({ freeBytes: 2 * GB + STORAGE_RESERVE_BYTES });
    test.manager.wake();
    await settle();
    expect(stateOf(test)).toBe('downloading');
  });

  it('turns an engine disk_full into waiting_space', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.fail(download!.id, 'disk_full');
    await settle();
    expect(stateOf(test)).toBe('waiting_space');
  });

  it('follows the engine: Wi-Fi only, no network, retrying and pause', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.setNetwork('metered');
    expect(stateOf(test)).toBe('waiting_wifi');
    test.engine.controls.setNetwork('none');
    expect(stateOf(test)).toBe('waiting_network');
    test.engine.controls.setNetwork('wifi');
    expect(stateOf(test)).toBe('downloading');
    test.engine.controls.setState(download!.id, 'retrying', { retryAt: 123 });
    await settle(1);
    expect(test.store.get(download!.id)).toMatchObject({ state: 'waiting_server', retryAt: 123 });
    test.engine.controls.setState(download!.id, 'running');
    await test.manager.pause(download!.id);
    expect(stateOf(test)).toBe('paused');
    await test.manager.resume(download!.id);
    await settle();
    expect(stateOf(test)).toBe('downloading');
  });

  it('C1-12: an expired link renews and resumes on its bytes; a 410 on a valid link asks for another version', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.progress(download!.id, GB / 4);
    const record = test.server.records.get('srv-1')!;
    test.server.records.set('srv-1', {
      ...record,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    test.engine.controls.httpStatus(download!.id, 410);
    await settle();
    expect(test.server.calls).toContain('get:srv-1');
    expect(test.server.calls).toContain('renew:srv-1');
    expect(stateOf(test)).toBe('downloading');
    expect(test.store.get(download!.id)!.bytesWritten).toBe(GB / 4);

    test.engine.controls.httpStatus(download!.id, 410);
    await settle();
    expect(test.server.calls.filter((call) => call.startsWith('renew'))).toHaveLength(1);
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'failed',
      error: { code: 'download_source_gone', actions: ['otherVersion'] },
    });
  });

  it('C1-12: a revoked link waits for the next sign-in, then renews to a new URL and resumes on its bytes', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.progress(download!.id, GB / 2);
    test.server.revoke('srv-1');
    test.server.failNext('renew', new AppError('unauthorized', { status: 401 }));
    test.engine.controls.httpStatus(download!.id, 410);
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'waiting_server',
      error: { code: 'signed_out', status: 401 },
      bytesWritten: GB / 2,
    });
    expect(test.server.records.has('srv-1')).toBe(true);

    // Signed in again: it continues at once, not at its backoff time.
    test.manager.resumeSignedOut([TEST_ACCOUNT_KEY]);
    await settle();
    expect(stateOf(test)).toBe('downloading');
    expect(test.engine.controls.tasks()[0]!.url).toBe(
      'http://dev.test/api/v1/offline/cap-srv-1-renewed'
    );
    expect(test.store.get(download!.id)!.bytesWritten).toBe(GB / 2);
  });

  it('C1-12: a 404 for an older URL resumes on the current one', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    const record = test.server.records.get('srv-1')!;
    test.server.records.set('srv-1', { ...record, fileUrl: '/api/v1/offline/cap-current' });
    test.engine.controls.httpStatus(download!.id, 404);
    await settle();
    expect(stateOf(test)).toBe('downloading');
    expect(test.engine.controls.tasks()[0]!.url).toBe('http://dev.test/api/v1/offline/cap-current');
  });

  it('C1-12: downloads turned off or the age rules end the transfer with the server reason, keep the partial and offer Remove', async () => {
    for (const allowDownloads of [false, true]) {
      const test = attached(createTestDownloads());
      test.server.viewerPolicy = { maxAge: 12, blockUnrated: true, allowDownloads, at: 1 };
      if (allowDownloads) test.server.restrictedWorks[MOVIE] = { minimumAge: '16', maxAge: '12' };
      const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
        { workId: MOVIE, releaseId: 'r' },
      ]);
      await settle();
      test.engine.controls.progress(download!.id, GB / 3);
      test.engine.controls.httpStatus(download!.id, 403);
      await settle();
      const code = allowDownloads ? 'age_restricted' : 'downloads_not_allowed';
      expect(test.store.get(download!.id)).toMatchObject({
        state: 'failed',
        error: { code, status: 403, actions: ['remove'] },
      });
      if (allowDownloads)
        expect(test.store.get(download!.id)!.error!.params).toEqual({
          minimumAge: '16',
          maxAge: '12',
        });
      expect(test.store.policy(TEST_ACCOUNT_KEY)).toMatchObject({ maxAge: 12, allowDownloads });
      expect(test.engine.controls.files()).toHaveProperty([
        `internal:${test.store.get(download!.id)!.relativePath}.part`,
      ]);
    }
  });

  it('a 403 after the account was disabled waits for the next sign-in instead of failing', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.progress(download!.id, GB / 4);
    test.server.failNext('renew', new AppError('unauthorized', { status: 401 }));
    test.engine.controls.httpStatus(download!.id, 403);
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'waiting_server',
      error: { code: 'signed_out' },
      bytesWritten: GB / 4,
    });
  });

  it('a 403 whose access is back (renew answers) continues on the renewed link', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.httpStatus(download!.id, 403);
    await settle();
    expect(test.server.calls).toContain('renew:srv-1');
    expect(stateOf(test)).toBe('downloading');
  });

  it('a 403 never touches a finished file: it stays playable', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.complete(download!.id);
    await settle();
    expect(stateOf(test)).toBe('done');
    // The completion did not reach the server yet; downloads were turned off meanwhile.
    test.store.update(download!.id, { serverCompleted: false });
    test.server.viewerPolicy = { ...test.server.viewerPolicy, allowDownloads: false };
    test.server.failNext('complete', new AppError('downloads_not_allowed', { status: 403 }));
    const completions = () => test.server.calls.filter((call) => call.startsWith('complete:'));
    const before = completions().length;
    test.manager.wake();
    await settle();
    test.manager.wake();
    await settle();
    expect(completions()).toHaveLength(before + 1);
    expect(test.store.get(download!.id)).toMatchObject({ state: 'done', error: null });
    expect(await test.engine.exists(test.store.get(download!.id)!.relativePath!)).toBe(true);
  });

  it('a device clock behind the server still renews an expired link (download_expired) instead of failing', async () => {
    resetServerClock(createMemoryDownloadsStorage());
    const now = Date.now();
    noteServerDate(new Date(now + 3_600_000).toUTCString(), now);
    try {
      const test = attached(createTestDownloads());
      const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
        { workId: MOVIE, releaseId: 'r' },
      ]);
      await settle();
      // Expired 30 minutes ago on the server's clock, valid for 30 more on this device's.
      const record = test.server.records.get('srv-1')!;
      test.server.records.set('srv-1', {
        ...record,
        expiresAt: new Date(now + 30 * 60_000).toISOString(),
      });
      test.engine.controls.httpStatus(download!.id, 410);
      await settle();
      expect(test.server.calls).toContain('renew:srv-1');
      expect(stateOf(test)).toBe('downloading');
    } finally {
      resetServerClock(createMemoryDownloadsStorage());
    }
  });

  it('renews the file link of an unfinished download before it expires', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.manager.wake();
    await settle();
    expect(test.server.calls).not.toContain('renew:srv-1');
    const soon = new Date(Date.now() + 24 * 3_600_000).toISOString();
    test.store.update(download!.id, { expiresAt: soon });
    test.manager.wake();
    await settle();
    expect(test.server.calls).toContain('renew:srv-1');
    expect(Date.parse(test.store.get(download!.id)!.expiresAt!)).toBeGreaterThan(Date.parse(soon));
  });

  it('shows the retry time of a 429 (Retry-After) while the engine waits, then continues', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    const before = Date.now();
    test.engine.controls.httpStatus(download!.id, 429, { retryAfterMs: 30_000 });
    await settle();
    const record = test.store.get(download!.id)!;
    expect(record).toMatchObject({
      state: 'waiting_server',
      error: { code: 'too_many_downloads', status: 429 },
    });
    expect(record.retryAt).toBeGreaterThanOrEqual(before + 30_000);
    test.engine.controls.progress(download!.id, 10);
    expect(stateOf(test)).toBe('downloading');
  });

  describe('DL-S fix round 2: security sign-out while preparing, 401 at answer time', () => {
    it('a download made ready while its link was revoked renews (with this device) and then starts', async () => {
      const test = attached(createTestDownloads());
      test.server.autoReady = false;
      const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
        { workId: MOVIE, releaseId: 'r' },
      ]);
      await settle();
      expect(stateOf(test)).toBe('preparing');
      const renew = jest.spyOn(test.server, 'renew');
      test.server.ready('srv-1', { fileUrlRevoked: true, fileUrl: null });
      await settle(20);
      expect(renew).toHaveBeenCalledWith('srv-1', test.store.installId());
      // No task and no bytes yet: a start with the server's size and validator, never a resume.
      expect(test.engine.controls.calls).toContain(`start:${download!.id}`);
      expect(test.engine.controls.calls).not.toContain(`resume:${download!.id}`);
      expect(test.engine.controls.tasks()).toMatchObject([
        {
          id: download!.id,
          url: 'http://dev.test/api/v1/offline/cap-srv-1-renewed',
          bytesWritten: 0,
          totalBytes: GB,
          etag: '"etag-srv-1"',
        },
      ]);
      expect(stateOf(test)).toBe('downloading');
    });

    it('signed out at that moment: it waits, keeps the record, renews and starts after the next sign-in', async () => {
      const test = attached(createTestDownloads());
      test.server.autoReady = false;
      const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
        { workId: MOVIE, releaseId: 'r' },
      ]);
      await settle();
      test.server.failNext('renew', new AppError('unauthorized', { status: 401 }));
      test.server.ready('srv-1', { fileUrlRevoked: true, fileUrl: null });
      await settle(20);
      expect(test.store.get(download!.id)).toMatchObject({
        state: 'waiting_server',
        error: { code: 'signed_out', status: 401 },
        downloadId: 'srv-1',
      });
      expect(test.engine.controls.tasks()).toEqual([]);

      test.manager.resumeSignedOut([TEST_ACCOUNT_KEY]);
      await settle(20);
      expect(test.engine.controls.tasks()[0]!.url).toBe(
        'http://dev.test/api/v1/offline/cap-srv-1-renewed'
      );
      expect(stateOf(test)).toBe('downloading');
    });

    it('a 401 answering the preparation poll waits for the sign-in instead of failing', async () => {
      const test = attached(createTestDownloads());
      test.server.autoReady = false;
      const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
        { workId: MOVIE, releaseId: 'r' },
      ]);
      await settle();
      test.server.failNext('get', new AppError('unauthorized', { status: 401 }));
      await settle(20);
      expect(test.store.get(download!.id)).toMatchObject({
        state: 'waiting_server',
        error: { code: 'signed_out' },
        downloadId: 'srv-1',
      });

      // An ordinary logout revokes nothing: after the sign-in the poll gets the ready URL itself.
      const renew = jest.spyOn(test.server, 'renew');
      test.server.ready('srv-1');
      test.manager.resumeSignedOut([TEST_ACCOUNT_KEY]);
      await settle(20);
      expect(renew).not.toHaveBeenCalled();
      expect(test.engine.controls.tasks()[0]!.url).toBe('http://dev.test/api/v1/offline/cap-srv-1');
      expect(stateOf(test)).toBe('downloading');
    });

    it('a 401 answering the prepare POST waits, then prepares again with the same device and clientRef', async () => {
      const test = attached(createTestDownloads());
      test.server.failNext('prepare', new AppError('unauthorized', { status: 401 }));
      const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
        { workId: MOVIE, releaseId: 'r' },
      ]);
      await settle();
      expect(test.store.get(download!.id)).toMatchObject({
        state: 'waiting_server',
        error: { code: 'signed_out', status: 401 },
        downloadId: null,
      });
      const prepare = jest.spyOn(test.server, 'prepare');
      test.manager.resumeSignedOut([TEST_ACCOUNT_KEY]);
      await settle(20);
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({ clientRef: download!.id, deviceId: test.store.installId() })
      );
      expect(test.store.get(download!.id)).toMatchObject({ downloadId: 'srv-1' });
      expect(test.server.records.size).toBe(1);
      expect(stateOf(test)).toBe('downloading');
    });

    it('a 401 answering the device list deletes nothing on either side', async () => {
      const test = createTestDownloads();
      await test.server.prepare({ workId: 'tmdb-movie-1', releaseId: 'r', clientRef: 'ghost' });
      test.store.put(fakeOfflineDownload({ id: 'kept', workId: MOVIE, downloadId: 'srv-kept' }));
      test.engine.controls.writeFile(test.store.get('kept')!.relativePath!, GB);
      test.manager.setKnownOwners([TEST_ACCOUNT_KEY]);
      test.server.failNext('list', new AppError('unauthorized', { status: 401 }));
      attached(test);
      await settle();
      expect(test.server.calls.filter((call) => call.startsWith('remove:'))).toEqual([]);
      expect(test.server.records.size).toBe(1);
      expect(test.store.get('kept')).toMatchObject({ state: 'done', error: null });

      // Signed in again: the orphan of this device is cleaned up then.
      await test.manager.reconcileServers();
      expect(test.server.calls).toContain('remove:srv-1');
    });

    it('renews racing for one revoked download end in one task on the one new URL', async () => {
      const test = attached(createTestDownloads());
      test.server.autoReady = false;
      const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
        { workId: MOVIE, releaseId: 'r' },
      ]);
      await settle();
      test.server.failNext('renew', new AppError('unauthorized', { status: 401 }));
      test.server.ready('srv-1', { fileUrlRevoked: true, fileUrl: null });
      await settle(20);
      const renew = jest.spyOn(test.server, 'renew');
      test.manager.resumeSignedOut([TEST_ACCOUNT_KEY]);
      test.manager.resumeSignedOut([TEST_ACCOUNT_KEY]);
      test.manager.wake();
      await settle(30);
      expect(renew).toHaveBeenCalled();
      expect(test.engine.controls.tasks()).toMatchObject([
        { id: download!.id, url: 'http://dev.test/api/v1/offline/cap-srv-1-renewed' },
      ]);
      expect(test.store.get(download!.id)).toMatchObject({ state: 'downloading', error: null });
    });
  });

  describe('engine fix round (DL-N): deadlines, late events, volumes', () => {
    const start = async (test: TestDownloads) => {
      const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
        { workId: MOVIE, releaseId: 'r' },
      ]);
      await settle();
      return download!.id;
    };

    it('a 429 the engine gave up on after its deadline waits for Retry-After and resumes, never failed', async () => {
      const test = attached(createTestDownloads());
      const id = await start(test);
      test.engine.controls.progress(id, GB / 4);
      const before = Date.now();
      test.engine.controls.fail(id, {
        kind: 'http',
        message: 'retry deadline',
        httpStatus: 429,
        retryAfterMs: 600_000,
      });
      await settle();
      const waiting = test.store.get(id)!;
      expect(waiting).toMatchObject({
        state: 'waiting_server',
        error: { code: 'too_many_downloads', status: 429 },
        bytesWritten: GB / 4,
      });
      expect(waiting.retryAt! - before).toBeGreaterThanOrEqual(600_000);

      test.store.update(id, { retryAt: Date.now() - 1 });
      test.manager.wake();
      await settle();
      expect(stateOf(test)).toBe('downloading');
    });

    it('408/425/5xx after the deadline wait too; Retry-After below 2 s waits 2 s', async () => {
      for (const status of [408, 425, 502]) {
        const test = attached(createTestDownloads());
        const id = await start(test);
        const before = Date.now();
        test.engine.controls.fail(id, {
          kind: 'http',
          message: 'retry deadline',
          httpStatus: status,
          retryAfterMs: 500,
        });
        await settle();
        const waiting = test.store.get(id)!;
        expect(waiting).toMatchObject({ state: 'waiting_server', error: { status } });
        expect(waiting.retryAt! - before).toBeGreaterThanOrEqual(2_000);
        detach?.();
        detach = null;
      }
    });

    it('the final progress right behind completed never turns the record back into a transfer', async () => {
      const test = attached(createTestDownloads());
      const id = await start(test);
      test.engine.controls.progress(id, GB / 2);
      test.engine.controls.complete(id);
      // Native order: state `completed`, then one last progress (and here even a stray `running`).
      test.engine.controls.progress(id, GB);
      expect(stateOf(test)).toBe('verifying');
      await settle();
      expect(test.store.get(id)).toMatchObject({ state: 'done', bytesWritten: GB });
    });

    it('1: the viewer cancelling in the notification removes the download like Remove does', async () => {
      const test = attached(createTestDownloads());
      const id = await start(test);
      test.engine.controls.progress(id, GB / 3);
      const folder = test.store.get(id)!.relativePath!.replace(/\/[^/]+$/, '');
      test.engine.controls.writeFile(`${folder}/art/poster.jpg`, 10);
      // The engine's own cancel (Android notification action), not one the manager asked for.
      await test.engine.cancel(id);
      await settle();
      expect(test.store.get(id)).toBeUndefined();
      expect(test.server.calls).toContain('remove:srv-1');
      expect(test.engine.controls.files()).toEqual({});
    });

    it("1: the manager's own cancel (a restart after the file changed) keeps the download", async () => {
      const test = attached(createTestDownloads());
      const id = await start(test);
      test.engine.controls.fail(id, 'validator_changed');
      await settle();
      expect(test.engine.controls.calls).toContain(`cancel:${id}`);
      expect(test.store.get(id)).toMatchObject({ restarts: 1 });
      expect(stateOf(test)).toBe('downloading');
    });

    it('1: a pause from the notification stays paused, also across a relaunch', async () => {
      const test = attached(createTestDownloads());
      const id = await start(test);
      test.engine.controls.progress(id, GB / 2);
      await test.engine.pause(id);
      await settle();
      expect(test.store.get(id)).toMatchObject({ state: 'paused', bytesWritten: GB / 2 });

      detach?.();
      detach = null;
      const relaunched = test.restart();
      detach = relaunched.attach();
      await settle();
      relaunched.wake();
      await settle();
      expect(relaunched.store.get(id)!.state).toBe('paused');
      expect(test.engine.controls.calls.filter((call) => call === `resume:${id}`)).toEqual([]);

      await relaunched.resume(id);
      await settle();
      expect(relaunched.store.get(id)!.state).toBe('downloading');
    });

    it('1: unfinished tasks a system stop left paused are not restarted at launch', async () => {
      const test = attached(createTestDownloads());
      const id = await start(test);
      test.engine.controls.progress(id, GB / 4);
      detach?.();
      detach = null;
      // Android Task Manager "Stop": the engine reports the transfer paused; the app last saw it downloading.
      test.engine.controls.setState(id, 'paused');
      expect(test.store.get(id)!.state).toBe('downloading');
      const relaunched = test.restart();
      detach = relaunched.attach();
      await settle();
      expect(relaunched.store.get(id)!.state).toBe('paused');
      expect(test.engine.controls.calls.filter((call) => call === `resume:${id}`)).toEqual([]);
    });

    it('1: a download cancelled in the notification while the app was not running is gone at launch', async () => {
      const test = attached(createTestDownloads());
      const id = await start(test);
      detach?.();
      detach = null;
      test.engine.controls.setState(id, 'cancelled');
      const relaunched = test.restart();
      detach = relaunched.attach();
      await settle();
      expect(relaunched.store.get(id)).toBeUndefined();
      expect(test.server.calls).toContain('remove:srv-1');
    });

    it('1: a late paused event never turns a failed download back into a paused one', async () => {
      const test = attached(createTestDownloads());
      test.server.viewerPolicy = { ...test.server.viewerPolicy, allowDownloads: false };
      const id = await start(test);
      test.engine.controls.httpStatus(id, 403);
      await settle();
      expect(stateOf(test)).toBe('failed');
      test.engine.controls.setState(id, 'paused');
      await settle();
      expect(test.store.get(id)).toMatchObject({
        state: 'failed',
        error: { code: 'downloads_not_allowed' },
      });
    });

    it('5: a retrying 429 shows its retry time; a network change keeps it; Retry-After is capped at 1 h', async () => {
      const test = attached(createTestDownloads());
      const id = await start(test);
      test.engine.controls.httpStatus(id, 429, { retryAfterMs: 90_000 });
      await settle();
      const retrying = test.store.get(id)!;
      expect(retrying).toMatchObject({
        state: 'waiting_server',
        error: { code: 'too_many_downloads', status: 429 },
      });
      expect(retrying.retryAt).toBeGreaterThan(Date.now() + 80_000);
      // Wi-Fi drops meanwhile: the engine waits for it, the next attempt stays where it was.
      test.engine.controls.setState(id, 'waiting_wifi');
      await settle();
      expect(test.store.get(id)).toMatchObject({
        state: 'waiting_wifi',
        retryAt: retrying.retryAt,
      });

      const before = Date.now();
      test.engine.controls.fail(id, {
        kind: 'http',
        message: 'retry deadline',
        httpStatus: 503,
        retryAfterMs: 10 * 3_600_000,
      });
      await settle();
      const capped = test.store.get(id)!;
      expect(capped.state).toBe('waiting_server');
      expect(capped.retryAt! - before).toBeLessThanOrEqual(3_600_000 + 1_000);
    });

    it('7: the engine continuing by itself when the volume returns needs no retry here', async () => {
      const test = attached(createTestDownloads());
      const id = await start(test);
      test.engine.controls.progress(id, GB / 5);
      test.engine.controls.fail(id, { kind: 'file_system', message: 'volume_unavailable' });
      await settle();
      expect(test.store.get(id)).toMatchObject({
        state: 'waiting_volume',
        error: { code: 'volume_unavailable' },
        bytesWritten: GB / 5,
      });
      expect(test.store.get(id)!.error?.actions).toBeUndefined();
      const resumes = () => test.engine.controls.calls.filter((call) => call === `resume:${id}`);
      const before = resumes().length;
      // Mounted again: the engine queues and runs the task on its own.
      test.engine.controls.setState(id, 'queued', { error: undefined });
      test.engine.controls.progress(id, GB / 4);
      await settle();
      test.manager.wake();
      await settle();
      expect(test.store.get(id)).toMatchObject({ state: 'downloading', error: null });
      expect(resumes()).toHaveLength(before);
    });

    it('7: an unmounted volume keeps the download waiting and continues when it returns', async () => {
      const test = attached(createTestDownloads());
      const card = sdCard(test);
      const id = await start(test);
      test.store.update(id, { volumeId: SD });
      test.engine.controls.progress(id, GB / 3);
      test.engine.controls.fail(id, { kind: 'file_system', message: 'volume_unavailable' });
      await settle();
      expect(test.store.get(id)).toMatchObject({
        state: 'waiting_volume',
        error: { code: 'volume_unavailable' },
        bytesWritten: GB / 3,
      });
      test.manager.wake();
      await settle();
      expect(stateOf(test)).toBe('waiting_volume');

      card.mount();
      test.manager.wake();
      await settle();
      expect(stateOf(test)).toBe('downloading');
    });

    it('7: a finished download on an unmounted volume stays, unplayable, and plays again when it returns', async () => {
      const test = createTestDownloads();
      const card = sdCard(test);
      const done = fakeOfflineDownload({ id: 'sd', workId: MOVIE, volumeId: SD });
      test.store.put(done);
      attached(test);
      await settle();
      expect(test.store.get('sd')).toMatchObject({
        state: 'done',
        error: { code: 'volume_unavailable' },
      });
      expect(resolveLocalPlayTarget(MOVIE, TEST_ACCOUNT_KEY, test.manager, test.engine)).toBeNull();

      card.mount();
      test.engine.controls.writeFile(done.relativePath!, done.sizeBytes!, SD);
      test.manager.wake();
      await settle();
      expect(test.store.get('sd')).toMatchObject({ state: 'done', error: null });
      expect(
        resolveLocalPlayTarget(MOVIE, TEST_ACCOUNT_KEY, test.manager, test.engine)
      ).not.toBeNull();
    });
  });

  it('starts the same file over once after a 416, then fails', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.httpStatus(download!.id, 416);
    await settle();
    expect(stateOf(test)).toBe('downloading');
    test.engine.controls.httpStatus(download!.id, 416);
    await settle();
    expect(test.store.get(download!.id)!.error?.code).toBe('range_not_satisfiable');
  });

  it('restarts once when the file changed, then fails', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.fail(download!.id, 'validator_changed');
    await settle(16);
    expect(test.store.get(download!.id)).toMatchObject({ state: 'downloading', restarts: 1 });
    expect(test.server.calls).toContain('remove:srv-1');
    test.engine.controls.fail(download!.id, 'validator_changed');
    await settle(16);
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'failed',
      error: { code: 'validator_changed' },
    });
  });

  it('removal deletes the file, the artwork and the server record', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.complete(download!.id);
    await settle();
    expect(Object.keys(test.engine.controls.files()).length).toBeGreaterThan(1);
    await test.manager.remove(download!.id);
    expect(test.store.all()).toEqual([]);
    expect(test.engine.controls.files()).toEqual({});
    expect(test.server.calls).toContain('remove:srv-1');
  });

  it('queues the server deletion of a download removed while signed out', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.signedOut.add(TEST_ACCOUNT_KEY);
    await test.manager.remove(download!.id);
    expect(test.store.pendingDeletes()).toEqual([
      { accountKey: TEST_ACCOUNT_KEY, downloadId: 'srv-1' },
    ]);
    test.signedOut.clear();
    await test.manager.reconcile();
    expect(test.store.pendingDeletes()).toEqual([]);
    expect(test.server.calls.filter((call) => call === 'remove:srv-1')).toHaveLength(1);
  });
});
