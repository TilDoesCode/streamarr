import { AppError } from '@/api/errors';

import { SIGN_OUT_FLUSH_MS } from '../manager';
import {
  createFakeDownloadsServer,
  createTestDownloads,
  fakeOfflineDownload,
  seedDownloads,
  TEST_ACCOUNT_KEY,
  type FakeDownloadsServer,
  type TestDownloads,
} from '../../../jest/downloads';

const GB = 1024 ** 3;
const ANNA = TEST_ACCOUNT_KEY;
const BEN = 'http://dev.test#v-ben';

async function settle(rounds = 10) {
  for (let round = 0; round < rounds; round += 1) await new Promise((r) => setTimeout(r, 0));
}

let detach: (() => void) | null = null;
afterEach(() => {
  jest.useRealTimers();
  detach?.();
  detach = null;
});

/** A transfer in progress (server record srv-1). */
async function downloading(test: TestDownloads) {
  detach = test.manager.attach();
  const [download] = await test.manager.start(ANNA, [{ workId: 'tmdb-movie-603', releaseId: 'r' }]);
  await settle();
  test.engine.controls.progress(download!.id, GB / 3);
  return download!.id;
}

const deletes = (server: FakeDownloadsServer) =>
  server.calls.filter((call) => call.startsWith('remove:'));
/** The server does not answer at all (unreachable); `restore` answers again and fails the hung requests. */
const hang = (server: FakeDownloadsServer) => {
  const remove = server.remove.bind(server);
  const hung: (() => void)[] = [];
  server.remove = (downloadId) =>
    new Promise<void>((_, reject) => {
      server.calls.push(`remove:${downloadId}`);
      hung.push(() => reject(new TypeError('Network request failed')));
    });
  return () => {
    server.remove = remove;
    for (const fail of hung.splice(0)) fail();
  };
};

