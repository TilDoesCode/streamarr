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

  describe('C2-04: a preparation the app died before saving is adopted from the list', () => {
    /** The POST reached the server, the app died before it persisted the answer. */
    async function crashedAfterPost(
      deviceId?: (installId: string) => string,
      options: Parameters<typeof createTestDownloads>[0] = {}
    ) {
      const test = createTestDownloads(options);
      test.store.put(
        fakeOfflineDownload({
          id: 'dlost',
          workId: MOVIE,
          state: 'preparing',
          downloadId: null,
          relativePath: null,
          sizeBytes: null,
          engine: null,
          bytesWritten: 0,
          serverCompleted: false,
        })
      );
      const installId = test.store.installId();
      await test.server.prepare({
        workId: MOVIE,
        releaseId: 'rel-1',
        clientRef: 'dlost',
        deviceId: deviceId ? deviceId(installId) : installId,
      });
      test.server.calls.length = 0;
      return test;
    }

    function relaunch(test: ReturnType<typeof createTestDownloads>) {
      const relaunched = test.restart();
      relaunched.setKnownOwners([TEST_ACCOUNT_KEY]);
      return attach(relaunched);
    }

    it('takes over the server record: one record, no DELETE, no second prepare, the transfer starts', async () => {
      const test = await crashedAfterPost();
      const relaunched = relaunch(test);
      await settle(20);
      expect(relaunched.store.get('dlost')).toMatchObject({
        downloadId: 'srv-1',
        state: 'downloading',
        sizeBytes: GB,
      });
      expect([...test.server.records.keys()]).toEqual(['srv-1']);
      expect(test.server.calls.filter((call) => call.startsWith('prepare'))).toEqual([]);
      expect(test.server.calls.filter((call) => call.startsWith('remove'))).toEqual([]);
      expect(test.engine.controls.tasks().map((task) => [task.id, task.url])).toEqual([
        ['dlost', 'http://dev.test/api/v1/offline/cap-srv-1'],
      ]);
    });

    it('matches an older row whose device id comes back lower-cased (trimmed, ASCII case-insensitive)', async () => {
      const test = await crashedAfterPost((id) => `  ${id.toUpperCase()} `);
      const relaunched = relaunch(test);
      await settle(20);
      expect(relaunched.store.get('dlost')).toMatchObject({
        downloadId: 'srv-1',
        state: 'downloading',
      });
      expect(test.server.calls.filter((call) => call.startsWith('prepare'))).toEqual([]);
      expect(test.server.calls.filter((call) => call.startsWith('remove'))).toEqual([]);
    });

    it('prepares again with the same clientRef when the list does not answer in time (still one record)', async () => {
      const test = await crashedAfterPost(undefined, { adoptWaitMs: 5 });
      jest.spyOn(test.server, 'list').mockImplementationOnce(() => new Promise(() => undefined));
      const relaunched = relaunch(test);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await settle(20);
      expect(relaunched.store.get('dlost')).toMatchObject({
        downloadId: 'srv-1',
        state: 'downloading',
      });
      expect(test.server.calls.filter((call) => call.startsWith('prepare'))).toHaveLength(1);
      expect([...test.server.records.keys()]).toEqual(['srv-1']);
    });

    it("never adopts or deletes another device's record with the same clientRef", async () => {
      const test = await crashedAfterPost(() => 'tablet-7f3c');
      test.server.records.set('srv-1', { ...test.server.records.get('srv-1')!, thisDevice: true });
      const relaunched = relaunch(test);
      await settle(20);
      expect(relaunched.store.get('dlost')).toMatchObject({
        downloadId: 'srv-2',
        state: 'downloading',
      });
      expect(test.server.records.get('srv-1')).toMatchObject({
        deviceId: 'tablet-7f3c',
        clientRef: 'dlost',
        state: 'queued',
      });
      expect(test.server.calls.filter((call) => call.startsWith('prepare'))).toHaveLength(1);
      expect(test.server.calls.filter((call) => call.startsWith('remove'))).toEqual([]);
      expect(test.server.calls).not.toContain('get:srv-1');
    });
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

  it("C2-04: an orphan scan deletes this installation's unknown records, never another device id's", async () => {
    const test = createTestDownloads();
    const installId = test.store.installId();
    await test.server.prepare({
      workId: 'tmdb-movie-1',
      releaseId: 'r',
      clientRef: 'gone',
      deviceId: ` ${installId.toUpperCase()}`,
    });
    // Same viewer session (e.g. the app was reinstalled): the server counts it as this device's.
    await test.server.prepare({
      workId: 'tmdb-movie-2',
      releaseId: 'r',
      clientRef: 'gone',
      deviceId: 'tablet-7f3c',
    });
    test.manager.setKnownOwners([TEST_ACCOUNT_KEY]);
    attach(test.manager);
    await settle();
    expect(test.server.calls.filter((call) => call.startsWith('remove:'))).toEqual([
      'remove:srv-1',
    ]);
    expect([...test.server.records.keys()]).toEqual(['srv-2']);
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

/** DL-N verify 8, N8-03: a file the server names like the artwork folder never targets that folder. */
describe('media file names next to the artwork folder (N8-03)', () => {
  it.each(['art', 'ART', 'Art.', 'art '])(
    'a file named %j downloads beside the artwork, which stays',
    async (fileName) => {
      const test = createTestDownloads();
      attach(test.manager);
      test.server.autoReady = false;
      const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
        { workId: MOVIE, releaseId: 'r' },
      ]);
      await settle();
      test.server.ready('srv-1', { fileName });
      await settle(20);
      const record = test.store.get(download!.id)!;
      const folder = record.relativePath!.slice(0, record.relativePath!.lastIndexOf('/'));
      expect(record.relativePath!.slice(folder.length + 1).toLowerCase()).toBe(
        `${fileName.trim().replace(/\.$/, '').toLowerCase()}_media`
      );
      expect(record.artwork.poster).toBe(`${folder}/art/poster.jpg`);
      expect(record.relativePath!.toLowerCase()).not.toBe(`${folder}/art`);
      expect(test.engine.controls.tasks()[0]!.relativePath).toBe(record.relativePath);
      expect(Object.keys(test.engine.controls.files())).toContain(
        `internal:${record.artwork.poster}`
      );
    }
  );

  it('a record stored with such a path before keeps it across a relaunch', async () => {
    const test = createTestDownloads();
    const legacy = fakeOfflineDownload({ id: 'legacy', workId: MOVIE });
    const path = `${legacy.relativePath!.slice(0, legacy.relativePath!.lastIndexOf('/'))}/art`;
    test.store.put({ ...legacy, relativePath: path });
    test.engine.controls.writeFile(path, legacy.sizeBytes!);
    const relaunched = attach(test.restart());
    await settle();
    expect(relaunched.store.get('legacy')).toMatchObject({ state: 'done', relativePath: path });
  });
});
