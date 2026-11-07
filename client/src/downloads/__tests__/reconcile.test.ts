import {
  createTestDownloads,
  fakeOfflineDownload,
  TEST_ACCOUNT_KEY,
} from '../../../jest/downloads';
import type { DownloadManager } from '../manager';

const GB = 1024 ** 3;
const MOVIE = 'tmdb-movie-603';

async function settle(rounds = 10) {
  for (let round = 0; round < rounds; round += 1) await new Promise((r) => setTimeout(r, 0));
}

const detachers: (() => void)[] = [];
function attach(manager: DownloadManager) {
  detachers.push(manager.attach());
  return manager;
}
afterEach(() => detachers.splice(0).forEach((detach) => detach()));

describe('launch reconciliation (engine ↔ store ↔ server)', () => {
  it('picks up a file that finished while the app was killed', async () => {
    const test = createTestDownloads();
    attach(test.manager);
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.progress(download!.id, GB / 3);
    detachers.pop()!();
    test.engine.controls.complete(download!.id);
    expect(test.store.get(download!.id)!.state).toBe('downloading');

    const relaunched = attach(test.restart());
    await settle();
    expect(relaunched.store.get(download!.id)).toMatchObject({
      state: 'done',
      serverCompleted: true,
      bytesWritten: GB,
    });
    expect(test.engine.controls.tasks()).toEqual([]);
  });

  it('re-attaches a running transfer and follows its progress', async () => {
    const test = createTestDownloads();
    attach(test.manager);
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    detachers.pop()!();

    const relaunched = attach(test.restart());
    await settle();
    test.engine.controls.progress(download!.id, GB / 2);
    expect(relaunched.store.get(download!.id)).toMatchObject({
      state: 'downloading',
      bytesWritten: GB / 2,
    });
  });

  it('continues polling a preparation that was running when the app died', async () => {
    const test = createTestDownloads();
    test.server.autoReady = false;
    attach(test.manager);
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({ state: 'preparing', downloadId: 'srv-1' });
    detachers.pop()!();
    test.server.ready('srv-1');

    const relaunched = attach(test.restart());
    await settle();
    expect(relaunched.store.get(download!.id)!.state).toBe('downloading');
    expect(test.server.calls.filter((call) => call.startsWith('prepare'))).toHaveLength(1);
  });

  it('prepares again with the same clientRef when the app died between POST and saving the id', async () => {
    const test = createTestDownloads();
    const record = fakeOfflineDownload({
      id: 'dlost',
      workId: MOVIE,
      state: 'preparing',
      downloadId: null,
      relativePath: null,
      sizeBytes: null,
      engine: null,
      bytesWritten: 0,
      serverCompleted: false,
    });
    test.store.put(record);
    await test.server.prepare({ workId: MOVIE, releaseId: 'rel-1', clientRef: 'dlost' });

    const relaunched = attach(test.restart());
    await settle();
    expect(relaunched.store.get('dlost')).toMatchObject({
      downloadId: 'srv-1',
      state: 'downloading',
    });
    expect([...test.server.records.keys()]).toEqual(['srv-1']);
  });

  it('cancels engine tasks nobody owns and deletes their finished files', async () => {
    const test = createTestDownloads();
    await test.engine.start({
      id: 'orphan-run',
      url: 'http://dev.test/x',
      relativePath: 'x/run.mkv',
    });
    await test.engine.start({
      id: 'orphan-done',
      url: 'http://dev.test/y',
      relativePath: 'x/done.mkv',
    });
    test.engine.controls.complete('orphan-done');
    expect(test.engine.controls.files()).toHaveProperty(['internal:x/done.mkv']);

    attach(test.manager);
    await settle();
    expect(test.engine.controls.tasks()).toEqual([]);
    expect(test.engine.controls.files()).toEqual({});
  });

  it('deletes server records of this device that the app does not know', async () => {
    const test = createTestDownloads();
    await test.server.prepare({ workId: 'tmdb-movie-1', releaseId: 'r', clientRef: 'ghost' });
    test.manager.setKnownOwners([TEST_ACCOUNT_KEY]);
    attach(test.manager);
    await settle();
    expect(test.server.calls).toContain('remove:srv-1');
    expect(test.server.records.size).toBe(0);
  });

  it('marks a finished download whose file vanished as failed (file_missing)', async () => {
    const test = createTestDownloads();
    test.store.put(fakeOfflineDownload({ id: 'gone', workId: MOVIE }));
    attach(test.manager);
    await settle();
    expect(test.store.get('gone')).toMatchObject({
      state: 'failed',
      error: { code: 'file_missing' },
    });
  });

  it('restarts the transfer with a fresh URL when the engine lost the task', async () => {
    const test = createTestDownloads();
    attach(test.manager);
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    detachers.pop()!();
    await test.engine.cancel(download!.id);

    attach(test.restart());
    await settle();
    expect(test.engine.controls.tasks().map((task) => task.id)).toEqual([download!.id]);
    expect(test.server.calls).toContain('get:srv-1');
  });

  it('sends a pending completion once the server answers', async () => {
    const test = createTestDownloads();
    attach(test.manager);
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.signedOut.add(TEST_ACCOUNT_KEY);
    test.engine.controls.complete(download!.id);
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({ state: 'done', serverCompleted: false });

    test.signedOut.clear();
    test.manager.wake();
    await settle();
    expect(test.store.get(download!.id)!.serverCompleted).toBe(true);
  });

  it('removes watched downloads at launch when "delete watched" is on', async () => {
    const test = createTestDownloads();
    const seen = fakeOfflineDownload({ id: 'seen', workId: MOVIE });
    test.store.put(seen);
    test.engine.controls.writeFile(seen.relativePath!, GB);
    test.manager.recordPosition(TEST_ACCOUNT_KEY, MOVIE, 95, 100);
    test.manager.setDeleteWatched(true);
    attach(test.manager);
    await settle();
    expect(test.store.get('seen')).toBeUndefined();
  });
});
