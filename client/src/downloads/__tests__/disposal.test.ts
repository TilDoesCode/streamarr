import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ViewerPolicy } from '../types';
import {
  createTestDownloads,
  fakeOfflineDownload,
  seedDownloads,
  TEST_ACCOUNT_KEY as OWNER,
} from '../../../jest/downloads';

type Test = ReturnType<typeof createTestDownloads>;
const MOVIE = 'tmdb-movie-603';
const cleanup: (() => void)[] = [];
const settle = async (rounds = 30) => {
  for (let index = 0; index < rounds; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  jest.restoreAllMocks();
});

/** `key` of `target` is called at once; its answer waits until released (`times` calls, default one). */
function holdAnswer<T extends object>(target: T, key: keyof T, times = 1) {
  const original = (target[key] as (...args: unknown[]) => Promise<unknown>).bind(target);
  const entered = deferred<void>();
  const gate = deferred<void>();
  let held = 0;
  const spy = jest.spyOn(target, key as never) as unknown as jest.Mock;
  spy.mockImplementation(async (...args: unknown[]) => {
    const answer = original(...args);
    if (held >= times) return answer;
    held += 1;
    if (held === times) entered.resolve();
    await gate.promise;
    return answer;
  });
  return { entered: entered.promise, release: () => gate.resolve() };
}

/** All a manager can change outside itself: engine calls, server calls and the stored state. */
function outside(test: Test) {
  const engine = test.engine as unknown as Record<string, unknown>;
  const spies = Object.keys(engine)
    .filter((key) => typeof engine[key] === 'function')
    .map((key) => [key, jest.spyOn(engine as never, key as never) as jest.SpyInstance] as const);
  return () => {
    test.store.flush();
    return {
      engine: spies.map(([key, spy]) => `${key}:${spy.mock.calls.length}`),
      server: [...test.server.calls],
      stored: JSON.stringify([...test.storage.entries].sort()),
    };
  };
}

/** Disposes while `held` waits, then lets its answer arrive: nothing outside the manager may change after dispose(). */
async function disposedMidAwait(test: Test, held: { release(): void }, detach: () => void) {
  const look = outside(test);
  detach();
  const before = look();
  held.release();
  await settle();
  expect(look()).toEqual(before);
}

