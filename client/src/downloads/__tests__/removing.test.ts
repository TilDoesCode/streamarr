import { AppError } from '@/api/errors';
import { downloadEngineError } from '@/downloads/engine';
import { createFakeDownloadEngine } from '@/downloads/engine/fake';

import { isActiveDownload, isPendingStop, isRemovingDownload, pendingRetryDelay } from '../manager';
import { DownloadStore } from '../store';
import { createTestDownloads, TEST_ACCOUNT_KEY, type TestDownloads } from '../../../jest/downloads';

const GB = 1024 ** 3;
const MOVIE = 'tmdb-movie-603';

async function settle(rounds = 8) {
  for (let round = 0; round < rounds; round += 1) await new Promise((r) => setTimeout(r, 0));
}

let detach: (() => void) | null = null;
afterEach(() => {
  detach?.();
  detach = null;
});

async function downloading(test: TestDownloads) {
  detach = test.manager.attach();
  const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
    { workId: MOVIE, releaseId: 'r' },
  ]);
  await settle();
  test.engine.controls.progress(download!.id, GB / 3);
  return download!.id;
}

const parts = (test: TestDownloads) =>
  Object.keys(test.engine.controls.files()).filter((path) => path.endsWith('.part'));
const engineCalls = (test: TestDownloads, call: string) =>
  test.engine.controls.calls.filter((item) => item === call).length;
const persisted = (test: TestDownloads, id: string) =>
  new DownloadStore({ storage: test.storage }).get(id);

