import corpus from '@modules/offline-downloads/test-vectors/http-policy.json';

import { createFakeDownloadEngine } from '../fake';
import { RESERVE_BYTES } from '../http-policy';
import type { DownloadStateEvent } from '../types';

// Native semantics the fake must follow (DL-N fix round 1, N1-11); the retry corpus also runs in JUnit and Swift.
const MB = 1024 * 1024;
const GB = 1024 * MB;
const spec = (id: string, expectedBytes = 1000, relativePath = `acc/${id}.mkv`) => ({
  id,
  url: `https://server/offline/${id}`,
  relativePath,
  expectedBytes,
});

type Step = {
  at: number;
  status?: number;
  retryAfter?: string;
  network?: boolean;
  invalid206?: boolean;
  progressBytes: number;
  expect: {
    action: string;
    attempts: number;
    retryAt: number | null;
    httpStatus?: number;
    retryAfterMs?: number | null;
  };
};

describe('fake engine conformance', () => {
  it.each(corpus.retrySequences.map((sequence) => [sequence.name, sequence]))(
    'retry corpus: %s',
    async (_name, sequence) => {
      let clock = 0;
      const engine = createFakeDownloadEngine({ now: () => clock });
      await engine.start(spec('a', 100 * MB));
      for (const step of sequence.steps as Step[]) {
        clock = step.at;
        engine.controls.tick();
        const before = (await engine.get('a'))!;
        expect(before.state).toBe('running');
        if (step.progressBytes > 0) {
          engine.controls.progress('a', before.bytesWritten + step.progressBytes);
        }
        if (step.status !== undefined) {
          engine.controls.httpStatus('a', step.status, { retryAfter: step.retryAfter });
        } else {
          engine.controls.networkError('a');
        }
        const task = (await engine.get('a'))!;
        expect({
          at: step.at,
          state: task.state,
          attempts: task.attempts,
          retryAt: task.retryAt ?? null,
        }).toEqual({
          at: step.at,
          state: step.expect.action === 'retry' ? 'retrying' : 'failed',
          attempts: step.expect.attempts,
          retryAt: step.expect.retryAt,
        });
        if (step.expect.httpStatus !== undefined) {
          expect(task.error?.httpStatus).toBe(step.expect.httpStatus);
          expect(task.error?.retryAfterMs ?? null).toBe(step.expect.retryAfterMs ?? null);
        }
        if (step.expect.action === 'fail') {
          await engine.resume('a');
          clock += 1;
        }
      }
    }
  );

  it('restarts a retrying task once its deadline passed (injected clock)', async () => {
    let clock = 0;
    const engine = createFakeDownloadEngine({ now: () => clock });
    await engine.start(spec('a'));
    engine.controls.httpStatus('a', 503);
    expect(await engine.get('a')).toMatchObject({ state: 'retrying', retryAt: 2000, attempts: 1 });
    clock = 1999;
    engine.controls.tick();
    expect((await engine.get('a'))?.state).toBe('retrying');
    clock = 2000;
    engine.controls.tick();
    expect(await engine.get('a')).toMatchObject({ state: 'running', attempts: 1 });
  });

  it('restarts a retrying task on its own with timers', async () => {
    jest.useFakeTimers({ now: 10_000 });
    try {
      const engine = createFakeDownloadEngine();
      await engine.start(spec('a'));
      engine.controls.httpStatus('a', 429, { retryAfter: '5' });
      expect(await engine.get('a')).toMatchObject({ state: 'retrying', retryAt: 15_000 });
      jest.advanceTimersByTime(4_999);
      expect((await engine.get('a'))?.state).toBe('retrying');
      jest.advanceTimersByTime(1);
      expect((await engine.get('a'))?.state).toBe('running');
    } finally {
      jest.useRealTimers();
    }
  });

  it('never shortens a server cooldown when the network comes back', async () => {
    let clock = 0;
    const engine = createFakeDownloadEngine({ now: () => clock });
    await engine.start(spec('a'));
    engine.controls.httpStatus('a', 429, { retryAfter: '40' });
    engine.controls.setNetwork('none');
    expect(await engine.get('a')).toMatchObject({ state: 'waiting_network', retryAt: 40_000 });
    clock = 10_000;
    engine.controls.setNetwork('wifi');
    expect(await engine.get('a')).toMatchObject({ state: 'retrying', retryAt: 40_000 });
    clock = 40_000;
    engine.controls.tick();
    expect((await engine.get('a'))?.state).toBe('running');
  });

  it('keeps 64 MiB free besides the remaining bytes of running tasks', async () => {
    const engine = createFakeDownloadEngine({ storage: { freeBytes: GB + RESERVE_BYTES } });
    await engine.start(spec('fits', GB));
    expect((await engine.get('fits'))?.state).toBe('running');
    await engine.start(spec('second', MB));
    expect(await engine.get('second')).toMatchObject({
      state: 'failed',
      error: { kind: 'disk_full' },
    });

    const tight = createFakeDownloadEngine({ storage: { freeBytes: GB + RESERVE_BYTES - 1 } });
    await tight.start(spec('a', GB));
    expect(await tight.get('a')).toMatchObject({ state: 'failed', error: { kind: 'disk_full' } });
  });

  it('rejects unknown volumes and pauses work on a missing one', async () => {
    const engine = createFakeDownloadEngine();
    await expect(engine.start({ ...spec('a'), volumeId: 'volume-1A2B' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(engine.storage('volume-1A2B')).rejects.toMatchObject({ code: 'not_found' });
    const sd = {
      id: 'volume-1A2B',
      uri: 'file:///sd/',
      removable: true,
      freeBytes: 8 * GB,
      totalBytes: 16 * GB,
    };
    engine.controls.mountVolume(sd);
    await engine.start({ ...spec('a'), volumeId: sd.id });
    expect((await engine.get('a'))?.state).toBe('running');
    engine.controls.unmountVolume(sd.id);
    expect(await engine.get('a')).toMatchObject({
      state: 'failed',
      error: { kind: 'file_system', message: 'volume_unavailable' },
    });
    engine.controls.mountVolume(sd);
    expect(await engine.get('a')).toMatchObject({ state: 'running', error: undefined });
  });

  it('emits completed, then one final progress (native order)', async () => {
    const engine = createFakeDownloadEngine();
    const events: string[] = [];
    engine.addStateListener((event: DownloadStateEvent) => events.push(`state:${event.state}`));
    engine.addProgressListener((event) => events.push(`progress:${event.bytesWritten}`));
    await engine.start(spec('a'));
    engine.controls.complete('a');
    expect(events).toEqual(['state:queued', 'state:running', 'state:completed', 'progress:1000']);
  });

  it('gives storage back for every file a recursive delete removes', async () => {
    const engine = createFakeDownloadEngine({ storage: { freeBytes: 2 * GB } });
    await engine.start(spec('a', 8, 'dir/sub/a.mkv'));
    engine.controls.complete('a');
    await engine.remove('a');
    expect((await engine.storage()).freeBytes).toBe(2 * GB - 8);
    await engine.deletePath('dir');
    expect(await engine.exists('dir/sub/a.mkv')).toBe(false);
    expect((await engine.storage()).freeBytes).toBe(2 * GB);
  });

  it('replaces a file on move and refuses a directory target, at start and at publish too (N8-03, N9-02)', async () => {
    const engine = createFakeDownloadEngine();
    engine.controls.writeFile('a/src.bin', 3);
    engine.controls.writeFile('a/dst.bin', 9);
    await engine.move('a/src.bin', 'a/dst.bin');
    expect(await engine.fileSize('a/dst.bin')).toBe(3);
    expect(await engine.exists('a/src.bin')).toBe(false);
    engine.controls.writeFile('full/keep.txt', 4);
    await expect(engine.move('a/dst.bin', 'full')).rejects.toMatchObject({
      code: 'invalid_state',
      message: 'invalid_state: full is a directory',
    });
    expect(await engine.fileSize('full/keep.txt')).toBe(4);
    expect(await engine.fileSize('a/dst.bin')).toBe(3);
    await expect(engine.start(spec('d', 8, 'full'))).rejects.toMatchObject({
      code: 'invalid_state',
      message: 'invalid_state: path full is a directory',
    });
    engine.controls.writeFile('acc/clip.mkv.part/x', 1);
    await expect(engine.start(spec('p', 8, 'acc/clip.mkv'))).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(await engine.list()).toEqual([]);
    await engine.start(spec('a', 8, 'acc/a.mkv'));
    engine.controls.progress('a', 8);
    engine.controls.writeFile('acc/a.mkv/inside.txt', 2);
    engine.controls.complete('a');
    const failed = await engine.get('a');
    expect(failed).toMatchObject({
      state: 'failed',
      error: { kind: 'file_system', message: 'invalid_state: a.mkv is a directory' },
    });
    expect(failed?.retryAt ?? null).toBeNull();
    expect(await engine.fileSize('acc/a.mkv/inside.txt')).toBe(2);
    expect(await engine.fileSize('acc/a.mkv.part')).toBe(8);
  });

  it('owns a path for one task until cancel or remove', async () => {
    const engine = createFakeDownloadEngine();
    await engine.start(spec('a', 1000, 'acc/w/movie.mkv'));
    await expect(engine.start(spec('b', 1000, 'acc/w//./movie.mkv'))).rejects.toMatchObject({
      code: 'invalid_state',
      message: 'invalid_state: path acc/w/movie.mkv belongs to download a',
    });
    await expect(engine.deletePath('acc/w')).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(engine.deletePath('acc/w/movie.mkv.part')).rejects.toMatchObject({
      code: 'invalid_state',
    });
    await expect(engine.move('acc/w/movie.mkv.part', 'x.mkv')).rejects.toMatchObject({
      code: 'invalid_state',
    });
    engine.controls.complete('a');
    await expect(engine.start(spec('b', 1000, 'acc/w/movie.mkv'))).rejects.toMatchObject({
      code: 'invalid_state',
    });
    await engine.deletePath('acc/w/movie.mkv');
    await engine.remove('a');
    await engine.start(spec('b', 1000, 'acc/w/movie.mkv'));
    await engine.cancel('b');
    await engine.start(spec('c', 1000, 'acc/w/movie.mkv'));
    expect((await engine.get('c'))?.state).toBe('running');
  });

  it('keeps a cancelled tombstone after a cancel outside the app until remove (fix round 1c)', async () => {
    const engine = createFakeDownloadEngine();
    const events: DownloadStateEvent[] = [];
    engine.addStateListener((event) => events.push(event));
    await engine.start(spec('a', 1000, 'acc/w/movie.mkv'));
    engine.controls.progress('a', 400);
    engine.controls.userCancel('a');
    const tombstone = {
      id: 'a',
      url: 'https://server/offline/a',
      relativePath: 'acc/w/movie.mkv',
      volumeId: 'internal',
      state: 'cancelled',
      bytesWritten: 0,
    };
    expect(events.at(-1)).toMatchObject({ id: 'a', state: 'cancelled', task: tombstone });
    expect(events.at(-1)!.task.error).toBeUndefined();
    expect(await engine.list()).toEqual([expect.objectContaining(tombstone)]);
    expect((await engine.get('a'))!.error).toBeUndefined();
    expect(engine.controls.files()).toEqual({});
    // The same id comes back unchanged; another id may use the freed path.
    expect(await engine.start(spec('a', 1000, 'acc/w/movie.mkv'))).toMatchObject(tombstone);
    await engine.start(spec('b', 1000, 'acc/w/movie.mkv'));
    engine.controls.progress('b', 300);
    await engine.remove('a');
    await engine.remove('a');
    expect((await engine.list()).map((task) => task.id)).toEqual(['b']);
    expect(engine.controls.files()).toEqual({ 'internal:acc/w/movie.mkv.part': 300 });
  });

  it("forgets a tombstone on cancel without touching the path's new owner", async () => {
    const engine = createFakeDownloadEngine();
    await engine.start(spec('a', 1000, 'acc/w/movie.mkv'));
    engine.controls.userCancel('a');
    await engine.start(spec('b', 1000, 'acc/w/movie.mkv'));
    engine.controls.progress('b', 300);
    const events: DownloadStateEvent[] = [];
    engine.addStateListener((event) => events.push(event));
    await engine.cancel('a');
    expect(events).toEqual([]);
    expect(await engine.get('a')).toBeNull();
    expect(engine.controls.files()).toEqual({ 'internal:acc/w/movie.mkv.part': 300 });
  });

  it('keeps cancel(id) from the app forgetful, cancels paused tasks and rejects finished ones', async () => {
    const engine = createFakeDownloadEngine();
    await engine.start(spec('a'));
    await engine.cancel('a');
    expect(await engine.list()).toEqual([]);
    await engine.start(spec('b'));
    await engine.pause('b');
    engine.controls.userCancel('b');
    expect((await engine.get('b'))!.state).toBe('cancelled');
    engine.controls.userCancel('b');
    await engine.start(spec('c'));
    engine.controls.complete('c');
    expect(() => engine.controls.userCancel('c')).toThrow('invalid_state');
  });

  it('claims the final and the staging path, with ancestors and descendants (N2-01)', async () => {
    const engine = createFakeDownloadEngine();
    await expect(engine.start(spec('p', 1000, 'acc/w/movie.bin.PART'))).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    await engine.start(spec('a', 1000, 'acc/w/movie.bin'));
    for (const path of [
      'ACC/W/movie.bin',
      'acc/w/movie.bin.part/x',
      'acc/w/movie.bin/x',
      'acc',
      'acc/w',
    ]) {
      await expect(engine.start(spec(`b-${path}`, 1000, path))).rejects.toMatchObject({
        code: 'invalid_state',
      });
    }
    await engine.start(spec('c', 1000, 'acc/w/movie.bin2'));
    await expect(engine.deletePath('acc/w/movie.bin.part')).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });

  it('protects the paths of every unfinished task from move and deletePath, paused and failed too (N3-02)', async () => {
    const engine = createFakeDownloadEngine();
    await engine.start(spec('p', 1000, 'acc/p/movie.bin'));
    engine.controls.progress('p', 400);
    await engine.pause('p');
    await engine.start(spec('f', 1000, 'acc/f/movie.bin'));
    engine.controls.progress('f', 300);
    engine.controls.httpStatus('f', 403);
    expect((await engine.get('f'))!.state).toBe('failed');
    engine.controls.writeFile('foreign.bin', 4);
    for (const path of ['acc/p/movie.bin.part', 'acc/f/movie.bin.part', 'acc/p', 'acc']) {
      await expect(engine.move('foreign.bin', path)).rejects.toMatchObject({
        code: 'invalid_state',
      });
      await expect(engine.deletePath(path)).rejects.toMatchObject({ code: 'invalid_state' });
    }
    expect(engine.controls.files()).toMatchObject({
      'internal:acc/p/movie.bin.part': 400,
      'internal:acc/f/movie.bin.part': 300,
    });
    // A completed file is the caller's; so is a tombstone's path.
    await engine.start(spec('c', 1000, 'acc/c/movie.bin'));
    engine.controls.complete('c');
    await engine.deletePath('acc/c/movie.bin');
    await engine.cancel('p');
    await engine.deletePath('acc/p');
  });

  it('rejects path segments ending in a dot or space and claims across such aliases (N3-03)', async () => {
    const engine = createFakeDownloadEngine();
    for (const path of [
      'acc/w/movie.bin.',
      'acc/w/movie.bin ',
      'acc./w/movie.bin',
      'acc /w/movie.bin',
    ]) {
      await expect(engine.start(spec('x', 1000, path))).rejects.toMatchObject({
        code: 'invalid_argument',
      });
    }
    await engine.start(spec('a', 1000, 'acc/w/movie.bin'));
    engine.controls.progress('a', 400);
    for (const alias of ['acc/w/movie.bin.part.', 'acc/w./movie.bin', 'ACC /w']) {
      await expect(engine.deletePath(alias)).rejects.toMatchObject({ code: 'invalid_state' });
    }
    expect(engine.controls.files()).toEqual({ 'internal:acc/w/movie.bin.part': 400 });
  });

  it('waits for the drain of a tombstone on cancel like remove does (N3-06)', async () => {
    const engine = createFakeDownloadEngine();
    await engine.start(spec('t', 1000, 'acc/w/movie.bin'));
    engine.controls.progress('t', 400);
    engine.controls.stallDrain('t');
    engine.controls.userCancel('t');
    await expect(engine.cancel('t')).rejects.toMatchObject({
      code: 'io',
      message: 'io: cancel_pending',
    });
    await expect(engine.start(spec('n', 1000, 'acc/w/movie.bin'))).rejects.toMatchObject({
      code: 'invalid_state',
    });
    engine.controls.releaseDrain('t');
    await engine.cancel('t');
    await engine.start(spec('n', 1000, 'acc/w/movie.bin'));
    expect(engine.controls.files()).toEqual({});
  });

  it('rejects cancel_pending while a transfer cannot end and resolves a retry once it did (N2-06)', async () => {
    const engine = createFakeDownloadEngine();
    await engine.start(spec('a', 1000, 'acc/w/movie.bin'));
    engine.controls.progress('a', 400);
    engine.controls.stallDrain('a');
    await expect(engine.cancel('a')).rejects.toMatchObject({
      code: 'io',
      message: 'io: cancel_pending',
    });
    expect(await engine.get('a')).toBeNull();
    expect(engine.controls.files()).toEqual({ 'internal:acc/w/movie.bin.part': 400 });
    await expect(engine.start(spec('b', 1000, 'acc/w/movie.bin'))).rejects.toMatchObject({
      code: 'invalid_state',
    });
    await expect(engine.cancel('a')).rejects.toMatchObject({ message: 'io: cancel_pending' });
    engine.controls.releaseDrain('a');
    expect(engine.controls.files()).toEqual({});
    await engine.cancel('a');
    await expect(engine.cancel('a')).rejects.toMatchObject({ code: 'not_found' });
    await engine.start(spec('b', 1000, 'acc/w/movie.bin'));
  });

  it('keeps a failed task path claimed until its transfer ended; remove waits for it (N2-02)', async () => {
    const engine = createFakeDownloadEngine();
    await engine.start(spec('a', 1000, 'acc/w/movie.bin'));
    engine.controls.progress('a', 400);
    engine.controls.stallDrain('a');
    engine.controls.fail('a', 'file_system');
    await expect(engine.remove('a')).rejects.toMatchObject({
      code: 'io',
      message: 'io: remove_pending',
    });
    await expect(engine.start(spec('b', 1000, 'acc/w/movie.bin'))).rejects.toMatchObject({
      code: 'invalid_state',
    });
    engine.controls.releaseDrain('a');
    await engine.remove('a');
    expect(engine.controls.files()).toEqual({});
    await engine.start(spec('b', 1000, 'acc/w/movie.bin'));
  });

  it('removes the partial of a failed task with it', async () => {
    const engine = createFakeDownloadEngine();
    await engine.start(spec('a', 1000, 'acc/w/movie.bin'));
    engine.controls.progress('a', 400);
    engine.controls.fail('a', 'http');
    await engine.remove('a');
    expect(engine.controls.files()).toEqual({});
  });

  it('keeps deadlines on the monotonic clock when the wall clock jumps (N2-04)', async () => {
    let clock = 1_000;
    let wall = 1_793_995_200_000;
    const engine = createFakeDownloadEngine({ now: () => clock, wallNow: () => wall });
    await engine.start(spec('a'));
    engine.controls.httpStatus('a', 429, { retryAfterMs: 3_600_000 });
    expect((await engine.get('a'))!.retryAt).toBe(wall + 3_600_000);
    wall -= 24 * 3_600_000;
    clock += 3_599_000;
    engine.controls.tick();
    expect((await engine.get('a'))!.state).toBe('retrying');
    wall += 48 * 3_600_000;
    engine.controls.tick();
    expect((await engine.get('a'))!.state).toBe('retrying');
    clock += 1_000;
    engine.controls.tick();
    expect((await engine.get('a'))!.state).toBe('running');
  });

  it('accepts only allowlisted request headers', async () => {
    const engine = createFakeDownloadEngine();
    await expect(
      engine.start({ ...spec('a'), headers: { Authorization: 'Bearer x' } })
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    await engine.start({ ...spec('a'), headers: { 'Accept-Language': 'de' } });
    await expect(engine.resume('a', { headers: { Cookie: 'x' } })).rejects.toMatchObject({
      code: 'invalid_argument',
    });
  });

  it('fails after eight ordinary attempts without progress', async () => {
    let clock = 0;
    const engine = createFakeDownloadEngine({ now: () => clock });
    await engine.start(spec('a'));
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      engine.controls.networkError('a');
      const task = (await engine.get('a'))!;
      if (attempt < 8) {
        expect(task).toMatchObject({ state: 'retrying', attempts: attempt });
        clock = task.retryAt!;
        engine.controls.tick();
      } else {
        expect(task).toMatchObject({ state: 'failed', attempts: 8, error: { kind: 'network' } });
      }
    }
  });
});
