import { AppError } from '@/api/errors';
import { downloadEngineError } from '@/downloads/engine';

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

/** DL-C-verify4 C4-02: the C3-01 rule on every remaining await, rejections (catch branches) included. */
describe('intent across every await, rejections included (C4-02)', () => {
  const MOVIE = 'tmdb-movie-603';
  type Test = ReturnType<typeof createTestDownloads>;
  const prepares = (test: Test) =>
    test.server.calls.filter((call) => call.startsWith('prepare:')).length;
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
  async function started(test: Test, signedIn = false) {
    cleanup.push(test.manager.attach());
    if (signedIn) test.manager.setKnownOwners([OWNER]);
    const [download] = await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
    await settle();
    return download!.id;
  }

  describe('Retry while the old server record is deleted', () => {
    it('a newer Pause wins: no prepare, paused; Resume finishes the retry', async () => {
      const test = createTestDownloads();
      const id = await started(test);
      test.store.update(id, {
        state: 'waiting_server',
        error: { code: 'download_expired', at: Date.now() },
        retryAt: Date.now() + 60_000,
      });
      const deletion = holdNext(test.server, 'remove');
      const retry = test.manager.retry(id);
      await deletion.entered;
      await test.manager.pause(id);
      expect(test.store.get(id)!.state).toBe('paused');
      deletion.release();
      await retry;
      await settle();
      expect(test.store.get(id)!.state).toBe('paused');
      expect(prepares(test)).toBe(1);

      await test.manager.resume(id);
      await settle(20);
      expect(test.store.get(id)).toMatchObject({ state: 'downloading', restartReason: null });
      expect(prepares(test)).toBe(2);
    });

    it('a sign-out parks it; the sign-in finishes the retry with one more prepare', async () => {
      const test = createTestDownloads();
      const id = await started(test, true);
      test.store.update(id, {
        state: 'failed',
        error: { code: 'download_source_gone', at: Date.now() },
      });
      const deletion = holdNext(test.server, 'remove');
      const retry = test.manager.retry(id);
      await deletion.entered;
      test.signedOut.add(OWNER);
      test.manager.setKnownOwners([]);
      deletion.release();
      await retry;
      await settle();
      expect(test.store.get(id)).toMatchObject({
        state: 'waiting_server',
        error: { code: 'signed_out' },
      });
      expect(prepares(test)).toBe(1);

      test.signedOut.delete(OWNER);
      test.manager.setKnownOwners([OWNER]);
      test.manager.resumeSignedOut([OWNER]);
      await settle(20);
      expect(test.store.get(id)!.state).toBe('downloading');
      expect(prepares(test)).toBe(2);
    });

    it('the pending retry survives a relaunch and the next Resume finishes it', async () => {
      const test = createTestDownloads();
      const id = await started(test);
      test.store.update(id, { state: 'failed', error: { code: 'file_missing', at: Date.now() } });
      const deletion = holdNext(test.server, 'remove');
      const retry = test.manager.retry(id);
      await deletion.entered;
      await test.manager.pause(id);
      deletion.release();
      await retry;
      cleanup.shift()!();
      const relaunched = test.restart();
      cleanup.push(relaunched.attach());
      await settle();
      expect(relaunched.store.get(id)).toMatchObject({ state: 'paused', restartReason: 'retry' });
      await relaunched.resume(id);
      await settle(20);
      expect(relaunched.store.get(id)).toMatchObject({ state: 'downloading', error: null });
    });
  });

  it('a late engine start rejection never writes failed over a newer Pause; Resume starts it', async () => {
    const test = createTestDownloads();
    cleanup.push(test.manager.attach());
    await settle();
    const gate = deferred<void>();
    const entered = deferred<void>();
    jest.spyOn(test.engine, 'start').mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      throw downloadEngineError('io', 'start failed');
    });
    const [download] = await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
    const id = download!.id;
    await entered.promise;
    await test.manager.pause(id);
    gate.resolve();
    await settle();
    expect(test.store.get(id)).toMatchObject({ state: 'paused', error: null });
    await test.manager.resume(id);
    await settle(20);
    expect(test.store.get(id)!.state).toBe('downloading');
    expect(prepares(test)).toBe(1);
  });

  describe('preparation', () => {
    it('a ready POST answer after a sign-out is parked with its server id; the sign-in continues it, no second prepare', async () => {
      const test = createTestDownloads();
      cleanup.push(test.manager.attach());
      test.manager.setKnownOwners([OWNER]);
      await settle();
      const gate = deferred<void>();
      const entered = deferred<void>();
      const prepare = test.server.prepare.bind(test.server);
      jest.spyOn(test.server, 'prepare').mockImplementationOnce(async (body) => {
        const result = await prepare(body);
        test.server.ready(result.downloadId!);
        entered.resolve();
        await gate.promise;
        return test.server.records.get(result.downloadId!)!;
      });
      const [download] = await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
      const id = download!.id;
      await entered.promise;
      test.signedOut.add(OWNER);
      test.manager.setKnownOwners([]);
      gate.resolve();
      await settle();
      expect(test.store.get(id)).toMatchObject({
        state: 'waiting_server',
        error: { code: 'signed_out' },
        downloadId: 'srv-1',
      });
      expect(await test.engine.get(id)).toBeNull();

      test.signedOut.delete(OWNER);
      test.manager.setKnownOwners([OWNER]);
      test.manager.resumeSignedOut([OWNER]);
      await settle(20);
      await test.manager.reconcileServers();
      expect(test.store.get(id)).toMatchObject({ state: 'downloading', downloadId: 'srv-1' });
      expect(prepares(test)).toBe(1);
      expect(test.server.calls.filter((call) => call.startsWith('remove:'))).toEqual([]);
    });

    it.each([
      ['a Pause', 'paused'],
      ['a sign-out', 'waiting_server'],
    ])('%s while the device profile is read: nothing is posted', async (what, state) => {
      const deviceGate = deferred<void>();
      const test = createTestDownloads();
      cleanup.push(test.manager.attach());
      test.manager.setKnownOwners([OWNER]);
      await settle();
      const deps = (test.manager as unknown as { deps: { deviceProfile(): Promise<unknown> } })
        .deps;
      const profile = deps.deviceProfile.bind(deps);
      deps.deviceProfile = async () => {
        await deviceGate.promise;
        return profile();
      };
      const [download] = await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
      const id = download!.id;
      await settle();
      if (what === 'a Pause') await test.manager.pause(id);
      else {
        test.signedOut.add(OWNER);
        test.manager.setKnownOwners([]);
      }
      deviceGate.resolve();
      await settle();
      expect(test.store.get(id)!.state).toBe(state);
      expect(prepares(test)).toBe(0);
    });

    it('a late POST rejection after a Pause keeps it paused (no failed)', async () => {
      const test = createTestDownloads();
      cleanup.push(test.manager.attach());
      await settle();
      const gate = deferred<void>();
      const entered = deferred<void>();
      jest.spyOn(test.server, 'prepare').mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        throw new AppError('server_error', { status: 500 });
      });
      const [download] = await test.manager.start(OWNER, [{ workId: MOVIE, releaseId: 'r' }]);
      const id = download!.id;
      await entered.promise;
      await test.manager.pause(id);
      gate.resolve();
      await settle();
      expect(test.store.get(id)).toMatchObject({ state: 'paused', error: null });
    });

    it('a sign-out while the preparation is polled parks it with its server id', async () => {
      const test = createTestDownloads();
      test.server.autoReady = false;
      const id = await started(test, true);
      expect(test.store.get(id)!.state).toBe('preparing');
      const get = holdNext(test.server, 'get');
      await settle();
      await get.entered;
      test.signedOut.add(OWNER);
      test.manager.setKnownOwners([]);
      test.server.ready('srv-1');
      get.release();
      await settle();
      expect(test.store.get(id)).toMatchObject({
        state: 'waiting_server',
        error: { code: 'signed_out' },
        downloadId: 'srv-1',
      });
      expect(await test.engine.get(id)).toBeNull();
    });

    it('a Pause while a completed server record is forgotten keeps paused; Resume finishes the restart', async () => {
      const test = createTestDownloads();
      test.server.autoReady = false;
      const id = await started(test);
      const deletion = holdNext(test.server, 'remove');
      test.server.records.set('srv-1', {
        ...test.server.records.get('srv-1')!,
        state: 'completed',
      });
      await deletion.entered;
      await test.manager.pause(id);
      deletion.release();
      await settle();
      expect(test.store.get(id)).toMatchObject({
        state: 'paused',
        restartReason: 'server_completed',
      });
      expect(prepares(test)).toBe(1);
      test.server.autoReady = true;
      await test.manager.resume(id);
      await settle(20);
      expect(prepares(test)).toBe(2);
      expect(test.store.get(id)).toMatchObject({ state: 'downloading', restartReason: null });
    });
  });
});