describe('removing (DL decision)', () => {
  it('is set and persisted synchronously, before the engine is asked', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    const before = test.engine.controls.calls.length;
    const removal = test.manager.remove(id);
    expect(test.store.get(id)!.state).toBe('removing');
    expect(persisted(test, id)!.state).toBe('removing');
    expect(test.engine.controls.calls.length).toBe(before);
    // The record keeps its fields, but counts nowhere.
    expect(test.store.get(id)).toMatchObject({ downloadId: 'srv-1', bytesWritten: GB / 3 });
    expect(isActiveDownload(test.store.get(id)!)).toBe(false);
    await removal;
    expect(test.store.get(id)).toBeUndefined();
    expect(test.engine.controls.files()).toEqual({});
    expect(test.server.calls).toContain('remove:srv-1');
  });

  it('goes engine → media file → record → artwork → server, the outbox written before the record goes', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    await test.manager.snapshot(id);
    const record = test.store.get(id)!;
    const order: string[] = [];
    const { engine, store, server } = test;
    const cancel = engine.cancel.bind(engine);
    const deletePath = engine.deletePath.bind(engine);
    const drop = store.delete.bind(store);
    const remove = server.remove.bind(server);
    engine.cancel = async (taskId) => {
      order.push('engine');
      return cancel(taskId);
    };
    engine.deletePath = async (path, volumeId) => {
      order.push(path === record.relativePath ? 'media' : 'artwork');
      return deletePath(path, volumeId);
    };
    store.delete = (recordId) => {
      order.push(store.pendingDeletes().length ? 'record (outbox written)' : 'record');
      drop(recordId);
    };
    server.remove = async (downloadId) => {
      order.push('server');
      return remove(downloadId);
    };
    await test.manager.remove(id);
    await settle();
    expect(order).toEqual(['engine', 'media', 'record (outbox written)', 'artwork', 'server']);
    expect(store.pendingDeletes()).toEqual([]);
  });

  it('cancel_pending: stays removing with its files until the transfer ended, never fails', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    test.engine.controls.stallDrain(id);
    const states = new Set<string>();
    test.manager.onChange(() => states.add(test.store.get(id)?.state ?? 'gone'));
    const removal = test.manager.remove(id);
    await settle(20);
    expect(test.store.get(id)!.state).toBe('removing');
    expect(engineCalls(test, `cancel:${id}`)).toBeGreaterThan(1);
    expect(parts(test)).toHaveLength(1);
    expect(test.server.calls).not.toContain('remove:srv-1');
    test.engine.controls.releaseDrain(id);
    await removal;
    expect(test.store.get(id)).toBeUndefined();
    expect(test.engine.controls.files()).toEqual({});
    expect(test.server.calls).toContain('remove:srv-1');
    expect([...states]).not.toContain('failed');
  });

  it('remove_pending: a failed task (missing volume) is forgotten once its transfer ended', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    test.engine.controls.fail(id, { kind: 'file_system', message: 'volume_unavailable' });
    await settle();
    expect(test.store.get(id)!.state).toBe('waiting_volume');
    test.engine.controls.stallDrain(id);
    const removal = test.manager.remove(id);
    await settle(20);
    expect(test.store.get(id)!.state).toBe('removing');
    expect(engineCalls(test, `remove:${id}`)).toBeGreaterThan(1);
    expect(engineCalls(test, `cancel:${id}`)).toBe(0);
    test.engine.controls.releaseDrain(id);
    await removal;
    expect(test.store.get(id)).toBeUndefined();
    expect(parts(test)).toEqual([]);
  });

  it('an unsolicited cancel (notification) turns removing at once, also while its transfer still ends', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    test.engine.controls.stallDrain(id);
    test.engine.controls.userCancel(id);
    expect(test.store.get(id)!.state).toBe('removing');
    await settle(20);
    expect(test.store.get(id)!.state).toBe('removing');
    test.engine.controls.releaseDrain(id);
    await settle(20);
    expect(test.store.get(id)).toBeUndefined();
    expect(await test.engine.list()).toEqual([]);
  });

  it('a removal the app did not finish continues at the next launch', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    test.engine.controls.stallDrain(id);
    const removal = test.manager.remove(id);
    await settle(20);
    detach?.();
    detach = null;
    await removal;
    expect(persisted(test, id)!.state).toBe('removing');
    expect(parts(test)).toHaveLength(1);
    test.engine.controls.releaseDrain(id);
    const relaunched = test.restart();
    detach = relaunched.attach();
    await settle(20);
    expect(relaunched.store.get(id)).toBeUndefined();
    expect(test.engine.controls.files()).toEqual({});
    expect(test.server.calls).toContain('remove:srv-1');
  });

  it('refuses to download a work again while it is being removed (work_removing)', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    test.engine.controls.stallDrain(id);
    const removal = test.manager.remove(id);
    await expect(
      test.manager.start(TEST_ACCOUNT_KEY, [{ workId: MOVIE, releaseId: 'r' }])
    ).rejects.toMatchObject({ code: 'work_removing' });
    expect(test.store.all().map((download) => download.id)).toEqual([id]);
    test.engine.controls.releaseDrain(id);
    await removal;
    const [again] = await test.manager.start(TEST_ACCOUNT_KEY, [{ workId: MOVIE, releaseId: 'r' }]);
    expect(again!.id).not.toBe(id);
    expect(again!.state).toBe('queued');
  });

  it('a failed download replaced by a new start whose removal is still pending is refused too', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    test.engine.controls.fail(id, { kind: 'file_system', message: 'disk on fire' });
    await settle();
    expect(test.store.get(id)!.state).toBe('failed');
    test.engine.controls.stallDrain(id);
    detach?.();
    detach = null;
    await expect(
      test.manager.start(TEST_ACCOUNT_KEY, [{ workId: MOVIE, releaseId: 'r' }])
    ).rejects.toMatchObject({ code: 'work_removing' });
    expect(isRemovingDownload(test.store.get(id)!)).toBe(true);
  });

  it('any other io is a real error: the removal goes on without retrying', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    const cancel = test.engine.cancel.bind(test.engine);
    test.engine.cancel = async (taskId) => {
      await cancel(taskId);
      throw downloadEngineError('io', 'cancel_pending_but_not_really');
    };
    await test.manager.remove(id);
    expect(engineCalls(test, `cancel:${id}`)).toBe(1);
    expect(test.store.get(id)).toBeUndefined();
  });

  it('matches the pending answers exactly', () => {
    expect(isPendingStop(downloadEngineError('io', 'cancel_pending'))).toBe(true);
    expect(isPendingStop(downloadEngineError('io', 'remove_pending'))).toBe(true);
    expect(isPendingStop(downloadEngineError('io', 'cancel_pending (30 s)'))).toBe(false);
    expect(isPendingStop(downloadEngineError('io', 'socket closed'))).toBe(false);
    expect(isPendingStop(downloadEngineError('invalid_state', 'cancel_pending'))).toBe(false);
    expect(isPendingStop(new Error('io: cancel_pending'))).toBe(false);
  });

  it('never waits for the server: the deletion stays in the outbox until it is answered', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    const remove = test.server.remove.bind(test.server);
    let answer: (() => void) | null = null;
    test.server.remove = (downloadId) =>
      new Promise((resolve, reject) => {
        answer = () => remove(downloadId).then(resolve, reject);
      });
    await test.manager.remove(id);
    expect(test.store.get(id)).toBeUndefined();
    expect(test.store.pendingDeletes()).toEqual([
      { accountKey: TEST_ACCOUNT_KEY, downloadId: 'srv-1' },
    ]);
    answer!();
    await settle();
    expect(test.store.pendingDeletes()).toEqual([]);
  });

  it('a preparation answered after the removal has its server record deleted', async () => {
    const test = createTestDownloads();
    detach = test.manager.attach();
    const prepare = test.server.prepare.bind(test.server);
    let answer: (() => void) | null = null;
    test.server.prepare = (body) =>
      new Promise((resolve, reject) => {
        answer = () => prepare(body).then(resolve, reject);
      });
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    expect(answer).not.toBeNull();
    await test.manager.remove(download!.id);
    expect(test.store.get(download!.id)).toBeUndefined();
    answer!();
    await settle();
    expect(test.server.calls).toContain('remove:srv-1');
    expect(test.store.pendingDeletes()).toEqual([]);
    expect(test.store.all()).toEqual([]);
  });

  it('late engine events never bring a removing download back', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    test.engine.controls.stallDrain(id);
    const removal = test.manager.remove(id);
    await settle();
    expect(test.store.get(id)!.state).toBe('removing');
    test.manager.wake();
    await test.manager.resume(id);
    await test.manager.retry(id);
    await settle();
    expect(test.store.get(id)!.state).toBe('removing');
    expect(engineCalls(test, `resume:${id}`)).toBe(0);
    test.engine.controls.releaseDrain(id);
    await removal;
  });

  it('a season is marked removing as a whole before any of it is deleted', async () => {
    const test = createTestDownloads();
    detach = test.manager.attach();
    const episodes = ['tmdb-tv-1396-s02e01', 'tmdb-tv-1396-s02e02'];
    await test.manager.start(
      TEST_ACCOUNT_KEY,
      episodes.map((workId) => ({ workId, releaseId: 'r' }))
    );
    await settle();
    const removal = test.manager.removeSeason(TEST_ACCOUNT_KEY, 'tmdb-tv-1396-s02');
    expect(test.store.all().map((download) => download.state)).toEqual(['removing', 'removing']);
    await removal;
    expect(test.store.all()).toEqual([]);
  });
});

