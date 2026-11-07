import { AppError } from '@/api/errors';

import { createTestDownloads, TEST_ACCOUNT_KEY as OWNER } from '../../../jest/downloads';

const cleanup: (() => void)[] = [];
const settle = async (rounds = 12) => {
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

/** DL-C-verify2 C2-05: an await in the transfer path never brings back what the viewer stopped meanwhile. */
describe('transfer intent', () => {
  it('C2-05: a pause during a delayed revoked-link GET survives; Resume renews and continues', async () => {
    const test = createTestDownloads();
    cleanup.push(test.manager.attach());
    const [download] = await test.manager.start(OWNER, [
      { workId: 'tmdb-movie-603', releaseId: 'r' },
    ]);
    const id = download!.id;
    await settle();
    test.server.revoke('srv-1');
    const pending = deferred<Awaited<ReturnType<typeof test.server.get>>>();
    jest.spyOn(test.server, 'get').mockImplementationOnce(() => pending.promise);
    test.engine.controls.httpStatus(id, 410);
    await settle();
    await test.manager.pause(id);
    expect(test.store.get(id)!.state).toBe('paused');
    const resumesBefore = test.engine.controls.calls.filter((call) => call === `resume:${id}`);
    pending.resolve(test.server.records.get('srv-1')!);
    await settle();
    expect(test.store.get(id)!.state).toBe('paused');
    // The stopped transfer is not resumed by the late answer (the fake cannot pause a failed task).
    expect(test.engine.controls.calls.filter((call) => call === `resume:${id}`)).toEqual(
      resumesBefore
    );
    expect(['paused', 'failed']).toContain((await test.engine.get(id))!.state);

    await test.manager.resume(id);
    await settle();
    expect(test.server.calls).toContain('renew:srv-1');
    expect(test.store.get(id)!.state).toBe('downloading');
  });

  it('C2-05: a removal during a delayed renew never starts the transfer again', async () => {
    const test = createTestDownloads();
    cleanup.push(test.manager.attach());
    const [download] = await test.manager.start(OWNER, [
      { workId: 'tmdb-movie-603', releaseId: 'r' },
    ]);
    const id = download!.id;
    await settle();
    test.server.revoke('srv-1');
    const renew = test.server.renew.bind(test.server);
    const gate = deferred<void>();
    jest.spyOn(test.server, 'renew').mockImplementationOnce(async (downloadId, deviceId) => {
      await gate.promise;
      return renew(downloadId, deviceId);
    });
    test.engine.controls.httpStatus(id, 410);
    await settle();
    const removal = test.manager.remove(id);
    gate.resolve();
    await removal;
    await settle();
    expect(test.store.get(id)).toBeUndefined();
    expect(await test.engine.get(id)).toBeNull();
  });

  it('N2-12 (device): an admin sign-out landing while the revoked link asks its record parks it; sign-in resumes on its bytes', async () => {
    const test = createTestDownloads();
    cleanup.push(test.manager.attach());
    test.manager.setKnownOwners([OWNER]);
    const [download] = await test.manager.start(OWNER, [
      { workId: 'tmdb-movie-603', releaseId: 'r' },
    ]);
    const id = download!.id;
    await settle();
    test.engine.controls.progress(id, 1_756_436);
    test.server.revoke('srv-1');
    // The API client's refresh fails first: the profile is signed out before the 401 reaches the manager.
    jest.spyOn(test.server, 'get').mockImplementationOnce(async () => {
      test.manager.setKnownOwners([]);
      throw new AppError('unauthorized', { status: 401 });
    });
    test.engine.controls.httpStatus(id, 410);
    await settle();
    expect(test.store.get(id)).toMatchObject({
      state: 'waiting_server',
      error: { code: 'signed_out' },
      bytesWritten: 1_756_436,
    });

    test.manager.setKnownOwners([OWNER]);
    test.manager.resumeSignedOut([OWNER]);
    await settle();
    expect(test.store.get(id)).toMatchObject({ state: 'downloading', bytesWritten: 1_756_436 });
    expect(test.engine.controls.tasks()[0]!.url).toBe(
      'http://dev.test/api/v1/offline/cap-srv-1-renewed'
    );
  });

  it('N2-12: a late record answer a sign-out made stale parks the download instead of freezing it', async () => {
    const test = createTestDownloads();
    cleanup.push(test.manager.attach());
    test.manager.setKnownOwners([OWNER]);
    const [download] = await test.manager.start(OWNER, [
      { workId: 'tmdb-movie-603', releaseId: 'r' },
    ]);
    const id = download!.id;
    await settle();
    test.server.revoke('srv-1');
    const pending = deferred<Awaited<ReturnType<typeof test.server.get>>>();
    jest.spyOn(test.server, 'get').mockImplementationOnce(() => pending.promise);
    test.engine.controls.httpStatus(id, 410);
    await settle();
    test.manager.setKnownOwners([]);
    pending.resolve(test.server.records.get('srv-1')!);
    await settle();
    expect(test.store.get(id)).toMatchObject({
      state: 'waiting_server',
      error: { code: 'signed_out' },
    });

    // A pause after the sign-out is the viewer's: the older continuation never parks it again.
    await test.manager.pause(id);
    expect(test.store.get(id)!.state).toBe('paused');
  });
});

/** DL-C-verify3 C3-01: every manager operation rechecks (intent, session) after each await; a newer intent wins. */
describe('intent across every await (C3-01)', () => {
  const MOVIE = 'tmdb-movie-603';
  const GIB = 1024 ** 3;
  type Test = ReturnType<typeof createTestDownloads>;
  async function started(test: Test) {
    cleanup.push(test.manager.attach());
    const [download] = await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
    await settle();
    return download!.id;
  }
  /** The next call of `name` waits for `release()`; `entered` resolves when it was called. */
  function holdNext<T extends object, K extends keyof T>(target: T, name: K) {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const original = (target[name] as (...args: unknown[]) => unknown).bind(target);
    jest.spyOn(target, name as never).mockImplementationOnce((async (...args: unknown[]) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    }) as never);
    return { entered: entered.promise, release: () => gate.resolve() };
  }

  describe('enqueue', () => {
    it('a sign-out during the space check parks the download and starts nothing; sign-in starts it', async () => {
      const test = createTestDownloads();
      cleanup.push(test.manager.attach());
      test.manager.setKnownOwners([OWNER]);
      await settle();
      const space = holdNext(test.engine, 'storage');
      const [download] = await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
      const id = download!.id;
      await space.entered;
      test.signedOut.add(OWNER);
      test.manager.setKnownOwners([]);
      space.release();
      await settle();
      expect(test.store.get(id)).toMatchObject({
        state: 'waiting_server',
        error: { code: 'signed_out' },
      });
      expect(await test.engine.get(id)).toBeNull();
      expect(test.engine.controls.calls).not.toContain(`start:${id}`);

      test.signedOut.delete(OWNER);
      test.manager.setKnownOwners([OWNER]);
      test.manager.resumeSignedOut([OWNER]);
      await settle();
      expect(test.store.get(id)!.state).toBe('downloading');
    });

    it('a sign-out while the engine starts the task pauses that task and keeps the download parked', async () => {
      const test = createTestDownloads();
      cleanup.push(test.manager.attach());
      test.manager.setKnownOwners([OWNER]);
      await settle();
      const start = holdNext(test.engine, 'start');
      const [download] = await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
      const id = download!.id;
      await start.entered;
      test.signedOut.add(OWNER);
      test.manager.setKnownOwners([]);
      start.release();
      await settle();
      expect(test.store.get(id)).toMatchObject({
        state: 'waiting_server',
        error: { code: 'signed_out' },
      });
      expect((await test.engine.get(id))!.state).toBe('paused');

      test.signedOut.delete(OWNER);
      test.manager.setKnownOwners([OWNER]);
      test.manager.resumeSignedOut([OWNER]);
      await settle();
      expect(test.store.get(id)!.state).toBe('downloading');
    });

    it('a removal during the space check or the tombstone lookup starts nothing', async () => {
      for (const step of ['storage', 'get'] as const) {
        const test = createTestDownloads();
        cleanup.push(test.manager.attach());
        const held = holdNext(test.engine, step);
        const [download] = await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
        await held.entered;
        const removal = test.manager.remove(download!.id);
        held.release();
        await removal;
        await settle();
        expect(test.store.get(download!.id)).toBeUndefined();
        expect(await test.engine.get(download!.id)).toBeNull();
      }
    });
  });

  describe('engine Resume', () => {
    it('a Pause while the engine resumes wins: the record and the native task end paused', async () => {
      const test = createTestDownloads();
      const id = await started(test);
      await test.manager.pause(id);
      const resume = holdNext(test.engine, 'resume');
      const resuming = test.manager.resume(id);
      await resume.entered;
      await test.manager.pause(id);
      expect(test.store.get(id)!.state).toBe('paused');
      resume.release();
      await resuming;
      await settle();
      expect(test.store.get(id)!.state).toBe('paused');
      expect((await test.engine.get(id))!.state).toBe('paused');

      await test.manager.resume(id);
      await settle();
      expect(test.store.get(id)!.state).toBe('downloading');
    });

    it('engine events never move a download the viewer paused; the native task is paused once', async () => {
      const test = createTestDownloads();
      const id = await started(test);
      test.engine.controls.progress(id, GIB / 4);
      await test.manager.pause(id);
      const pauses = () => test.engine.controls.calls.filter((call) => call === `pause:${id}`);
      const before = pauses().length;
      // The engine carries out an older resume by itself.
      await test.engine.resume(id);
      await settle();
      expect(test.store.get(id)).toMatchObject({ state: 'paused' });
      expect((await test.engine.get(id))!.state).toBe('paused');
      expect(pauses().length - before).toBe(1);
      // A late progress event of that transfer updates the bytes only.
      test.engine.controls.progress(id, GIB / 3);
      await settle();
      expect(test.store.get(id)).toMatchObject({ state: 'paused', bytesWritten: GIB / 3 });
      expect(pauses().length - before).toBe(1);
    });

    it('a removal while the engine resumes leaves no record and no task', async () => {
      const test = createTestDownloads();
      const id = await started(test);
      await test.manager.pause(id);
      const resume = holdNext(test.engine, 'resume');
      const resuming = test.manager.resume(id);
      await resume.entered;
      const removal = test.manager.remove(id);
      resume.release();
      await Promise.all([resuming, removal]);
      await settle();
      expect(test.store.get(id)).toBeUndefined();
      expect(await test.engine.get(id)).toBeNull();
    });
  });

  describe('validator-change restart', () => {
    it('a Pause during the server DELETE keeps paused, keeps the bytes and prepares nothing until Resume', async () => {
      const test = createTestDownloads();
      const id = await started(test);
      test.engine.controls.progress(id, GIB / 2);
      await settle();
      const deletion = holdNext(test.server, 'remove');
      test.engine.controls.fail(id, 'validator_changed');
      await deletion.entered;
      await test.manager.pause(id);
      expect(test.store.get(id)!.state).toBe('paused');
      deletion.release();
      await settle();
      const prepares = () => test.server.calls.filter((call) => call.startsWith('prepare:'));
      expect(test.store.get(id)).toMatchObject({
        state: 'paused',
        bytesWritten: GIB / 2,
        restartReason: 'validator_changed',
        restarts: 1,
      });
      expect(prepares()).toHaveLength(1);

      // A relaunch keeps the unfinished restart; the explicit Resume finishes it.
      cleanup.shift()!();
      const relaunched = test.restart();
      cleanup.push(relaunched.attach());
      await settle();
      expect(relaunched.store.get(id)).toMatchObject({
        state: 'paused',
        restartReason: 'validator_changed',
      });
      expect(prepares()).toHaveLength(1);
      await relaunched.resume(id);
      await settle(20);
      expect(prepares()).toHaveLength(2);
      expect(relaunched.store.get(id)).toMatchObject({
        state: 'downloading',
        restarts: 1,
        restartReason: null,
      });
    });

    it('a removal during the server DELETE ends the restart: nothing is prepared again', async () => {
      const test = createTestDownloads();
      const id = await started(test);
      const deletion = holdNext(test.server, 'remove');
      test.engine.controls.fail(id, 'validator_changed');
      await deletion.entered;
      const removal = test.manager.remove(id);
      deletion.release();
      await removal;
      await settle();
      expect(test.store.get(id)).toBeUndefined();
      expect(test.server.calls.filter((call) => call.startsWith('prepare:'))).toHaveLength(1);
    });

    it('a sign-out during the server DELETE parks it; the sign-in finishes the restart', async () => {
      const test = createTestDownloads();
      test.manager.setKnownOwners([OWNER]);
      const id = await started(test);
      const deletion = holdNext(test.server, 'remove');
      test.engine.controls.fail(id, 'validator_changed');
      await deletion.entered;
      test.manager.setKnownOwners([]);
      deletion.release();
      await settle();
      expect(test.store.get(id)).toMatchObject({
        state: 'waiting_server',
        error: { code: 'signed_out' },
        restartReason: 'validator_changed',
      });
      expect(test.server.calls.filter((call) => call.startsWith('prepare:'))).toHaveLength(1);

      test.manager.setKnownOwners([OWNER]);
      test.manager.resumeSignedOut([OWNER]);
      await settle(20);
      expect(test.store.get(id)).toMatchObject({ state: 'downloading', restartReason: null });
      expect(test.server.calls.filter((call) => call.startsWith('prepare:'))).toHaveLength(2);
    });
  });
});
