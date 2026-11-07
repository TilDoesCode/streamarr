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