describe('DL-N fix round 2 semantics', () => {
  it('retryAt is display only: a wall-clock jump never cuts the engine’s Retry-After wait short', async () => {
    let elapsed = 5_000_000;
    let wall = 1_700_000_000_000;
    const engine = createFakeDownloadEngine({ now: () => elapsed, wallNow: () => wall });
    const test = createTestDownloads({ engine, now: () => wall });
    const id = await downloading(test);
    test.engine.controls.httpStatus(id, 429, { retryAfterMs: 600_000 });
    await settle();
    expect(test.store.get(id)).toMatchObject({ state: 'waiting_server', retryAt: wall + 600_000 });
    // The device clock jumps two hours ahead: the shown time has passed, the engine's wait has not.
    wall += 2 * 3_600_000;
    test.manager.wake();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(engineCalls(test, `resume:${id}`)).toBe(0);
    expect((await test.engine.get(id))!.state).toBe('retrying');
    elapsed += 600_000;
    test.engine.controls.tick();
    await settle();
    expect(test.store.get(id)!.state).toBe('downloading');
  });

  it('the viewer’s Retry still cuts an engine wait short', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    test.engine.controls.httpStatus(id, 503, { retryAfterMs: 600_000 });
    await settle();
    expect(test.store.get(id)!.state).toBe('waiting_server');
    await test.manager.retry(id);
    await settle();
    expect(engineCalls(test, `resume:${id}`)).toBe(1);
    expect(test.store.get(id)!.state).toBe('downloading');
  });
});

