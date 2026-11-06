import { AppError } from '@/api/errors';

import {
  createTestDownloads,
  fakeOfflineDownload,
  seedDownloads,
  TEST_ACCOUNT_KEY,
} from '../../../jest/downloads';
import { checkLocalPlayTarget, resolveLocalPlayTarget } from '../local-play';
import { abortableDelay } from '../manager';

const GB = 1024 ** 3;
const MOVIE = 'tmdb-movie-603';
const settle = async () => {
  for (let round = 0; round < 12; round += 1) await new Promise((r) => setTimeout(r, 0));
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const disposals: (() => void)[] = [];
function setup() {
  const test = createTestDownloads();
  disposals.push(test.manager.attach());
  return test;
}
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose());
  jest.restoreAllMocks();
});

describe('download manager races and contract (DL-C-verify1)', () => {
  it('C1-01: a pause during the pending prepare survives its ready answer; Resume starts it', async () => {
    const test = setup();
    const pending = deferred<Awaited<ReturnType<typeof test.server.prepare>>>();
    const real = test.server.prepare.bind(test.server);
    jest.spyOn(test.server, 'prepare').mockImplementationOnce(async (body) => {
      const ready = await real(body);
      await pending.promise;
      return ready;
    });
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    await test.manager.pause(download!.id);
    pending.resolve(undefined as never);
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({ state: 'paused', downloadId: 'srv-1' });
    expect(test.engine.controls.tasks()).toEqual([]);

    await test.manager.resume(download!.id);
    await settle();
    expect(test.store.get(download!.id)!.state).toBe('downloading');
    expect(test.server.calls.filter((call) => call.startsWith('prepare'))).toHaveLength(1);
  });

  it('C1-02: a removal while the transfer is being enqueued leaves no engine task and no files', async () => {
    const test = setup();
    const pending = deferred<{ freeBytes: number; totalBytes: number }>();
    jest.spyOn(test.engine, 'storage').mockImplementationOnce(() => pending.promise);
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    expect(test.store.get(download!.id)!.relativePath).not.toBeNull();
    await test.manager.remove(download!.id);
    pending.resolve({ freeBytes: 20 * GB, totalBytes: 30 * GB });
    await settle();
    expect(test.store.get(download!.id)).toBeUndefined();
    expect(test.engine.controls.tasks()).toEqual([]);
    expect(test.engine.controls.files()).toEqual({});
  });

  it('C1-02: artwork arriving after a removal is deleted too', async () => {
    const test = setup();
    const pending = deferred<boolean>();
    jest.spyOn(test.artwork, 'fetch').mockImplementationOnce(async (_url, path, volumeId) => {
      await pending.promise;
      test.engine.controls.writeFile(path, 10, volumeId);
      return true;
    });
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    await test.manager.remove(download!.id);
    pending.resolve(true);
    await settle();
    expect(test.engine.controls.files()).toEqual({});
  });

  it('C1-03: two starts replacing a failed record share one record and one clientRef', async () => {
    const test = setup();
    test.store.put(fakeOfflineDownload({ id: 'failed', state: 'failed' }));
    const item = { workId: MOVIE, releaseId: 'r' };
    const [first, second] = await Promise.all([
      test.manager.start(TEST_ACCOUNT_KEY, [item]),
      test.manager.start(TEST_ACCOUNT_KEY, [item]),
    ]);
    await settle();
    expect(first[0]!.id).toBe(second[0]!.id);
    expect(test.store.forAccount(TEST_ACCOUNT_KEY)).toHaveLength(1);
    expect(test.server.calls.filter((call) => call.startsWith('prepare'))).toHaveLength(1);
  });

  it('keeps identical work ids of different servers apart', async () => {
    const test = setup();
    const other = 'http://other.test#v-anna';
    await test.manager.start(TEST_ACCOUNT_KEY, [{ workId: MOVIE, releaseId: 'r' }]);
    await test.manager.start(other, [{ workId: MOVIE, releaseId: 'r' }]);
    await settle();
    expect(test.store.forAccount(TEST_ACCOUNT_KEY)).toHaveLength(1);
    expect(test.store.forAccount(other)).toHaveLength(1);
  });

  it('C1-06: a file removed after launch is caught at play start and fails the record (Retry, Remove)', async () => {
    const test = setup();
    const download = fakeOfflineDownload({ id: 'missing-file' });
    seedDownloads(test, [download]);
    await settle();
    expect(
      await checkLocalPlayTarget(MOVIE, TEST_ACCOUNT_KEY, test.manager, test.engine)
    ).not.toBeNull();
    await test.engine.deletePath(download.relativePath!);
    expect(
      await checkLocalPlayTarget(MOVIE, TEST_ACCOUNT_KEY, test.manager, test.engine)
    ).toBeNull();
    expect(test.store.get('missing-file')).toMatchObject({
      state: 'failed',
      error: { code: 'file_missing', actions: ['retry', 'remove'] },
    });
    expect(resolveLocalPlayTarget(MOVIE, TEST_ACCOUNT_KEY, test.manager, test.engine)).toBeNull();
  });

  it('C1-06: a truncated file is not a play target either', async () => {
    const test = setup();
    const download = fakeOfflineDownload({ id: 'short', sizeBytes: GB });
    seedDownloads(test, [download]);
    test.engine.controls.writeFile(download.relativePath!, GB / 2);
    expect(
      await checkLocalPlayTarget(MOVIE, TEST_ACCOUNT_KEY, test.manager, test.engine)
    ).toBeNull();
  });

  it('C1-06/C1-23: Retry of a missing file prepares it anew and downloads it again', async () => {
    const test = setup();
    const download = fakeOfflineDownload({ id: 'gone', downloadId: 'old-srv' });
    seedDownloads(test, [download]);
    await test.engine.deletePath(download.relativePath!);
    await test.manager.verifyLocalFile('gone');
    await test.manager.retry('gone');
    await settle();
    expect(test.store.get('gone')).toMatchObject({ state: 'downloading', downloadId: 'srv-1' });
    expect(test.server.calls).toContain('prepare:tmdb-movie-603');
  });

  it('C1-13: "delete watched" removes a finished file once playing ends, never while the player holds it', async () => {
    const test = setup();
    const download = fakeOfflineDownload({ id: 'watched' });
    seedDownloads(test, [download]);
    await settle();
    test.manager.setDeleteWatched(true);
    const release = test.manager.holdFile('watched');
    test.manager.recordPosition(TEST_ACCOUNT_KEY, MOVIE, 95, 100);
    await settle();
    expect(test.store.get('watched')).toBeDefined();
    release();
    await settle();
    expect(test.store.get('watched')).toBeUndefined();
    expect(test.engine.controls.files()).toEqual({});
  });

  it('C1-13: turning the option on removes downloads already watched', async () => {
    const test = setup();
    seedDownloads(test, [
      fakeOfflineDownload({ id: 'seen' }),
      fakeOfflineDownload({ id: 'unseen', workId: 'tmdb-movie-604' }),
    ]);
    test.manager.recordPosition(TEST_ACCOUNT_KEY, MOVIE, 95, 100);
    await settle();
    expect(test.store.get('seen')).toBeDefined();
    test.manager.setDeleteWatched(true);
    await settle();
    expect(test.store.get('seen')).toBeUndefined();
    expect(test.store.get('unseen')).toBeDefined();
  });

  it('C1-17: progress events reach whole-library subscribers coalesced, the download itself at once', async () => {
    jest.useFakeTimers();
    try {
      const test = createTestDownloads();
      const detach = test.manager.attach();
      for (let index = 0; index < 200; index += 1)
        test.store.put(
          fakeOfflineDownload({ id: `library-${index}`, workId: `tmdb-movie-${index + 1}` })
        );
      const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
        { workId: 'tmdb-movie-999', releaseId: 'r' },
      ]);
      await jest.advanceTimersByTimeAsync(50);
      const all = jest.fn();
      const own = jest.fn();
      const unsubscribe = test.store.subscribe(all);
      const unsubscribeOwn = test.store.subscribeTo(download!.id, own);
      for (let index = 1; index <= 100; index += 1)
        test.engine.controls.progress(download!.id, index * 100, { bytesPerSecond: 1000 });
      expect(all.mock.calls.length).toBeLessThanOrEqual(2);
      expect(own.mock.calls.length).toBeGreaterThanOrEqual(100);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(all.mock.calls.length).toBeLessThanOrEqual(2);
      expect(test.store.get(download!.id)!.bytesWritten).toBe(10_000);
      unsubscribe();
      unsubscribeOwn();
      detach();
    } finally {
      jest.useRealTimers();
    }
  });

  it('C1-18: a 409 size_mismatch completion stays unacknowledged and says why; 404 counts as gone', async () => {
    const test = setup();
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.server.failNext('complete', new AppError('size_mismatch', { status: 409 }));
    test.engine.controls.complete(download!.id);
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'done',
      serverCompleted: false,
      error: { code: 'size_mismatch', status: 409 },
    });
    test.manager.wake();
    await settle();
    expect(test.server.calls.filter((call) => call.startsWith('complete'))).toHaveLength(1);

    const other = setup();
    const [second] = await other.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    other.server.failNext('complete', new AppError('download_not_ready', { status: 409 }));
    other.engine.controls.complete(second!.id);
    await settle();
    expect(other.store.get(second!.id)!.serverCompleted).toBe(false);
    other.manager.wake();
    await settle();
    expect(other.store.get(second!.id)!.serverCompleted).toBe(true);
  });

  it('C1-19: the gap between polls leaves no abort listener behind', async () => {
    const controller = new AbortController();
    const add = jest.spyOn(controller.signal, 'addEventListener');
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    for (let round = 0; round < 5; round += 1) await abortableDelay(1, controller.signal);
    expect(add).toHaveBeenCalledTimes(5);
    expect(remove).toHaveBeenCalledTimes(5);
    const waiting = abortableDelay(60_000, controller.signal);
    controller.abort();
    await waiting;
    expect(remove).toHaveBeenCalledTimes(6);
  });

  it('C1-19: a long preparation polls without piling up listeners', async () => {
    const test = setup();
    test.server.autoReady = false;
    const add = jest.spyOn(AbortSignal.prototype, 'addEventListener');
    const remove = jest.spyOn(AbortSignal.prototype, 'removeEventListener');
    await test.manager.start(TEST_ACCOUNT_KEY, [{ workId: MOVIE, releaseId: 'r' }]);
    await new Promise((r) => setTimeout(r, 60));
    const polls = test.server.calls.filter((call) => call === 'get:srv-1').length;
    expect(polls).toBeGreaterThan(3);
    const abortAdds = add.mock.calls.filter(([type]) => type === 'abort').length;
    const abortRemoves = remove.mock.calls.filter(([type]) => type === 'abort').length;
    expect(abortAdds - abortRemoves).toBeLessThanOrEqual(1);
  });
});
