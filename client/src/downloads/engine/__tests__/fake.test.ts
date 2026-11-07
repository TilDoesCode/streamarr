import { createFakeDownloadEngine } from '../fake';
import type { DownloadStateEvent } from '../types';

const spec = (id: string, expectedBytes = 1000) => ({
  id,
  url: `http://server/dl/${id}`,
  relativePath: `acc/${id}.mkv`,
  expectedBytes,
});

describe('fake download engine', () => {
  it('queues beyond maxConcurrent and starts the next one when a slot frees', async () => {
    const engine = createFakeDownloadEngine({ settings: { maxConcurrent: 2 } });
    await engine.start(spec('a'));
    await engine.start(spec('b'));
    await engine.start(spec('c'));
    expect(engine.controls.tasks().map((task) => task.state)).toEqual([
      'running',
      'running',
      'queued',
    ]);

    engine.controls.complete('a');
    expect((await engine.get('a'))?.state).toBe('completed');
    expect((await engine.get('c'))?.state).toBe('running');
    expect(await engine.fileSize('acc/a.mkv')).toBe(1000);
  });

  it('returns an existing task unchanged for a known id', async () => {
    const engine = createFakeDownloadEngine();
    const first = await engine.start(spec('a'));
    const again = await engine.start({ ...spec('a'), url: 'http://other/x' });
    expect(again.url).toBe(first.url);
    expect(engine.controls.calls).toEqual(['start:a', 'start:a']);
  });

  it('emits progress and state events', async () => {
    const engine = createFakeDownloadEngine();
    const states: DownloadStateEvent['state'][] = [];
    const progress: number[] = [];
    engine.addStateListener((event) => states.push(event.state));
    const subscription = engine.addProgressListener((event) => progress.push(event.bytesWritten));
    await engine.start(spec('a'));
    engine.controls.progress('a', 400, { bytesPerSecond: 100 });
    subscription.remove();
    engine.controls.progress('a', 600);
    engine.controls.complete('a');
    expect(states).toEqual(['queued', 'running', 'completed']);
    expect(progress).toEqual([400]);
    expect(engine.controls.files()).toEqual({ 'internal:acc/a.mkv': 1000 });
  });

  it('waits for Wi-Fi on a metered network and continues on Wi-Fi', async () => {
    const engine = createFakeDownloadEngine({ network: 'metered' });
    await engine.start(spec('a'));
    expect((await engine.get('a'))?.state).toBe('waiting_wifi');
    await engine.setWifiOnly(false);
    expect((await engine.get('a'))?.state).toBe('running');
    await engine.setWifiOnly(true);
    expect((await engine.get('a'))?.state).toBe('waiting_wifi');
    engine.controls.setNetwork('none');
    expect((await engine.get('a'))?.state).toBe('waiting_network');
    engine.controls.setNetwork('wifi');
    expect((await engine.get('a'))?.state).toBe('running');
  });

  it('pauses, resumes, fails and retries', async () => {
    const engine = createFakeDownloadEngine();
    await engine.start(spec('a'));
    await engine.pause('a');
    expect((await engine.get('a'))?.state).toBe('paused');
    await engine.resume('a', { url: 'http://server/renewed' });
    expect(await engine.get('a')).toMatchObject({ state: 'running', url: 'http://server/renewed' });
    engine.controls.fail('a', { kind: 'http', message: 'gone', httpStatus: 410 });
    expect(await engine.get('a')).toMatchObject({ state: 'failed', error: { httpStatus: 410 } });
    await engine.resume('a');
    expect(await engine.get('a')).toMatchObject({ state: 'running', error: undefined });
  });

  it('fails with disk_full when the file does not fit', async () => {
    const engine = createFakeDownloadEngine({ storage: { freeBytes: 500 } });
    await engine.start(spec('a', 1000));
    expect((await engine.get('a'))?.error?.kind).toBe('disk_full');
  });

  it('cancel deletes the partial file and emits cancelled; remove refuses active tasks', async () => {
    const engine = createFakeDownloadEngine();
    const events: DownloadStateEvent[] = [];
    engine.addStateListener((event) => events.push(event));
    await engine.start(spec('a'));
    engine.controls.progress('a', 10);
    expect(engine.controls.files()).toEqual({ 'internal:acc/a.mkv.part': 10 });
    await expect(engine.remove('a')).rejects.toMatchObject({ code: 'invalid_state' });
    await engine.cancel('a');
    expect(events.at(-1)).toMatchObject({
      state: 'cancelled',
      task: { error: { kind: 'cancelled' } },
    });
    expect(engine.controls.files()).toEqual({});
    expect(await engine.list()).toEqual([]);
    await expect(engine.pause('a')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('has file helpers over seeded files', async () => {
    const engine = createFakeDownloadEngine();
    engine.controls.writeFile('acc/w1/movie.mkv', 42);
    engine.controls.writeFile('acc/w1/poster.jpg', 1);
    await engine.move('acc/w1/movie.mkv', 'acc/w1/final.mkv');
    expect(await engine.exists('acc/w1/final.mkv')).toBe(true);
    expect(await engine.sha256('acc/w1/final.mkv')).toMatch(/^[0-9a-f]{64}$/);
    await engine.deletePath('acc/w1');
    expect(engine.controls.files()).toEqual({});
    expect(engine.uriFor('acc/x.mkv')).toBe(
      'file:///data/user/0/dev.streamarr.app/files/downloads/acc/x.mkv'
    );
    expect(
      await engine.contentUriFor('acc/x.mkv', { grantPackage: 'dev.streamybox.player' })
    ).toMatch(/^content:\/\//);
  });

  it('treats response statuses like the native engine', async () => {
    const engine = createFakeDownloadEngine({ now: () => 1_000 });
    await engine.start(spec('expired'));
    await engine.start(spec('busy'));
    engine.controls.httpStatus('expired', 410);
    engine.controls.httpStatus('busy', 429, { retryAfterMs: 40_000 });
    expect(await engine.get('expired')).toMatchObject({
      state: 'failed',
      error: { kind: 'http', httpStatus: 410 },
    });
    expect(await engine.get('busy')).toMatchObject({
      state: 'retrying',
      retryAt: 41_000,
      attempts: 0,
      error: { kind: 'http', httpStatus: 429, retryAfterMs: 40_000 },
    });
    engine.controls.httpStatus('busy', 503);
    expect(await engine.get('busy')).toMatchObject({
      state: 'retrying',
      attempts: 1,
      retryAt: 3_000,
    });
  });

  it('deletes directories recursively', async () => {
    const engine = createFakeDownloadEngine();
    engine.controls.writeFile('acc/work/movie.mkv', 10);
    engine.controls.writeFile('acc/work/art/poster.jpg', 2);
    engine.controls.writeFile('acc/other.mkv', 3);
    await engine.deletePath('acc/work');
    expect(engine.controls.files()).toEqual({ 'internal:acc/other.mkv': 3 });
  });

  it('has a clock of its own: advanceElapsed and reboot move it, the wall and retry clocks never do (C2-07)', () => {
    let monotonic = 1_000;
    let wall = 1_700_000_000_000;
    const engine = createFakeDownloadEngine({
      now: () => monotonic,
      wallNow: () => wall,
      elapsedMs: 500,
    });
    expect(engine.clock()).toEqual({ elapsedMs: 500, bootId: 'fake-boot-1' });
    monotonic += 60_000;
    wall -= 3_600_000;
    expect(engine.clock()).toEqual({ elapsedMs: 500, bootId: 'fake-boot-1' });
    engine.controls.advanceElapsed(90_000);
    expect(engine.clock()).toEqual({ elapsedMs: 90_500, bootId: 'fake-boot-1' });
    engine.controls.reboot();
    expect(engine.clock()).toEqual({ elapsedMs: 0, bootId: 'fake-boot-2' });
    engine.controls.advanceElapsed(10);
    engine.controls.reboot();
    expect(engine.clock()).toEqual({ elapsedMs: 0, bootId: 'fake-boot-3' });
  });

  it('runs its clock in real time when no clock is injected (dev mock)', () => {
    const engine = createFakeDownloadEngine({ bootId: 'mock' });
    const first = engine.clock();
    const second = engine.clock();
    expect(second.bootId).toBe('mock');
    expect(second.elapsedMs).toBeGreaterThanOrEqual(first.elapsedMs);
  });
});