/** DL-C-verify5 C5-03: a pending restart is prepared by the restart alone, after its old server record is gone. */
describe('Retry vs. the normal queue (C5-03)', () => {
  const FIRST = 'tmdb-movie-603';
  const SECOND = 'tmdb-movie-604';
  type Test = ReturnType<typeof createTestDownloads>;
  const prepared = (test: Test, work: string) =>
    test.server.calls.filter((call) => call === `prepare:${work}`).length;
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
  /** The first work's preparation failed on the server with a retryable error. */
  async function failed(test: Test, attach = true) {
    test.server.autoReady = false;
    if (attach) cleanup.push(test.manager.attach());
    const [download] = await test.manager.start(OWNER, [{ workId: FIRST, releaseId: 'r' }]);
    await settle();
    test.server.failPreparation('srv-1', 'download_failed', ['retry']);
    await settle();
    expect(test.store.get(download!.id)!.state).toBe('failed');
    return download!.id;
  }

  it('another work starting while the old DELETE is pending never POSTs the retry; one fresh POST after it', async () => {
    const test = createTestDownloads();
    const id = await failed(test);
    const deletion = holdNext(test.server, 'remove');
    const retry = test.manager.retry(id);
    await deletion.entered;
    await test.manager.start(OWNER, [{ workId: SECOND, releaseId: 'r2' }]);
    await settle();
    expect(prepared(test, SECOND)).toBe(1);
    expect(prepared(test, FIRST)).toBe(1);
    expect(test.store.get(id)).toMatchObject({ state: 'queued', restartReason: 'retry' });

    test.server.autoReady = true;
    deletion.release();
    await retry;
    await settle(20);
    expect(prepared(test, FIRST)).toBe(2);
    const calls = test.server.calls;
    expect(calls.indexOf('remove:srv-1')).toBeLessThan(calls.lastIndexOf(`prepare:${FIRST}`));
    expect(test.store.get(id)).toMatchObject({ state: 'downloading', restartReason: null });
    expect(test.store.get(id)!.downloadId).not.toBe('srv-1');
    expect(await test.engine.get(id)).toMatchObject({ state: 'running' });
  });

  it('an old preparation answer that arrives after the reset is ignored: no failed, no obsolete id', async () => {
    const test = createTestDownloads();
    const id = await failed(test);
    // A preparation already sent before the Retry (its reply is late): its answer is the old, failed record.
    const answer = deferred<void>();
    const prepare = test.server.prepare.bind(test.server);
    const sent = deferred<void>();
    jest.spyOn(test.server, 'prepare').mockImplementationOnce(async (body) => {
      const result = await prepare(body);
      sent.resolve();
      await answer.promise;
      return result;
    });
    test.store.update(id, { state: 'queued', error: null });
    (test.manager as unknown as { pump(): void }).pump();
    await sent.promise;
    test.store.update(id, { state: 'failed', error: { code: 'download_failed', at: Date.now() } });
    test.server.autoReady = true;
    await test.manager.retry(id);
    await settle();
    expect(test.server.calls).toContain('remove:srv-1');
    const fresh = holdNext(test.server, 'prepare');
    answer.resolve();
    await fresh.entered;
    // The old answer is dropped: the reset record carries no obsolete server id while it is prepared anew.
    expect(test.store.get(id)).toMatchObject({ state: 'preparing', downloadId: null, error: null });
    fresh.release();
    await settle(20);
    expect(test.store.get(id)).toMatchObject({ state: 'downloading', error: null });
    expect(test.store.get(id)!.downloadId).not.toBe('srv-1');
  });

  it('a relaunch with a queued restart deletes the old record before it prepares again', async () => {
    const test = createTestDownloads();
    const detach = test.manager.attach();
    const id = await failed(test, false);
    // The app dies while the old DELETE is still on its way: the restart is persisted, nothing else.
    holdNext(test.server, 'remove');
    void test.manager.retry(id);
    await settle();
    expect(test.store.get(id)).toMatchObject({ state: 'queued', restartReason: 'retry' });
    detach();
    test.server.autoReady = true;
    const relaunched = test.restart();
    cleanup.push(() => relaunched.dispose());
    relaunched.setKnownOwners([OWNER]);
    cleanup.push(relaunched.attach());
    await settle(20);
    const calls = test.server.calls;
    const removed = calls.lastIndexOf('remove:srv-1');
    expect(removed).toBeGreaterThan(-1);
    expect(prepared(test, FIRST)).toBe(2);
    expect(removed).toBeLessThan(calls.lastIndexOf(`prepare:${FIRST}`));
    expect(relaunched.store.get(id)).toMatchObject({ state: 'downloading', restartReason: null });
    expect(relaunched.store.get(id)!.downloadId).not.toBe('srv-1');
  });

  it('an old DELETE that does not go through keeps the restart waiting; the reconnect finishes it', async () => {
    const test = createTestDownloads();
    const id = await failed(test);
    test.server.failNext('remove', new TypeError('Network request failed'));
    await test.manager.retry(id);
    await settle();
    expect(prepared(test, FIRST)).toBe(1);
    expect(test.store.get(id)).toMatchObject({
      state: 'waiting_server',
      restartReason: 'retry',
      error: { code: 'network' },
    });
    test.server.autoReady = true;
    test.manager.wake();
    await settle(12);
    // Its backoff is not over yet: the wake leaves it waiting.
    expect(prepared(test, FIRST)).toBe(1);
    test.store.update(id, { retryAt: Date.now() - 1 });
    test.manager.wake();
    await settle(20);
    expect(prepared(test, FIRST)).toBe(2);
    expect(test.store.get(id)).toMatchObject({ state: 'downloading', restartReason: null });
    expect(test.store.get(id)!.downloadId).not.toBe('srv-1');
  });

  /** The same race when the server already holds the download as completed (a reinstall): prepared by the restart. */
  describe('a completed server record', () => {
    async function polling(test: Test, attach = true) {
      test.server.autoReady = false;
      if (attach) cleanup.push(test.manager.attach());
      const [download] = await test.manager.start(OWNER, [{ workId: FIRST, releaseId: 'r' }]);
      await settle();
      expect(test.store.get(download!.id)).toMatchObject({
        state: 'preparing',
        downloadId: 'srv-1',
      });
      return download!.id;
    }
    const completeOnServer = (test: Test) =>
      test.server.records.set('srv-1', {
        ...test.server.records.get('srv-1')!,
        state: 'completed',
      });

    it('no POST while its DELETE is pending (another work starts meanwhile); then exactly one fresh POST', async () => {
      const test = createTestDownloads();
      const id = await polling(test);
      const deletion = holdNext(test.server, 'remove');
      completeOnServer(test);
      await deletion.entered;
      await test.manager.start(OWNER, [{ workId: SECOND, releaseId: 'r2' }]);
      await settle();
      expect(prepared(test, SECOND)).toBe(1);
      expect(prepared(test, FIRST)).toBe(1);
      expect(test.store.get(id)).toMatchObject({
        state: 'queued',
        restartReason: 'server_completed',
      });

      test.server.autoReady = true;
      deletion.release();
      await settle(20);
      expect(prepared(test, FIRST)).toBe(2);
      const calls = test.server.calls;
      expect(calls.indexOf('remove:srv-1')).toBeLessThan(calls.lastIndexOf(`prepare:${FIRST}`));
      expect(test.store.get(id)).toMatchObject({
        state: 'downloading',
        restartReason: null,
        error: null,
      });
      expect(test.store.get(id)!.downloadId).not.toBe('srv-1');
    });

    it('a DELETE that does not go through keeps it waiting (no POST to the old record); the reconnect finishes it', async () => {
      const test = createTestDownloads();
      const id = await polling(test);
      test.server.failNext('remove', new TypeError('Network request failed'));
      const deletion = holdNext(test.server, 'remove');
      completeOnServer(test);
      await deletion.entered;
      test.server.autoReady = true;
      deletion.release();
      await settle(20);
      expect(prepared(test, FIRST)).toBe(1);
      expect(test.store.get(id)).toMatchObject({
        state: 'waiting_server',
        restartReason: 'server_completed',
        error: { code: 'network' },
      });
      test.store.update(id, { retryAt: Date.now() - 1 });
      test.manager.wake();
      await settle(20);
      expect(prepared(test, FIRST)).toBe(2);
      expect(test.store.get(id)).toMatchObject({
        state: 'downloading',
        restartReason: null,
        error: null,
      });
      expect(test.store.get(id)!.downloadId).not.toBe('srv-1');
    });

    it('an old reply sent before the reset is ignored: no failed, no obsolete id', async () => {
      const test = createTestDownloads();
      test.server.autoReady = false;
      cleanup.push(test.manager.attach());
      // A preparation whose reply is late: it still names the old record.
      const answer = deferred<void>();
      const sent = deferred<void>();
      const prepare = test.server.prepare.bind(test.server);
      jest.spyOn(test.server, 'prepare').mockImplementationOnce(async (body) => {
        const result = await prepare(body);
        sent.resolve();
        await answer.promise;
        return result;
      });
      const [download] = await test.manager.start(OWNER, [{ workId: FIRST, releaseId: 'r' }]);
      const id = download!.id;
      await sent.promise;
      // Meanwhile a poll of the record learns that the server holds it as completed.
      completeOnServer(test);
      test.server.autoReady = true;
      test.store.update(id, { downloadId: 'srv-1' });
      await (test.manager as unknown as { poll(id: string): Promise<void> }).poll(id);
      expect(test.server.calls).toContain('remove:srv-1');
      expect(prepared(test, FIRST)).toBe(1);
      const fresh = holdNext(test.server, 'prepare');
      answer.resolve();
      await settle();
      // The old answer is dropped: the reset record carries no obsolete server id while it is prepared anew.
      expect(test.store.get(id)).toMatchObject({
        state: 'preparing',
        downloadId: null,
        error: null,
      });
      await fresh.entered;
      fresh.release();
      await settle(20);
      expect(prepared(test, FIRST)).toBe(2);
      expect(test.store.get(id)).toMatchObject({ state: 'downloading', error: null });
      expect(test.store.get(id)!.downloadId).not.toBe('srv-1');
    });

    it('a relaunch while its DELETE is on its way deletes the old record first, then prepares once', async () => {
      const test = createTestDownloads();
      const detach = test.manager.attach();
      const id = await polling(test, false);
      // The app dies while the old DELETE is still on its way: the restart is persisted, nothing else.
      const deletion = holdNext(test.server, 'remove');
      completeOnServer(test);
      await deletion.entered;
      expect(test.store.get(id)).toMatchObject({
        state: 'queued',
        restartReason: 'server_completed',
      });
      detach();
      test.server.autoReady = true;
      const relaunched = test.restart();
      cleanup.push(() => relaunched.dispose());
      relaunched.setKnownOwners([OWNER]);
      cleanup.push(relaunched.attach());
      await settle(20);
      const calls = test.server.calls;
      const removed = calls.lastIndexOf('remove:srv-1');
      expect(removed).toBeGreaterThan(-1);
      expect(prepared(test, FIRST)).toBe(2);
      expect(removed).toBeLessThan(calls.lastIndexOf(`prepare:${FIRST}`));
      expect(relaunched.store.get(id)).toMatchObject({
        state: 'downloading',
        restartReason: null,
      });
      expect(relaunched.store.get(id)!.downloadId).not.toBe('srv-1');
    });
  });
});