describe('sign-out with "Delete downloads" (never waits for drains)', () => {
  it('a stalled drain never holds up the sign-out: the server is told at once, the files go in the background', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    test.engine.controls.stallDrain(id);

    const startedAt = Date.now();
    await test.manager.removeForSignOut(ANNA);
    expect(Date.now() - startedAt).toBeLessThan(SIGN_OUT_FLUSH_MS);
    expect(test.store.get(id)!.state).toBe('removing');
    // Told while the session still worked; the outbox is empty before the sign-out.
    expect(deletes(test.server)).toEqual(['remove:srv-1']);
    expect(test.store.pendingDeletes()).toEqual([]);
    test.signedOut.add(ANNA);

    await settle(20);
    expect(test.store.get(id)!.state).toBe('removing');
    expect(Object.keys(test.engine.controls.files()).some((path) => path.endsWith('.part'))).toBe(
      true
    );
    test.engine.controls.releaseDrain(id);
    await settle(30);
    expect(test.store.get(id)).toBeUndefined();
    expect(test.engine.controls.files()).toEqual({});
    // The local removal never queues the server record again.
    expect(deletes(test.server)).toEqual(['remove:srv-1']);
    expect(test.store.pendingDeletes()).toEqual([]);
  });

  it('a server that does not answer: the sign-out goes on after 5 s, the DELETE waits for the next sign-in', async () => {
    const test = createTestDownloads();
    const id = await downloading(test);
    const restore = hang(test.server);

    jest.useFakeTimers();
    let done = false;
    void test.manager.removeForSignOut(ANNA).then(() => {
      done = true;
    });
    expect(test.store.get(id)!.state).toBe('removing');
    await jest.advanceTimersByTimeAsync(SIGN_OUT_FLUSH_MS - 100);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(100);
    expect(done).toBe(true);
    jest.useRealTimers();
    expect(SIGN_OUT_FLUSH_MS).toBe(5_000);

    test.signedOut.add(ANNA);
    await settle(20);
    // The files are gone, the server record waits in the outbox.
    expect(test.store.get(id)).toBeUndefined();
    expect(test.engine.controls.files()).toEqual({});
    expect(test.store.pendingDeletes()).toEqual([{ accountKey: ANNA, downloadId: 'srv-1' }]);
    test.manager.wake();
    await settle();
    expect(test.store.pendingDeletes()).toHaveLength(1);

    // Signed in again: the next flush sends it.
    restore();
    test.signedOut.delete(ANNA);
    test.manager.resumeSignedOut([ANNA]);
    await settle();
    expect(test.store.pendingDeletes()).toEqual([]);
    expect(test.server.records.has('srv-1')).toBe(false);
  });

  it('a 401 at the flush keeps the DELETE for the next sign-in and stops asking with that session', async () => {
    const test = createTestDownloads();
    seedDownloads(
      test,
      ['a', 'b', 'c', 'd', 'e', 'f'].map((suffix) =>
        fakeOfflineDownload({
          id: `d-${suffix}`,
          accountKey: ANNA,
          workId: `tmdb-movie-60${suffix.charCodeAt(0)}`,
          downloadId: `srv-${suffix}`,
        })
      )
    );
    const remove = test.server.remove.bind(test.server);
    let inFlight = 0;
    let most = 0;
    test.server.remove = async (downloadId) => {
      test.server.calls.push(`remove:${downloadId}`);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await settle(2);
      inFlight -= 1;
      throw new AppError('unauthorized', { status: 401 });
    };
    await test.manager.removeForSignOut(ANNA);
    // At most 4 at once; after the first 401 no new request starts with that session.
    expect(most).toBeLessThanOrEqual(4);
    expect(deletes(test.server).length).toBeLessThanOrEqual(4);
    expect(test.store.pendingDeletes()).toHaveLength(6);

    // The local removals finishing, a wake: nothing asks that session again.
    await settle(20);
    test.manager.wake();
    await settle(20);
    expect(test.store.all()).toEqual([]);
    expect(deletes(test.server).length).toBeLessThanOrEqual(4);
    expect(test.store.pendingDeletes()).toHaveLength(6);

    // Signed in again: a new session sends them all.
    test.server.remove = remove;
    test.manager.resumeSignedOut([ANNA]);
    await settle(20);
    expect(test.store.pendingDeletes()).toEqual([]);
  });

  it('removing the profile drops what the server did not take; a late answer or the local removal queues nothing', async () => {
    const test = createTestDownloads({ signOutFlushMs: 20 });
    const id = await downloading(test);
    test.engine.controls.stallDrain(id);
    let answer: ((ok: boolean) => void) | null = null;
    test.server.remove = (downloadId) =>
      new Promise<void>((resolve, reject) => {
        test.server.calls.push(`remove:${downloadId}`);
        answer = (ok) => (ok ? resolve() : reject(new TypeError('Network request failed')));
      });

    await test.manager.removeForSignOut(ANNA, { forget: true });
    expect(test.store.pendingDeletes()).toEqual([]);
    test.signedOut.add(ANNA);
    answer!(false);
    test.engine.controls.releaseDrain(id);
    await settle(30);
    expect(test.store.get(id)).toBeUndefined();
    expect(test.engine.controls.files()).toEqual({});
    expect(test.store.pendingDeletes()).toEqual([]);
    expect(deletes(test.server)).toEqual(['remove:srv-1']);
  });

  it("another profile's flush is neither held up nor ever sent with this profile's session", async () => {
    const anna = createFakeDownloadsServer();
    const ben = createFakeDownloadsServer();
    const test = createTestDownloads({
      servers: { [ANNA]: anna, [BEN]: ben },
      signOutFlushMs: 300,
    });
    detach = test.manager.attach();
    seedDownloads(test, [
      fakeOfflineDownload({ id: 'd-anna', accountKey: ANNA, downloadId: 'srv-anna' }),
      fakeOfflineDownload({
        id: 'd-ben',
        accountKey: BEN,
        workId: 'tmdb-movie-10378',
        downloadId: 'srv-ben',
      }),
    ]);
    const answerAgain = hang(anna);

    // Anna's server hangs; her sign-out runs its full bound meanwhile.
    let annaDone = false;
    const annaSignOut = test.manager.removeForSignOut(ANNA).then(() => {
      annaDone = true;
    });
    const startedAt = Date.now();
    await test.manager.removeForSignOut(BEN);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(annaDone).toBe(false);
    expect(test.store.pendingDeletes()).toEqual([{ accountKey: ANNA, downloadId: 'srv-anna' }]);

    // Later flushes of every profile: Ben's session only ever carries Ben's record.
    test.manager.wake();
    void test.manager.reconcileServers();
    await settle(20);
    expect(deletes(ben)).toEqual(['remove:srv-ben']);
    expect(deletes(anna).every((call) => call === 'remove:srv-anna')).toBe(true);
    expect(test.store.all()).toEqual([]);
    await annaSignOut;
    expect(test.store.pendingDeletes()).toEqual([{ accountKey: ANNA, downloadId: 'srv-anna' }]);
    answerAgain();
  });
});
