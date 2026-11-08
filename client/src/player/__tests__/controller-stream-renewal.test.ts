import type { DeviceProfile } from '@modules/media-caps';

import type { ApiClient } from '@/api/client';
import type { EngineEvent, EngineKind, EngineSnapshot, PlayerEngine } from '@/player/engines';
import type { EngineSource } from '@/player/engines/types';
import type { Playback, StartRequest } from '@/player/playback-api';

import { embeddedSubtitle, PlaybackController, STREAM_REFRESH_MS } from '../controller';

class MockEngine implements PlayerEngine {
  readonly Surface = () => null;
  snapshot = {
    state: 'playing',
    position: 0,
    duration: 0,
    buffered: 0,
    tracks: { audio: [], subtitles: [] },
    stats: {},
  } as unknown as EngineSnapshot;
  sources: EngineSource[] = [];
  failLoad = false;
  private listeners = new Set<(event: EngineEvent) => void>();
  constructor(readonly kind: EngineKind) {}
  load = jest.fn((source: EngineSource) => {
    if (this.failLoad) throw new Error('bind failed');
    this.sources.push(source);
  });
  play = jest.fn();
  pause = jest.fn();
  seek = jest.fn();
  setAudioTrack = jest.fn();
  setSubtitleTrack = jest.fn();
  shutdown = jest.fn(() => Promise.resolve());
  release = jest.fn();
  rewriteSource?: jest.Mock;
  subscribe(listener: (event: EngineEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  getSnapshot = () => this.snapshot;
  emit(event: EngineEvent) {
    for (const listener of [...this.listeners]) listener(event);
  }
}

const mockEngines: MockEngine[] = [];
const mockState = { available: true, failNextStreamybox: false };
jest.mock('@/player/engines', () => ({
  createEngine: (kind: EngineKind) => {
    const engine = new MockEngine(kind);
    if (kind === 'streamybox' && mockState.failNextStreamybox) engine.failLoad = true;
    mockEngines.push(engine);
    return engine;
  },
  streamyboxAvailable: () => mockState.available,
}));

const mockApi = {
  startPlayback: jest.fn(),
  switchPlayback: jest.fn(),
  stopPlayback: jest.fn((..._args: unknown[]) => Promise.resolve()),
};
jest.mock('@/player/playback-api', () => ({
  ...jest.requireActual('@/player/playback-api'),
  startPlayback: (...args: unknown[]) => mockApi.startPlayback(...args),
  switchPlayback: (...args: unknown[]) => mockApi.switchPlayback(...args),
  stopPlayback: (...args: unknown[]) => mockApi.stopPlayback(...args),
  waitForPlayback: (_client: unknown, playback: Playback) => Promise.resolve(playback),
}));

const TICKS = 10_000_000;

const profile: DeviceProfile = {
  platform: 'androidtv',
  engines: [
    {
      engine: 'native',
      containers: ['mp4', 'mkv'],
      videoCodecs: [
        { codec: 'h264', maxHeight: 2160, maxBitDepth: 8, hdrFormats: [] },
        { codec: 'hevc', maxHeight: 2160, maxBitDepth: 10, hdrFormats: ['hdr10', 'hlg'] },
      ],
      audioCodecs: [{ codec: 'aac', maxChannels: 8 }],
      subtitleFormats: ['srt'],
      hls: true,
      maxAudioChannels: 8,
    },
  ],
  vlcAvailable: false,
};

/** A direct play (SDR unless `hdr`); `over` changes how the server plans it. */
const playback = (over: Partial<Playback> = {}, hdr = 'dolbyvision', id = 'p1'): Playback =>
  ({
    playbackId: id,
    workId: 'w1',
    state: 'ready',
    revision: 0,
    method: 'direct',
    engine: 'native',
    url: `/stream/${id}`,
    version: { releaseId: 'r1' },
    mediaInfo: {
      durationTicks: 600 * TICKS,
      audioTracks: [],
      subtitleTracks: [],
      video: { codec: 'hevc', hdr, dolbyVisionProfile: hdr === 'dolbyvision' ? 5 : undefined },
    },
    ...over,
  }) as Playback;

const client = {
  POST: jest.fn(() =>
    Promise.resolve({
      data: undefined,
      response: { ok: true, status: 204, headers: new Headers() },
    })
  ),
} as unknown as ApiClient;

let account = 0;
function controller(dolbyVision: boolean | undefined) {
  account += 1;
  return new PlaybackController({
    client,
    accountId: `sbx${account}`,
    serverUrl: 'http://server',
    profile,
    nativeEngine: 'expo-video',
    workId: 'w1',
    startSeconds: 0,
    dolbyVision,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEngines.length = 0;
  mockState.available = true;
  mockState.failNextStreamybox = false;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('PlaybackController: a refused stream link is renewed silently (2026-11-06)', () => {
  const sdr = (id: string, over: Partial<Playback> = {}) => playback(over, 'none', id);
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  beforeEach(() => mockApi.startPlayback.mockReset());
  const playing = async (first: Playback = sdr('p1')) => {
    mockApi.startPlayback.mockResolvedValueOnce(first);
    const c = controller(false);
    await c.start();
    const engine = mockEngines.at(-1)!;
    engine.emit({ type: 'firstFrame' });
    engine.snapshot.position = 264;
    engine.emit({ type: 'time', position: 264, duration: 600 });
    const hints: string[] = [];
    c.subscribe(() => {
      const key = c.status.hint?.key;
      if (key && hints.at(-1) !== key) hints.push(key);
    });
    return { c, engine, hints };
  };

  it('ExoPlayer: a 404 on the stream gets a fresh link in place, no reload and no message', async () => {
    const { c, engine, hints } = await playing();
    engine.rewriteSource = jest.fn(() => true);
    mockApi.startPlayback.mockResolvedValueOnce(sdr('p2'));
    engine.emit({ type: 'loadRetry', status: 404 });
    engine.emit({ type: 'loadRetry', status: 404 });
    await flush();
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(2);
    const request = mockApi.startPlayback.mock.calls[1]![1] as StartRequest;
    expect(request.releaseId).toBe('r1');
    expect(request.startPositionTicks).toBe(264 * TICKS);
    expect(engine.rewriteSource).toHaveBeenCalledWith(
      'http://server/stream/p1',
      'http://server/stream/p2'
    );
    expect(engine.load).toHaveBeenCalledTimes(1);
    expect(mockApi.stopPlayback).toHaveBeenCalledWith(client, 'p1');
    expect(c.playback?.playbackId).toBe('p2');
    // Late retries of the replaced link change nothing.
    engine.emit({ type: 'loadRetry', status: 404 });
    await flush();
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(2);
    expect(hints).not.toContain('restarting');
    await c.stop();
  });

  it('an engine that stopped on the refused link (or cannot rewrite) reloads at the position', async () => {
    const { c, engine, hints } = await playing();
    mockApi.startPlayback.mockResolvedValueOnce(sdr('p2'));
    engine.emit({ type: 'error', reason: 'http 404', status: 404 });
    await flush();
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(2);
    expect(engine.load).toHaveBeenCalledTimes(2);
    expect(engine.sources[1]).toMatchObject({ uri: 'http://server/stream/p2', startPosition: 264 });
    expect(c.phase).toBe('playing');
    expect(c.failure).toBeNull();
    expect(hints).not.toContain('restarting');
    await c.stop();
  });

  it('a failed renewal falls back to the normal recovery (with its message)', async () => {
    const { c, engine, hints } = await playing();
    mockApi.startPlayback.mockRejectedValueOnce(new Error('network'));
    mockApi.startPlayback.mockResolvedValueOnce(sdr('p3'));
    engine.emit({ type: 'error', reason: 'http 404', status: 404 });
    await flush();
    expect(hints).toContain('restarting');
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(3);
    expect(c.playback?.playbackId).toBe('p3');
    await c.stop();
  });

  it('a renewal that does not answer in time falls back too', async () => {
    const { c, engine, hints } = await playing();
    mockApi.startPlayback.mockImplementationOnce(
      (_client: unknown, _request: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        )
    );
    mockApi.startPlayback.mockResolvedValue(sdr('p3'));
    jest.useFakeTimers();
    engine.emit({ type: 'loadRetry', status: 404 });
    await jest.advanceTimersByTimeAsync(STREAM_REFRESH_MS + 100);
    jest.useRealTimers();
    await flush();
    expect(hints).toContain('restarting');
    expect(mockApi.startPlayback.mock.calls.length).toBeGreaterThanOrEqual(3);
    await c.stop();
  });

  it('a fresh link refused again at once is no expiry: the normal recovery decides', async () => {
    const { c, engine, hints } = await playing();
    engine.rewriteSource = jest.fn(() => true);
    mockApi.startPlayback.mockResolvedValueOnce(sdr('p2'));
    engine.emit({ type: 'loadRetry', status: 404 });
    await flush();
    expect(c.playback?.playbackId).toBe('p2');
    expect(hints).not.toContain('restarting');
    mockApi.startPlayback.mockResolvedValue(sdr('p3'));
    engine.emit({ type: 'error', reason: 'http 404', status: 404 });
    await flush();
    expect(hints).toContain('restarting');
    await c.stop();
  });

  it('the Streamybox Player plays its cache out and ends early: a fresh link first, no reload of the dead one', async () => {
    mockState.available = true;
    mockApi.startPlayback.mockResolvedValueOnce(playback({}, 'dolbyvision', 'p1'));
    const c = controller(true);
    await c.start();
    const engine = mockEngines.at(-1)!;
    expect(engine.kind).toBe('streamybox');
    engine.emit({ type: 'firstFrame' });
    engine.snapshot.position = 264;
    engine.emit({ type: 'time', position: 264, duration: 600 });
    const hints: string[] = [];
    c.subscribe(() => {
      const key = c.status.hint?.key;
      if (key && hints.at(-1) !== key) hints.push(key);
    });
    mockApi.startPlayback.mockResolvedValueOnce(playback({}, 'dolbyvision', 'p2'));
    engine.emit({ type: 'ended' });
    await flush();
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(2);
    expect(engine.sources.map((source) => source.uri)).toEqual([
      'http://server/stream/p1',
      'http://server/stream/p2',
    ]);
    expect(engine.sources[1]).toMatchObject({ startPosition: 264 });
    expect(hints).toEqual([]);
    await c.stop();
  });

  it('the built-in engine keeps the early-end reload (only the Streamybox Player ends on a dead link)', async () => {
    const { c, engine } = await playing();
    engine.emit({ type: 'ended' });
    await flush();
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(1);
    expect(engine.sources[1]).toMatchObject({ uri: 'http://server/stream/p1' });
    await c.stop();
  });

  it('a converted playback (HLS) keeps the server-decides path', async () => {
    const { c, engine } = await playing(sdr('p1', { method: 'remux', url: '/hls/p1' }));
    engine.rewriteSource = jest.fn(() => true);
    engine.emit({ type: 'loadRetry', status: 404 });
    await flush();
    expect(engine.rewriteSource).not.toHaveBeenCalled();
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(1);
    await c.stop();
  });
});

/** REL-0.22: a renewal reload is a new source; the start it reloads at lands like any start (c89a7f34, C4-03, C5-02). */
describe('a renewal during an unlanded resume start keeps the start gate', () => {
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  beforeEach(() => mockApi.startPlayback.mockReset());
  const sentAbove = (seconds: number) =>
    (client.POST as jest.Mock).mock.calls
      .map(([, init]) => (init as { body?: { positionTicks?: number } } | undefined)?.body)
      .filter((body) => typeof body?.positionTicks === 'number')
      .map((body) => body!.positionTicks! / TICKS)
      .filter((at) => at > seconds);

  it.each([
    ['streamybox', true, 'dolbyvision'],
    ['expo-video', false, 'none'],
  ] as const)(
    '%s: a stale 400, then a refused link: the reload starts at the chosen 100 and only its own landing counts',
    async (kind, dolbyVision, hdr) => {
      account += 1;
      mockApi.startPlayback.mockResolvedValueOnce(playback({}, hdr, 'p1'));
      const c = new PlaybackController({
        client,
        accountId: `sbx${account}`,
        serverUrl: 'http://server',
        profile,
        nativeEngine: 'expo-video',
        workId: 'w1',
        startSeconds: 100,
        dolbyVision,
      });
      await c.start();
      const engine = mockEngines.at(-1)!;
      expect(engine.kind).toBe(kind);
      expect(engine.sources[0]).toMatchObject({ startPosition: 100 });
      engine.emit({ type: 'firstFrame' });
      engine.snapshot.position = 400;
      engine.emit({ type: 'time', position: 400, duration: 600 });
      expect(c.resumePosition).toBe(100);

      mockApi.startPlayback.mockResolvedValueOnce(playback({}, hdr, 'p2'));
      engine.emit({ type: 'error', reason: 'http 404', status: 404 });
      await flush();
      expect(mockApi.startPlayback).toHaveBeenCalledTimes(2);
      expect((mockApi.startPlayback.mock.calls[1]![1] as StartRequest).startPositionTicks).toBe(
        100 * TICKS
      );
      expect(engine.sources.at(-1)).toMatchObject({
        uri: 'http://server/stream/p2',
        startPosition: 100,
      });
      expect(c.failure).toBeNull();

      // The new source's echo of its start is no reading; the old clock is still no landing.
      engine.emit({ type: 'time', position: 100, duration: 600, observed: false });
      engine.emit({ type: 'time', position: 400, duration: 600 });
      expect(c.resumePosition).toBe(100);
      engine.snapshot.position = 100.5;
      engine.emit({ type: 'time', position: 100.5, duration: 600 });
      expect(c.resumePosition).toBe(100.5);
      await c.stop();
      expect(sentAbove(103)).toEqual([]);
    }
  );
});

describe('embeddedSubtitle: the file track a direct play shows from its load', () => {
  const tracks = [
    { index: 3, deliveredAs: 'embedded', forced: true, selected: true },
    { index: 4, deliveredAs: 'embedded', selected: false },
    { index: 5, deliveredAs: 'embedded', selected: false },
  ];
  const with_ = (over: Partial<Playback> = {}) =>
    playback(
      {
        mediaInfo: { durationTicks: 1, audioTracks: [], subtitleTracks: tracks } as never,
        ...over,
      },
      'none'
    );

  it('is the server pick (the forced German track = mpv sid 1), or the viewer choice on a reload', () => {
    expect(embeddedSubtitle(with_(), null)).toBe(1);
    expect(embeddedSubtitle(with_(), { audio: null, subtitle: 5 })).toBe(3);
    expect(embeddedSubtitle(with_(), { audio: null, subtitle: null })).toBe(0);
  });

  it('is none for a converted playback', () => {
    expect(embeddedSubtitle(with_({ method: 'remux' }), null)).toBe(0);
  });
});