it('queued deletions go out at the next wake (reconnect, foreground, sign-in)', async () => {
  const test = createTestDownloads();
  const id = await downloading(test);
  test.signedOut.add(TEST_ACCOUNT_KEY);
  await test.manager.remove(id);
  expect(test.store.pendingDeletes()).toHaveLength(1);
  test.signedOut.clear();
  test.manager.wake();
  await settle();
  expect(test.store.pendingDeletes()).toEqual([]);
  expect(test.server.calls.filter((call) => call === 'remove:srv-1')).toHaveLength(1);
});

describe('removing spec (orchestrator): launch, outbox, backoff', () => {
  it('a tombstone found at launch takes the same path: removing is saved before the engine forgets it', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    detach?.();
    detach = null;
    test.engine.controls.userCancel(id);
    const remove = test.engine.remove.bind(test.engine);
    const seen: (string | undefined)[] = [];
    test.engine.remove = async (taskId) => {
      seen.push(persisted(test, taskId)?.state);
      return remove(taskId);
    };
    const relaunched = test.restart();
    detach = relaunched.attach();
    await settle(20);
    expect(seen).toEqual(['removing']);
    expect(relaunched.store.get(id)).toBeUndefined();
    expect(await test.engine.list()).toEqual([]);
    expect(test.engine.controls.files()).toEqual({});
    expect(test.server.calls.filter((call) => call === 'remove:srv-1')).toHaveLength(1);
    expect(relaunched.store.pendingDeletes()).toEqual([]);
  });

  it('offline: files go at once, the DELETE waits in the outbox and drains on reconnect', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    test.server.failNext('remove', new TypeError('Network request failed'));
    await test.manager.remove(id);
    await settle();
    expect(test.store.get(id)).toBeUndefined();
    expect(test.engine.controls.files()).toEqual({});
    expect(test.store.pendingDeletes()).toEqual([
      { accountKey: TEST_ACCOUNT_KEY, downloadId: 'srv-1' },
    ]);
    test.manager.wake();
    await settle();
    expect(test.store.pendingDeletes()).toEqual([]);
    expect(test.server.calls.filter((call) => call === 'remove:srv-1')).toHaveLength(2);
  });

  it('a 401 keeps the DELETE queued until the profile signs in again; a 404 counts as done', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    test.server.failNext('remove', new AppError('unauthorized', { status: 401 }));
    await test.manager.remove(id);
    await settle();
    expect(test.store.pendingDeletes()).toHaveLength(1);
    test.server.failNext('remove', new AppError('download_not_found', { status: 404 }));
    test.manager.resumeSignedOut([TEST_ACCOUNT_KEY]);
    await settle();
    expect(test.store.pendingDeletes()).toEqual([]);
  });

  it('pending cancels/removes are asked again with a doubling gap, capped at 30 × the first', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((attempts) => pendingRetryDelay(attempts, 1_000))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });
});

