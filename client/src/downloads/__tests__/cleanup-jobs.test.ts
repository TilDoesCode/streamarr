import { downloadEngineError } from '@/downloads/engine';
import { filePathOf } from '@/downloads/keys';

import {
  createTestDownloads,
  fakeOfflineDownload,
  seedDownloads,
  TEST_ACCOUNT_KEY as OWNER,
} from '../../../jest/downloads';

const GB = 1024 ** 3;
const SD = 'volume-6f1c2e7a-0b3d-4e52-9a1f-2c8d4b7e9a10';
const SD_VOLUME = {
  id: SD,
  uri: 'file:///sd/',
  removable: true,
  freeBytes: 50 * GB,
  totalBytes: 64 * GB,
};
const cleanup: (() => void)[] = [];
const settle = async (rounds = 12) => {
  for (let index = 0; index < rounds; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
};
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  jest.restoreAllMocks();
});

/** DL-C-verify2 C2-03: a removal whose file deletion fails keeps a persisted cleanup job until the files are gone. */
describe('cleanup jobs', () => {
  it('C2-03: a deletion failure keeps a job; the next launch reclaims the file', async () => {
    const test = createTestDownloads();
    cleanup.push(() => test.manager.dispose());
    const download = fakeOfflineDownload({
      id: 'unmounted',
      relativePath: filePathOf(OWNER, 'unmounted', 'Movie.mkv'),
    });
    seedDownloads(test, [download]);
    const original = test.engine.deletePath.bind(test.engine);
    const deletion = jest
      .spyOn(test.engine, 'deletePath')
      .mockRejectedValue(downloadEngineError('io', 'volume_unavailable'));
    await test.manager.remove(download.id);
    expect(test.store.get(download.id)).toBeUndefined();
    expect(await test.engine.fileSize(download.relativePath!)).toBe(download.sizeBytes);
    expect(test.store.cleanupJobs()).toMatchObject([
      {
        id: download.id,
        paths: [download.relativePath, `${download.relativePath!.replace(/\/[^/]+$/, '')}`],
      },
    ]);
    // Still counted as used: the bytes are on the device.
    expect(test.store.cleanupBytes()).toBe(download.sizeBytes);
    deletion.mockImplementation(original);
    const restarted = test.restart();
    cleanup.push(() => restarted.dispose());
    await restarted.reconcile();
    expect(await test.engine.fileSize(download.relativePath!)).toBeNull();
    expect(test.store.cleanupJobs()).toEqual([]);
    expect(test.store.cleanupBytes()).toBe(0);
  });

  it('C2-03: a missing volume parks the job until the volume returns', async () => {
    const test = createTestDownloads();
    cleanup.push(test.manager.attach());
    test.engine.controls.mountVolume(SD_VOLUME);
    const relativePath = filePathOf(OWNER, 'sd-movie', 'Movie.mkv');
    const download = fakeOfflineDownload({ id: 'sd-movie', relativePath, volumeId: SD });
    seedDownloads(test, [download]);
    expect(await test.engine.fileSize(relativePath, SD)).toBe(download.sizeBytes);
    test.engine.controls.unmountVolume(SD);
    await test.manager.remove(download.id);
    await settle();
    expect(test.store.get(download.id)).toBeUndefined();
    expect(test.store.cleanupJobs()).toHaveLength(1);
    // Retried while the volume is away: still parked, nothing lost.
    test.manager.wake();
    await settle();
    expect(test.store.cleanupJobs()).toHaveLength(1);
    test.engine.controls.mountVolume(SD_VOLUME);
    test.manager.wake();
    await settle(20);
    expect(test.store.cleanupJobs()).toEqual([]);
    expect(await test.engine.fileSize(relativePath, SD)).toBeNull();
  });

  it('C2-03: a job never deletes the paths of a registered unfinished task (N3-02); it waits until they are let go', async () => {
    const test = createTestDownloads();
    cleanup.push(test.manager.attach());
    const [started] = await test.manager.start(OWNER, [
      { workId: 'tmdb-movie-603', releaseId: 'r' },
    ]);
    const id = started!.id;
    await settle();
    test.engine.controls.progress(id, GB / 4);
    // The stop fails for real: the engine still holds the task and its paths.
    jest.spyOn(test.engine, 'cancel').mockRejectedValue(downloadEngineError('io', 'disk on fire'));
    const deleted: string[] = [];
    const deletePath = test.engine.deletePath.bind(test.engine);
    jest.spyOn(test.engine, 'deletePath').mockImplementation(async (path, volumeId) => {
      deleted.push(path);
      return deletePath(path, volumeId);
    });
    await test.manager.remove(id);
    expect(test.store.get(id)).toBeUndefined();
    expect(deleted).toEqual([]);
    expect(test.store.cleanupJobs()).toHaveLength(1);
    test.manager.wake();
    await settle();
    expect(deleted).toEqual([]);
    // The engine lets the task go: the next launch deletes the files.
    jest.mocked(test.engine.cancel).mockRestore();
    await test.engine.cancel(id);
    await test.manager.reconcile();
    expect(test.store.cleanupJobs()).toEqual([]);
    expect(Object.keys(test.engine.controls.files()).some((path) => path.includes(id))).toBe(false);
  });
});

