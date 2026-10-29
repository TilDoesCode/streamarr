import type { DeviceProfile } from '@modules/media-caps';

import type { ApiClient } from '@/api/client';
import type { EngineEvent, EngineKind, EngineSnapshot, PlayerEngine } from '@/player/engines';
import type { EngineSource } from '@/player/engines/types';
import type { Playback, StartRequest } from '@/player/playback-api';

import { PlaybackController } from '../controller';

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

/** A Dolby Vision Profile 5 file; `over` changes how the server plans it. */
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

/** The HEVC HDR formats of the n-th start request. */
const sentHdr = (call = 0) =>
  (mockApi.startPlayback.mock.calls[call]![1] as StartRequest).device!.engines[0]!.videoCodecs.find(
    (codec) => codec.codec === 'hevc'
  )!.hdrFormats;

/** The Streamybox Player's audio in the n-th start request (server field `dolbyVisionAudio`). */
const sentAudio = (call = 0) =>
  (mockApi.startPlayback.mock.calls[call]![1] as StartRequest).device!.engines[0]!.dolbyVisionAudio;

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  jest.clearAllMocks();
  mockEngines.length = 0;
  mockState.available = true;
  mockState.failNextStreamybox = false;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('PlaybackController with the Streamybox Player', () => {
  it('plays a Dolby Vision direct play in the Streamybox engine, asked with the DV profile', async () => {
    mockApi.startPlayback.mockResolvedValue(playback());
    const c = controller(true);
    await c.start();
    expect(sentHdr()).toEqual(['hdr10', 'hlg', 'dolbyvision']);
    expect(profile.engines[0]!.videoCodecs[1]!.hdrFormats).toEqual(['hdr10', 'hlg']);
    expect(sentAudio()?.audioCodecs.map((item) => item.codec)).toContain('truehd');
    expect(c.engine?.kind).toBe('streamybox');
    expect(mockEngines.map((engine) => engine.kind)).toEqual(['streamybox']);
    expect(mockEngines[0]!.sources[0]).toMatchObject({
      uri: 'http://server/stream/p1',
      kind: 'progressive',
    });
    expect(c.phase).toBe('playing');
    await c.stop();
  });

  it('plays other HDR in the built-in engine without a second start', async () => {
    mockApi.startPlayback.mockResolvedValue(playback({}, 'hdr10'));
    const c = controller(true);
    await c.start();
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(1);
    expect(c.engine?.kind).toBe('expo-video');
    await c.stop();
  });

  it.each(['remux', 'transcode'])(
    'plays a Dolby Vision %s in the built-in engine (the server sends no DV there)',
    async (method) => {
      mockApi.startPlayback.mockResolvedValue(playback({ method, url: '/hls/p1' }));
      const c = controller(true);
      await c.start();
      expect(c.engine?.kind).toBe('expo-video');
      expect(mockEngines[0]!.sources[0]!.kind).toBe('hls');
      await c.stop();
    }
  );

  it('keeps the server’s VLC choice', async () => {
    mockApi.startPlayback.mockResolvedValue(playback({ engine: 'vlc' }, 'dolbyvision'));
    const c = controller(true);
    await c.start();
    expect(c.engine?.kind).toBe('vlc');
    await c.stop();
  });

  it.each([
    ['the setting is off', false, true],
    ['no setting is passed', undefined, true],
    ['the render service is missing', true, false],
  ])('behaves exactly as before when %s', async (_name, dolbyVision, available) => {
    mockState.available = available;
    mockApi.startPlayback.mockResolvedValue(playback({}, 'dolbyvision'));
    const c = controller(dolbyVision);
    await c.start();
    expect(sentHdr()).toEqual(['hdr10', 'hlg']);
    expect(sentAudio()).toBeUndefined();
    expect(c.engine?.kind).toBe('expo-video');
    await c.stop();
  });

  it('falls back to a new start with the normal profile at the position when the engine fails', async () => {
    mockApi.startPlayback
      .mockResolvedValueOnce(playback())
      .mockResolvedValueOnce(
        playback({ method: 'transcode', url: '/hls/p2' }, 'dolbyvision', 'p2')
      );
    const c = controller(true);
    await c.start();
    const streamybox = mockEngines[0]!;
    streamybox.snapshot.position = 42;
    streamybox.emit({ type: 'error', reason: 'mpv: hwdec init failed' });
    await flush();
    expect(mockApi.stopPlayback).toHaveBeenCalledWith(client, 'p1');
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(2);
    expect(sentHdr(1)).toEqual(['hdr10', 'hlg']);
    expect(sentAudio(1)).toBeUndefined();
    const request = mockApi.startPlayback.mock.calls[1]![1] as StartRequest;
    expect(request.startPositionTicks).toBe(42 * TICKS);
    expect(request.releaseId).toBe('r1');
    expect(c.engine?.kind).toBe('expo-video');
    expect(c.engine).not.toBe(streamybox);
    expect(mockEngines[1]!.sources[0]).toMatchObject({ uri: 'http://server/hls/p2', kind: 'hls' });
    expect(c.notice?.kind).toBe('dolbyVisionFallback');
    expect(c.phase).toBe('playing');
    await c.stop();
  });

  it('falls back when the engine cannot even take the source (bind failed)', async () => {
    mockState.failNextStreamybox = true;
    mockApi.startPlayback
      .mockResolvedValueOnce(playback())
      .mockResolvedValueOnce(
        playback({ method: 'transcode', url: '/hls/p2' }, 'dolbyvision', 'p2')
      );
    const c = controller(true);
    await c.start();
    await flush();
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(2);
    expect(sentHdr(1)).toEqual(['hdr10', 'hlg']);
    expect(c.engine?.kind).toBe('expo-video');
    expect(c.phase).toBe('playing');
    await c.stop();
  });

  it('never gives the normal profile’s answer to the Streamybox engine after a fallback', async () => {
    mockApi.startPlayback
      .mockResolvedValueOnce(playback())
      .mockResolvedValueOnce(playback({}, 'dolbyvision', 'p2'))
      .mockResolvedValueOnce(playback({}, 'dolbyvision', 'p3'));
    const c = controller(true);
    await c.start();
    mockEngines[0]!.emit({ type: 'error', reason: 'mpv: decoder lost' });
    await flush();
    // A Profile 8 base layer the server plays direct with the normal profile: the built-in engine, as before.
    expect(c.engine?.kind).toBe('expo-video');
    mockEngines[1]!.emit({ type: 'error', reason: 'decoder' });
    await flush();
    expect(mockEngines.every((engine, index) => index === 0 || engine.kind !== 'streamybox')).toBe(
      true
    );
    await c.stop();
  });

  it('keeps Dolby Vision when the stream itself is gone (a new start, not a fallback)', async () => {
    mockApi.startPlayback
      .mockResolvedValueOnce(playback())
      .mockResolvedValueOnce(playback({}, 'dolbyvision', 'p2'));
    const c = controller(true);
    await c.start();
    mockEngines[0]!.emit({ type: 'error', reason: 'http', status: 403 });
    await flush();
    expect(c.notice?.kind).not.toBe('dolbyVisionFallback');
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(2);
    expect(sentHdr(1)).toContain('dolbyvision');
    expect(c.engine?.kind).toBe('streamybox');
    await c.stop();
  });
});