describe('DL-N fix round 3', () => {
  const ORPHAN = 'orphan';
  const ORPHAN_PATH = 'a00000000000000000/orphan/Movie.mkv';

  async function orphan(test: TestDownloads, state: 'paused' | 'failed' | 'completed') {
    await test.engine.start({
      id: ORPHAN,
      url: 'http://dev.test/api/v1/offline/cap-x',
      relativePath: ORPHAN_PATH,
      expectedBytes: GB,
    });
    test.engine.controls.progress(ORPHAN, GB / 4);
    if (state === 'paused') await test.engine.pause(ORPHAN);
    if (state === 'failed') test.engine.controls.fail(ORPHAN, 'file_system');
    if (state === 'completed') test.engine.controls.complete(ORPHAN);
    expect((await test.engine.get(ORPHAN))!.state).toBe(state);
  }

  const recordDeletes = (test: TestDownloads) => {
    const deleted: string[] = [];
    const deletePath = test.engine.deletePath.bind(test.engine);
    test.engine.deletePath = async (path, volumeId) => {
      deleted.push(path);
      return deletePath(path, volumeId);
    };
    return deleted;
  };

  it.each(['paused', 'failed'] as const)(
    'N3-02: the orphan sweep never deletes the paths of a still registered %s task',
    async (state) => {
      const test = createTestDownloads();
      await orphan(test, state);
      // The stop fails for real (no pending answer): the engine still holds the task and its paths.
      jest
        .spyOn(test.engine, state === 'paused' ? 'cancel' : 'remove')
        .mockRejectedValueOnce(downloadEngineError('io', 'disk on fire'));
      const deleted = recordDeletes(test);
      await test.manager.reconcile();
      expect(deleted).toEqual([]);
      expect((await test.engine.get(ORPHAN))!.state).toBe(state);
      expect(parts(test)).toEqual([`internal:${ORPHAN_PATH}.part`]);
      // The next launch, once the engine lets it go, deletes the folder.
      await test.manager.reconcile();
      expect(await test.engine.get(ORPHAN)).toBeNull();
      expect(test.engine.controls.files()).toEqual({});
    }
  );

  it('N3-02: a completed orphan stays the manager’s: its file goes even when the engine could not forget it', async () => {
    const test = createTestDownloads();
    await orphan(test, 'completed');
    jest
      .spyOn(test.engine, 'remove')
      .mockRejectedValueOnce(downloadEngineError('io', 'disk on fire'));
    await test.manager.reconcile();
    expect(test.engine.controls.files()).toEqual({});
  });

  it('N3-02: a removal whose stop failed for real drops the record, the held files wait for the launch sweep', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    jest
      .spyOn(test.engine, 'cancel')
      .mockRejectedValueOnce(downloadEngineError('io', 'disk on fire'));
    const deleted = recordDeletes(test);
    await test.manager.remove(id);
    expect(test.store.get(id)).toBeUndefined();
    expect(deleted).toEqual([]);
    expect(parts(test)).toHaveLength(1);
    detach?.();
    detach = null;
    const relaunched = test.restart();
    detach = relaunched.attach();
    await settle(20);
    expect(await test.engine.list()).toEqual([]);
    expect(test.engine.controls.files()).toEqual({});
    expect(test.server.calls.filter((call) => call === 'remove:srv-1')).toHaveLength(1);
  });

  it('N3-06: a tombstone still draining at launch is removed in the background, never failed, while other downloads re-attach', async () => {
    const test = createTestDownloads();
    detach = test.manager.attach();
    await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
      { workId: 'tmdb-movie-10378', releaseId: 'r' },
    ]);
    await settle();
    // The launch reaches the cancelled one first: an awaited removal would hold up the other.
    const [a, b] = test.store.all().map((download) => download.id) as [string, string];
    test.engine.controls.progress(a, GB / 3);
    test.engine.controls.progress(b, GB / 3);
    const serverRecord = test.store.get(a)!.downloadId!;
    detach();
    detach = null;
    // The viewer cancels in the notification while JS is not running; the transfer does not end yet.
    test.engine.controls.stallDrain(a);
    test.engine.controls.userCancel(a);
    test.engine.controls.complete(b);

    const relaunched = test.restart();
    const states = new Set<string>();
    relaunched.onChange(() => states.add(relaunched.store.get(a)?.state ?? 'gone'));
    detach = relaunched.attach();
    await settle(30);
    expect(persisted(test, a)!.state).toBe('removing');
    expect(engineCalls(test, `remove:${a}`) + engineCalls(test, `cancel:${a}`)).toBeGreaterThan(1);
    expect(parts(test)).toHaveLength(1);
    expect(test.server.calls).not.toContain(`remove:${serverRecord}`);
    // The launch went on: the download finished meanwhile is verified while the other one still drains.
    expect(relaunched.store.get(b)!.state).toBe('done');

    test.engine.controls.releaseDrain(a);
    await settle(40);
    expect(relaunched.store.get(a)).toBeUndefined();
    expect(parts(test)).toEqual([]);
    expect(Object.keys(test.engine.controls.files()).some((path) => path.includes(a))).toBe(false);
    expect(test.server.calls.filter((call) => call === `remove:${serverRecord}`)).toHaveLength(1);
    expect(relaunched.store.pendingDeletes()).toEqual([]);
    expect([...states]).not.toContain('failed');
  });
});
