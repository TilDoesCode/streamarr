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
});
