import type { EngineEvent } from '@/player/engines';
import { loadHls, WebEngine } from '@/player/engines/web-engine.web';
import { FakeHls, FakeVideoElement } from '@/../jest/player/library-fakes';

jest.mock('hls.js', () => jest.requireActual('@/../jest/player/library-fakes').hlsJsModule());

const engines: WebEngine[] = [];
afterEach(() => {
  engines.splice(0).forEach((engine) => engine.release());
  delete (globalThis as { document?: unknown }).document;
});

async function engineOn(kind: 'hls' | 'progressive', mode: 'hls.js' | 'native' = 'hls.js') {
  const engine = new WebEngine();
  engines.push(engine);
  if (mode === 'native') Object.defineProperty(engine, 'mode', { value: 'native' });
  const video = new FakeVideoElement();
  (engine as unknown as { attach(video: unknown): void }).attach(video);
  await loadHls();
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  engine.load({ uri: `http://server.test/a.${kind === 'hls' ? 'm3u8' : 'mkv'}`, kind });
  return { engine, video, events };
}

/** A canvas whose pixels are all `value`, or one that throws like a tainted canvas. */
function fakeCanvas(value: number | 'tainted') {
  const drawImage = jest.fn();
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({
      canPlayType: () => '',
      getContext: () => ({
        drawImage,
        getImageData: () => {
          if (value === 'tainted')
            throw Object.assign(new Error('tainted'), { name: 'SecurityError' });
          return { data: new Uint8ClampedArray(16 * 9 * 4).fill(value) };
        },
      }),
    }),
  };
  return drawImage;
}