/** DL-C-verify7 C7-01: a disposed manager never acts again, whatever answer arrives after dispose(). */
describe('a disposed manager stops at its next await (C7-01)', () => {
  /** The verifier's setup: a restart's DELETE is held, Pause → Resume queue a handover behind it. */
  async function pendingHandover(completed: boolean) {
    const test = createTestDownloads({ signOutFlushMs: 5 });
    test.server.autoReady = !completed;
    test.manager.setKnownOwners([OWNER]);
    const detach = test.manager.attach();
    cleanup.push(detach);
    const [record] = await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
    await settle();
    const deletion = holdAnswer(test.server, 'remove');
    if (completed)
      test.server.records.set('srv-1', {
        ...test.server.records.get('srv-1')!,
        state: 'completed',
      });
    else test.engine.controls.fail(record!.id, 'validator_changed');
    await deletion.entered;
    test.server.autoReady = true;
    await test.manager.pause(record!.id);
    await test.manager.resume(record!.id);
    return { test, id: record!.id, deletion, detach };
  }

  it.each([
    ['validator change', false],
    ['completed server record', true],
  ])(
    '%s: the handover is not replayed against a replacement in the same process',
    async (_kind, completed) => {
      const { test, id, deletion, detach } = await pendingHandover(completed);
      detach();
      const next = test.restart();
      next.setKnownOwners([OWNER]);
      cleanup.push(next.attach());
      await settle();
      expect(next.store.get(id)).toMatchObject({ state: 'downloading', restartReason: null });
      const serverId = next.store.get(id)!.downloadId;
      const calls = test.engine.controls.calls.length;
      deletion.release();
      await settle();
      expect(next.store.get(id)).toMatchObject({ state: 'downloading', downloadId: serverId });
      expect(test.engine.controls.calls.slice(calls)).toEqual([]);
      expect(test.engine.controls.tasks()).toHaveLength(1);
      expect(test.server.calls.filter((call) => call.startsWith('prepare:'))).toHaveLength(2);
    }
  );

  it('a live handover still runs after the DELETE (nothing disposed)', async () => {
    const { test, id, deletion } = await pendingHandover(false);
    deletion.release();
    await settle();
    expect(test.store.get(id)).toMatchObject({ state: 'downloading', restartReason: null });
    expect(test.engine.controls.tasks()).toHaveLength(1);
  });

  it('a restart whose DELETE answers after dispose() sends and writes nothing', async () => {
    const { test, deletion, detach } = await pendingHandover(false);
    await disposedMidAwait(test, deletion, detach);
  });

  it('prepare: a POST answered after dispose() starts no transfer and writes no server id', async () => {
    const test = createTestDownloads();
    const detach = test.manager.attach();
    cleanup.push(detach);
    const post = holdAnswer(test.server, 'prepare');
    await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
    await post.entered;
    await disposedMidAwait(test, post, detach);
    expect(test.engine.controls.tasks()).toEqual([]);
  });

  it('renew: a renewed link answered after dispose() is not written', async () => {
    const test = createTestDownloads();
    const detach = test.manager.attach();
    cleanup.push(detach);
    const [download] = await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
    await settle();
    test.store.update(download!.id, {
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const renew = holdAnswer(test.server, 'renew');
    test.manager.wake();
    await renew.entered;
    await disposedMidAwait(test, renew, detach);
  });

  it('cleanup jobs: a deletion answered after dispose() deletes and settles nothing more', async () => {
    const test = createTestDownloads();
    const volumeId = fakeOfflineDownload().volumeId;
    const paths = ['downloads/gone/a.part', 'downloads/gone/b.part', 'downloads/gone'];
    for (const path of paths.slice(0, 2)) test.engine.controls.writeFile(path, 10, volumeId);
    test.store.setCleanupJobs([
      { id: 'gone', accountKey: OWNER, volumeId, paths, bytes: 20, attempts: 0, nextAt: 0 },
    ]);
    const deletion = holdAnswer(test.engine, 'deletePath');
    const detach = test.manager.attach();
    cleanup.push(detach);
    await deletion.entered;
    await disposedMidAwait(test, deletion, detach);
    expect(test.store.cleanupJobs().map((job) => job.id)).toEqual(['gone']);
  });

  it('outbox flush: DELETEs answered after dispose() drop nothing and send no next one', async () => {
    const test = createTestDownloads();
    test.manager.setKnownOwners([OWNER]);
    test.store.setPendingDeletes(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((downloadId) => ({ accountKey: OWNER, downloadId }))
    );
    const deletes = holdAnswer(test.server, 'remove', 4);
    const detach = test.manager.attach();
    cleanup.push(detach);
    await deletes.entered;
    await disposedMidAwait(test, deletes, detach);
    expect(test.store.pendingDeletes()).toHaveLength(6);
  });

  it('age timer: a verdict answered after dispose() is not written and no next work is asked', async () => {
    const test = createTestDownloads();
    const restricted: ViewerPolicy = {
      maxAge: 12,
      blockUnrated: true,
      allowDownloads: true,
      at: Date.now(),
    };
    seedDownloads(test, [
      fakeOfflineDownload({
        id: 'age-1',
        workId: 'tmdb-movie-1',
        meta: { title: 'Movie', accessVerified: false },
      }),
      fakeOfflineDownload({
        id: 'age-2',
        workId: 'tmdb-movie-2',
        meta: { title: 'Movie', accessVerified: false },
      }),
    ]);
    test.store.setPolicy(OWNER, restricted);
    const access = holdAnswer(test.server, 'access');
    const detach = test.manager.attach();
    cleanup.push(detach);
    void test.manager.revalidateAccess(OWNER);
    await access.entered;
    await disposedMidAwait(test, access, detach);
    expect(test.server.calls.filter((call) => call.startsWith('access:'))).toHaveLength(1);
  });

  it('reconcile: a launch list answered after dispose() prepares, resumes and writes nothing', async () => {
    const test = createTestDownloads();
    seedDownloads(test, [
      fakeOfflineDownload({
        id: 'queued-1',
        state: 'queued',
        completedAt: null,
        downloadId: null,
        relativePath: null,
        engine: null,
        sizeBytes: null,
        bytesWritten: 0,
      }),
    ]);
    const list = holdAnswer(test.engine, 'list');
    const detach = test.manager.attach();
    cleanup.push(detach);
    await list.entered;
    await disposedMidAwait(test, list, detach);
    expect(test.server.calls.filter((call) => call.startsWith('prepare:'))).toEqual([]);
  });

  it('removal: a cancel answered after dispose() deletes no file and no record', async () => {
    const test = createTestDownloads();
    const detach = test.manager.attach();
    cleanup.push(detach);
    const [download] = await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
    await settle();
    const cancel = holdAnswer(test.engine, 'cancel');
    void test.manager.remove(download!.id);
    await cancel.entered;
    await disposedMidAwait(test, cancel, detach);
    expect(test.store.get(download!.id)!.state).toBe('removing');
  });

  it('a disposed manager sends nothing when asked: its calls are never made', async () => {
    const test = createTestDownloads();
    const detach = test.manager.attach();
    const [download] = await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
    await settle();
    const look = outside(test);
    detach();
    const engineBefore = look().engine;
    const serverBefore = look().server;
    void test.manager.pause(download!.id);
    test.manager.wake();
    void test.manager.reconcileServers();
    await settle();
    expect(look().engine).toEqual(engineBefore);
    expect(look().server).toEqual(serverBefore);
  });
});

/** The guard holds only while every way out goes through it. */
describe('manager.ts reaches its dependencies only through the lifetime guard', () => {
  const text = readFileSync(join(__dirname, '..', 'manager.ts'), 'utf8');
  const count = (pattern: RegExp) => text.match(pattern)?.length ?? 0;

  it('the engine is guarded once, in the constructor', () => {
    expect(count(/\bdeps\.engine\b/g)).toBe(1);
    expect(text).toMatch(/this\.engine = this\.guarded\(deps\.engine, ENGINE_SYNC\);/);
  });

  it('servers are reached through serverFor() only', () => {
    expect(count(/this\.deps\s*\.serverFor\(/g)).toBe(1);
    expect(text).toMatch(
      /private serverFor\([^)]*\)[^{]*\{\s*const server = this\.deps\.serverFor\(/
    );
  });

  it('the device profile and the artwork are fetched through call() only', () => {
    expect(count(/this\.deps\.(deviceProfile|artwork)\b/g)).toBe(
      count(/this\.call\(\(\) => this\.deps\.(deviceProfile|artwork\.fetch)\(/g)
    );
  });
});
