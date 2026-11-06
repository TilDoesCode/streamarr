import { AppError } from '@/api/errors';

import { STORAGE_RESERVE_BYTES } from '../manager';
import { createTestDownloads, TEST_ACCOUNT_KEY, type TestDownloads } from '../../../jest/downloads';
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

  it('renews an expired capability and resumes; a second 410 right after fails', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.fail(download!.id, { kind: 'http', message: 'gone', httpStatus: 410 });
    await settle();
    expect(test.server.calls).toContain('renew:srv-1');
    expect(stateOf(test)).toBe('downloading');
    test.engine.controls.fail(download!.id, { kind: 'http', message: 'gone', httpStatus: 410 });
    await settle();
    expect(test.store.get(download!.id)!.error?.code).toBe('download_source_gone');
  });

  it('waits on 429 and maps 403 to downloads_not_allowed', async () => {
    const test = attached(createTestDownloads());
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.fail(download!.id, { kind: 'http', message: 'busy', httpStatus: 429 });
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'waiting_server',
      error: { code: 'too_many_downloads' },
    });
    await test.manager.resume(download!.id);
    await settle();
    test.engine.controls.fail(download!.id, { kind: 'http', message: 'no', httpStatus: 403 });
    await settle();
    expect(test.store.get(download!.id)!.error?.code).toBe('downloads_not_allowed');
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