describe('web health probe (state-matrix § 2 a, S5)', () => {
  it('hls.js (MSE): frames, drops, decoded audio bytes, bandwidth and the engine clock', async () => {
    const { engine, video } = await engineOn('hls');
    video.present(48);
    video.droppedFrames = 2;
    video.webkitAudioDecodedByteCount = 4096;
    video.currentTime = 12;
    FakeHls.last.bandwidthEstimate = 8_000_000;
    await engine.readHealth();
    video.webkitAudioDecodedByteCount = 8192;
    expect(await engine.readHealth()).toMatchObject({
      framesPresented: 48,
      framesDropped: 2,
      audioProgress: 8192,
      hasVideoTrack: true,
      bandwidthBps: 8_000_000,
      nativePosition: 12,
    });
  });

  it('hls.js uses a 30 s time to first byte with two timeout retries (C08)', async () => {
    await engineOn('hls');
    const policy = (FakeHls.last.config as { fragLoadPolicy: { default: Record<string, unknown> } })
      .fragLoadPolicy.default;
    expect(policy).toMatchObject({
      maxTimeToFirstByteMs: 30_000,
      timeoutRetry: { maxNumRetry: 2 },
    });
  });

  it('samples the brightest pixel only for MSE data (CORS-checked), never a plain cross-origin src', async () => {
    const hls = await engineOn('hls');
    const draw = fakeCanvas(0);
    expect((await hls.engine.readHealth()).luma).toBe(0);
    const progressive = await engineOn('progressive');
    expect((await progressive.engine.readHealth()).luma).toBeUndefined();
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('samples the picture only while frames stand and only in the first minute after the load (review R11)', async () => {
    const { engine, video } = await engineOn('hls');
    const draw = fakeCanvas(0);
    await engine.readHealth();
    video.present(24);
    expect((await engine.readHealth()).luma).toBeUndefined();
    expect((await engine.readHealth()).luma).toBe(0);
    video.currentTime = 61;
    expect((await engine.readHealth()).luma).toBeUndefined();
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('counter proof belongs to the source: a new load trusts nothing until it moves again (review R2)', async () => {
    const { engine, video } = await engineOn('progressive', 'native');
    video.present(10);
    await engine.readHealth();
    video.present(10);
    expect((await engine.readHealth()).framesPresented).toBeDefined();
    video.webkitAudioDecodedByteCount = 100;
    await engine.readHealth();
    video.webkitAudioDecodedByteCount = 200;
    expect((await engine.readHealth()).audioProgress).toBe(200);
    engine.load({ uri: 'http://server.test/t/master.m3u8', kind: 'hls' });
    const fresh = await engine.readHealth();
    expect(fresh.framesPresented).toBeUndefined();
    expect(fresh.audioProgress).toBeUndefined();
  });

  it('a tainted canvas stops luminance sampling for good', async () => {
    const { engine } = await engineOn('hls');
    fakeCanvas('tainted');
    expect((await engine.readHealth()).luma).toBeUndefined();
    const draw = fakeCanvas(200);
    expect((await engine.readHealth()).luma).toBeUndefined();
    expect(draw).not.toHaveBeenCalled();
  });

  it('an audio byte counter that never moved says nothing (no silence verdict from a dead counter)', async () => {
    const { engine, video } = await engineOn('hls');
    video.webkitAudioDecodedByteCount = 0;
    expect((await engine.readHealth()).audioProgress).toBeUndefined();
    expect((await engine.readHealth()).audioProgress).toBeUndefined();
    video.webkitAudioDecodedByteCount = 512;
    expect((await engine.readHealth()).audioProgress).toBe(512);
  });

  it('Safari native HLS: frame counters count only once they were seen moving', async () => {
    const { engine, video } = await engineOn('hls', 'native');
    expect((await engine.readHealth()).framesPresented).toBeUndefined();
    expect((await engine.readHealth()).framesPresented).toBeUndefined();
    video.present(10);
    expect((await engine.readHealth()).framesPresented).toBe(10);
  });

  it('passes the HTTP status of a fatal hls.js load error (C10, D01)', async () => {
    const { events } = await engineOn('hls');
    FakeHls.last.error('networkError', 'levelLoadError', { status: 404 });
    expect(events).toContainEqual({
      type: 'error',
      reason: 'networkError:levelLoadError',
      status: 404,
    });
  });

  it('a non-fatal buffer stall after the first frame shows as buffering (D04)', async () => {
    const { video, events } = await engineOn('hls');
    FakeHls.last.error('mediaError', 'bufferStalledError', { fatal: false });
    expect(events).not.toContainEqual({ type: 'buffering', buffering: true });
    video.present();
    FakeHls.last.error('mediaError', 'bufferStalledError', { fatal: false });
    expect(events).toContainEqual({ type: 'buffering', buffering: true });
  });
});

describe('hls.js load failures and fetch timing (S9a, S4d)', () => {
  const fragLoaded = (
    hls: FakeHls,
    type: string,
    loading = { start: 1000, first: 1100, end: 1600 }
  ) => hls.trigger('hlsFragLoaded', { frag: { type, stats: { loading, loaded: 500_000 } } });

  it('reads the last video segment: server wait before the first byte, transfer after it (C08)', async () => {
    const { engine } = await engineOn('hls');
    fragLoaded(FakeHls.last, 'main', { start: 0, first: 5_400, end: 5_700 });
    expect((await engine.readHealth()).fetch).toEqual({
      waitMs: 5_400,
      transferMs: 300,
      bytes: 500_000,
    });
  });

  it('an audio fragment failing while video still loads is an audio failure, not the network (S9a D36)', async () => {
    const { events } = await engineOn('hls');
    const hls = FakeHls.last;
    fragLoaded(hls, 'main');
    hls.error('networkError', 'fragLoadError', {
      fatal: false,
      status: 0,
      frag: { type: 'audio' },
    });
    expect(events).toContainEqual({ type: 'loadRetry', status: 0, audio: true });
    hls.error('networkError', 'fragLoadError', { fatal: true, status: 0, frag: { type: 'audio' } });
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', reason: 'audioRendition:fragLoadError', status: 0 },
    ]);
  });

  it('without video arriving it stays a network failure', async () => {
    const { events } = await engineOn('hls');
    FakeHls.last.error('networkError', 'fragLoadError', {
      fatal: true,
      status: 0,
      frag: { type: 'audio' },
    });
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', reason: 'networkError:fragLoadError', status: 0 },
    ]);
  });

  it('a non-fatal 503 is forwarded with its status at once (S9a C10)', async () => {
    const { events } = await engineOn('hls');
    FakeHls.last.error('networkError', 'fragLoadError', { fatal: false, status: 503 });
    expect(events).toContainEqual({ type: 'loadRetry', status: 503, audio: false });
  });
});
