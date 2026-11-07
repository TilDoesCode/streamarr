/** Server housekeeping: the outbox, sessions and orphan scans (DL-C-verify2 C2-01, C2-02, C2-04, C2-10). */
import { AppError } from '@/api/errors';

import {
  createTestDownloads,
  createFakeDownloadsServer,
  fakeOfflineDownload,
  TEST_ACCOUNT_KEY as OWNER,
} from '../../../jest/downloads';

const cleanup: (() => void)[] = [];
const settle = async (rounds = 12) => {
  for (let index = 0; index < rounds; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  jest.restoreAllMocks();
});

describe('server housekeeping (verify 2)', () => {
  it('C2-01: an orphan scan goes through the outbox and stops at a 401 (the DELETE stays parked)', async () => {
    const test = createTestDownloads();
    cleanup.push(() => test.manager.dispose());
    test.store.setPendingDeletes([{ accountKey: OWNER, downloadId: 'parked' }]);
    test.server.records.set('parked', {
      downloadId: 'parked',
      state: 'ready',
      thisDevice: true,
    } as never);
    const remove = jest
      .spyOn(test.server, 'remove')
      .mockRejectedValue(new AppError('unauthorized', { status: 401 }));
    await test.manager.reconcileServers();
    await test.manager.reconcileServers();
    expect(test.store.pendingDeletes()).toHaveLength(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('C2-02: a 401 of the previous session never parks the new signed-in one', async () => {
    const test = createTestDownloads({ signOutFlushMs: 10 });
    cleanup.push(() => test.manager.dispose());
    const old = deferred<void>();
    const remove = jest
      .spyOn(test.server, 'remove')
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValue(undefined);
    test.store.setPendingDeletes([{ accountKey: OWNER, downloadId: 'old' }]);
    await test.manager.removeForSignOut(OWNER);
    test.signedOut.add(OWNER);
    test.signedOut.delete(OWNER);
    test.manager.resumeSignedOut([OWNER]);
    await settle();
    expect(test.store.pendingDeletes()).toEqual([]);
    old.reject(new AppError('unauthorized', { status: 401 }));
    await settle();
    test.store.setPendingDeletes([{ accountKey: OWNER, downloadId: 'new' }]);
    test.manager.wake();
    await settle();
    expect(remove).toHaveBeenCalledWith('new');
    expect(test.store.pendingDeletes()).toEqual([]);
  });

  it('C2-04: a list answer racing a prepare never deletes the new preparation as an orphan', async () => {
    const test = createTestDownloads();
    cleanup.push(() => test.manager.dispose());
    const listing = deferred<Awaited<ReturnType<typeof test.server.list>>>();
    const list = jest.spyOn(test.server, 'list').mockImplementationOnce(() => listing.promise);
    const prepare = test.server.prepare.bind(test.server);
    const prepared = deferred<Awaited<ReturnType<typeof test.server.prepare>>>();
    jest.spyOn(test.server, 'prepare').mockImplementation(async (body) => {
      const response = await prepare(body);
      await prepared.promise;
      return response;
    });
    const reconcile = test.manager.reconcileServers();
    // This owner has no local data yet, so use the signed-in owners list and start its scan.
    await reconcile;
    test.manager.setKnownOwners([OWNER]);
    const scan = test.manager.reconcileServers();
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    await test.manager.start(OWNER, [{ workId: 'tmdb-movie-603', releaseId: 'r' }]);
    await settle();
    expect(test.server.records.has('srv-1')).toBe(true);
    listing.resolve({ items: [...test.server.records.values()], limits: {} } as never);
    await scan;
    prepared.resolve({} as never);
    await settle();
    expect(test.server.calls).not.toContain('remove:srv-1');
    expect(test.server.records.has('srv-1')).toBe(true);
  });

  it('C2-10: a hung list of one profile never holds up another profile queued at launch', async () => {
    const other = 'http://other.test#v-ben';
    const a = createFakeDownloadsServer();
    const b = createFakeDownloadsServer('http://other.test');
    const test = createTestDownloads({ servers: { [OWNER]: a, [other]: b } });
    cleanup.push(() => test.manager.dispose());
    test.manager.setKnownOwners([OWNER, other]);
    test.store.put(
      fakeOfflineDownload({
        id: 'launch-b',
        accountKey: other,
        state: 'queued',
        completedAt: null,
        downloadId: null,
        relativePath: null,
        engine: null,
        sizeBytes: null,
        bytesWritten: 0,
      })
    );
    const pending = deferred<Awaited<ReturnType<typeof a.list>>>();
    jest.spyOn(a, 'list').mockImplementationOnce(() => pending.promise);
    const launch = test.manager.reconcile();
    await settle();
    const preparedBeforeOtherServerAnswered = b.calls.includes('prepare:tmdb-movie-603');
    pending.resolve({ items: [], limits: {} } as never);
    await launch;
    await settle();
    expect(preparedBeforeOtherServerAnswered).toBe(true);
  });
});