/** DL-C-verify5 C5-01: the launch list is a snapshot; a newer Resume or Pause wins over it. */
describe('a stale launch snapshot never overwrites a newer intent (C5-01)', () => {
  it('a Resume while the launch list is read keeps the download running', async () => {
    const test = createTestDownloads();
    cleanup.push(test.manager.attach());
    const [download] = await test.manager.start(OWNER, [
      { workId: 'tmdb-movie-603', releaseId: 'r' },
    ]);
    await settle();
    const id = download!.id;
    await test.manager.pause(id);
    const listed = await test.engine.list();
    const pending = deferred<typeof listed>();
    jest.spyOn(test.engine, 'list').mockImplementationOnce(() => pending.promise);
    const reconciling = test.manager.reconcile();
    await test.manager.resume(id);
    expect(test.store.get(id)!.state).toBe('downloading');
    pending.resolve(listed);
    await reconciling;
    await settle();
    expect((await test.engine.get(id))!.state).toBe('running');
    expect(test.store.get(id)!.state).toBe('downloading');
  });

  it('a Pause while the launch list is read keeps the download paused, its task too', async () => {
    const test = createTestDownloads();
    cleanup.push(test.manager.attach());
    const [download] = await test.manager.start(OWNER, [
      { workId: 'tmdb-movie-603', releaseId: 'r' },
    ]);
    await settle();
    const id = download!.id;
    const listed = await test.engine.list();
    const pending = deferred<typeof listed>();
    jest.spyOn(test.engine, 'list').mockImplementationOnce(() => pending.promise);
    const reconciling = test.manager.reconcile();
    await test.manager.pause(id);
    pending.resolve(listed);
    await reconciling;
    await settle();
    expect(test.store.get(id)!.state).toBe('paused');
    expect((await test.engine.get(id))!.state).toBe('paused');
  });
});