/** DL-C-verify3 C3-02: every job change works on the stored list of that moment, never on an older copy. */
describe('cleanup jobs under concurrent removals (C3-02)', () => {
  const internal = [
    {
      id: 'internal',
      uri: 'file:///private/',
      removable: false,
      freeBytes: 1e10,
      totalBytes: 2e10,
    },
  ];
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  function twoMovies() {
    const test = createTestDownloads();
    cleanup.push(() => test.manager.dispose());
    const records = ['cleanup-a', 'cleanup-b'].map((id, index) =>
      fakeOfflineDownload({
        id,
        workId: `tmdb-movie-${index + 1}`,
        relativePath: filePathOf(OWNER, id, 'Movie.mkv'),
      })
    );
    seedDownloads(test, records);
    return { test, records };
  }
  const ids = (test: ReturnType<typeof createTestDownloads>) =>
    test.store
      .cleanupJobs()
      .map((job) => job.id)
      .sort();

  it('two failing removals at once keep both jobs, also after a relaunch', async () => {
    const { test, records } = twoMovies();
    jest
      .spyOn(test.engine, 'deletePath')
      .mockRejectedValue(downloadEngineError('io', 'disk unavailable'));
    const gate = deferred<typeof internal>();
    jest.spyOn(test.engine, 'volumes').mockImplementationOnce(() => gate.promise);
    const first = test.manager.remove(records[0]!.id);
    await settle();
    expect(ids(test)).toEqual(['cleanup-a']);
    await test.manager.remove(records[1]!.id);
    expect(ids(test)).toEqual(['cleanup-a', 'cleanup-b']);
    gate.resolve(internal);
    await first;
    expect(ids(test)).toEqual(['cleanup-a', 'cleanup-b']);
    expect(test.store.cleanupBytes()).toBe(2 * GB);
    expect(test.store.cleanupJobs().every((job) => job.attempts === 1)).toBe(true);

    test.manager.dispose();
    const relaunched = test.restart();
    expect(
      relaunched.store
        .cleanupJobs()
        .map((job) => job.id)
        .sort()
    ).toEqual(['cleanup-a', 'cleanup-b']);
    expect(relaunched.store.cleanupBytes()).toBe(2 * GB);
  });

  it('a job settled while another one waits is not brought back, and a new one added meanwhile stays', async () => {
    const { test, records } = twoMovies();
    const original = test.engine.deletePath.bind(test.engine);
    const failing = new Set(records.map((record) => record.id));
    jest
      .spyOn(test.engine, 'deletePath')
      .mockImplementation((path, volumeId) =>
        [...failing].some((id) => path.includes(`/${id}`))
          ? Promise.reject(downloadEngineError('io', 'disk unavailable'))
          : original(path, volumeId)
      );
    const gate = deferred<typeof internal>();
    const volumes = test.engine.volumes.bind(test.engine);
    jest
      .spyOn(test.engine, 'volumes')
      .mockImplementationOnce(() => gate.promise)
      .mockImplementation(volumes);
    const first = test.manager.remove(records[0]!.id);
    await settle();
    await test.manager.remove(records[1]!.id);
    expect(ids(test)).toEqual(['cleanup-a', 'cleanup-b']);
    // B's disk is back: its retry settles B while A still waits for the volume answer.
    failing.delete('cleanup-b');
    await (test.manager as unknown as { runCleanups(force: boolean): Promise<void> }).runCleanups(
      true
    );
    gate.resolve(internal);
    await first;
    await settle();
    expect(ids(test)).toEqual(['cleanup-a']);
    expect(test.store.cleanupBytes()).toBe(GB);
  });
});