/** DL-C-verify6 C6-01: a restart asked for while another run waits for its DELETE runs after it, unless a newer intent came. */
describe('a Resume while a restart waits for its DELETE (C6-01)', () => {
  type Test = ReturnType<typeof createTestDownloads>;
  const prepares = (test: Test) =>
    test.server.calls.filter((call) => call === 'prepare:tmdb-movie-603').length;
  /** The next server DELETE waits until released. */
  function holdRemove(test: Test) {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const remove = test.server.remove.bind(test.server);
    jest.spyOn(test.server, 'remove').mockImplementationOnce(async (downloadId) => {
      entered.resolve();
      await gate.promise;
      return remove(downloadId);
    });
    return { entered: entered.promise, release: () => gate.resolve() };
  }
  /** A download whose file changed on the server: its restart waits for the old record's DELETE. */
  async function restarting() {
    const test = createTestDownloads();
    cleanup.push(test.manager.attach());
    test.manager.setKnownOwners([OWNER]);
    const [download] = await test.manager.start(OWNER, [
      { workId: 'tmdb-movie-603', releaseId: 'r' },
    ]);
    await settle();
    const deletion = holdRemove(test);
    test.engine.controls.fail(download!.id, 'validator_changed');
    await deletion.entered;
    expect(test.store.get(download!.id)!.restartReason).toBe('validator_changed');
    return { test, id: download!.id, deletion };
  }

  it('Pause, then Resume before the DELETE answers: after it exactly one fresh POST, no second Resume', async () => {
    const { test, id, deletion } = await restarting();
    await test.manager.pause(id);
    await test.manager.resume(id);
    expect(test.store.get(id)!.state).toBe('queued');
    expect(prepares(test)).toBe(1);
    deletion.release();
    await settle(20);
    expect(prepares(test)).toBe(2);
    expect(test.store.get(id)).toMatchObject({
      state: 'downloading',
      restartReason: null,
      bytesWritten: 0,
    });
    expect((await test.engine.get(id))!.state).toBe('running');
  });

  it('Pause, Resume, Pause before the DELETE answers: stays paused; the next Resume finishes it', async () => {
    const { test, id, deletion } = await restarting();
    await test.manager.pause(id);
    await test.manager.resume(id);
    await test.manager.pause(id);
    deletion.release();
    await settle(20);
    expect(prepares(test)).toBe(1);
    expect(test.store.get(id)).toMatchObject({
      state: 'paused',
      restartReason: 'validator_changed',
    });
    await test.manager.resume(id);
    await settle(20);
    expect(prepares(test)).toBe(2);
    expect(test.store.get(id)).toMatchObject({ state: 'downloading', restartReason: null });
  });

  it('a removal during the wait prepares nothing and leaves no record or task', async () => {
    const { test, id, deletion } = await restarting();
    await test.manager.pause(id);
    await test.manager.resume(id);
    const removed = test.manager.remove(id);
    deletion.release();
    await removed;
    await settle(20);
    expect(prepares(test)).toBe(1);
    expect(test.store.get(id)).toBeUndefined();
    expect(await test.engine.get(id)).toBeNull();
  });

  it('the same handover for a completed server record: Pause, Resume before its DELETE, one fresh POST', async () => {
    const test = createTestDownloads();
    test.server.autoReady = false;
    cleanup.push(test.manager.attach());
    const [download] = await test.manager.start(OWNER, [
      { workId: 'tmdb-movie-603', releaseId: 'r' },
    ]);
    const id = download!.id;
    await settle();
    const deletion = holdRemove(test);
    test.server.records.set('srv-1', {
      ...test.server.records.get('srv-1')!,
      state: 'completed',
    });
    await deletion.entered;
    await test.manager.pause(id);
    await test.manager.resume(id);
    test.server.autoReady = true;
    deletion.release();
    await settle(20);
    expect(prepares(test)).toBe(2);
    expect(test.store.get(id)).toMatchObject({
      state: 'downloading',
      restartReason: null,
      error: null,
    });
    expect(test.store.get(id)!.downloadId).not.toBe('srv-1');
  });
});
