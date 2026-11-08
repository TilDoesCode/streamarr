import type { DeviceProfile } from '@modules/media-caps';

import type { ApiClient } from '@/api/client';
import type { EngineEvent, EngineKind, EngineSnapshot, PlayerEngine } from '@/player/engines';
import type { EngineSource } from '@/player/engines/types';
import type { Playback, StartRequest } from '@/player/playback-api';

import { deviceSettings } from '@/lib/storage';
import { storedCapabilityOverrides } from '@/player/capability-overrides';

import { OFFER_MS, PlaybackController, STREAMYBOX_SLOW_MS } from '../controller';

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

beforeEach(() => {
  jest.clearAllMocks();
  mockEngines.length = 0;
  mockState.available = true;
  mockState.failNextStreamybox = false;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('PlaybackController with the Streamybox Player: stutter is offered, never switched', () => {
  const profile8 = (id = 'p1') =>
    playback(
      {
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: [],
          subtitleTracks: [],
          video: { codec: 'hevc', hdr: 'dolbyvision', dolbyVisionProfile: 8, videoRange: 'PQ' },
        },
      } as unknown as Partial<Playback>,
      'dolbyvision',
      id
    );
  type Monitor = {
    stop(): void;
    finding: unknown;
    host: { changed(): void; escalate(verdict: string, resumeAt?: number): void };
  };
  const monitorOf = (c: PlaybackController) => (c as unknown as { monitor: Monitor }).monitor;
  /** The monitor's 37 % "can't keep up" hint, held while its own ticks stay out of the way. */
  const dropping = (c: PlaybackController, slideshow = true) => {
    const monitor = monitorOf(c);
    monitor.stop();
    if (slideshow) mockEngines.at(-1)!.emit({ type: 'firstFrame' });
    monitor.finding = slideshow
      ? { verdict: 'slideshow', level: 'hint', since: Date.now(), evidence: { percent: 37 } }
      : null;
    monitor.host.changed();
  };
  /** Fake time in one-second steps, like the monitor's own ticks. */
  const seconds = async (ms: number) => {
    for (let at = 0; at < ms; at += 1_000) await jest.advanceTimersByTimeAsync(1_000);
  };
  const started = async (answer = profile8()) => {
    mockApi.startPlayback
      .mockResolvedValueOnce(answer)
      .mockResolvedValueOnce(playback({}, 'dolbyvision', 'p2'));
    const c = controller(true);
    await c.start();
    expect(c.engine?.kind).toBe('streamybox');
    jest.useFakeTimers();
    return c;
  };
  const finish = async (c: PlaybackController) => {
    jest.useRealTimers();
    await c.stop();
  };

  beforeEach(() => deviceSettings.clearAll());
  afterEach(() => jest.useRealTimers());

  it('offers the built-in player after 20 s of drops and keeps playing meanwhile', async () => {
    const c = await started();
    dropping(c);
    await seconds(STREAMYBOX_SLOW_MS - 1_000);
    expect(c.offer).toBeNull();
    await seconds(2_000);
    expect(c.offer?.kind).toBe('builtInPlayer');
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(1);
    expect(c.engine?.kind).toBe('streamybox');
    expect(c.paused).toBe(false);
    await finish(c);
  });

  it('“Continue” moves this playback to the built-in player at its position, then asks to remember', async () => {
    const c = await started();
    dropping(c);
    await seconds(STREAMYBOX_SLOW_MS + 1_000);
    mockEngines[0]!.snapshot.position = 1264;
    c.acceptOffer();
    await seconds(1_000);
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(2);
    expect(sentHdr(1)).toEqual(['hdr10', 'hlg']);
    const request = mockApi.startPlayback.mock.calls[1]![1] as StartRequest;
    expect(request.startPositionTicks).toBe(1264 * TICKS);
    expect(c.engine?.kind).toBe('expo-video');
    // A choice, not a failure: no "couldn't play this" notice.
    expect(c.notice?.kind).not.toBe('dolbyVisionFallback');
    expect(c.offer?.kind).toBe('rememberBuiltInPlayer');
    c.acceptOffer();
    expect(c.offer).toBeNull();
    expect(storedCapabilityOverrides().dolbyVisionPlayer).toBe('off');
    await finish(c);
  });

  it('“Just this time” keeps the setting as it is', async () => {
    const c = await started();
    dropping(c);
    await seconds(STREAMYBOX_SLOW_MS + 1_000);
    c.acceptOffer();
    await seconds(1_000);
    c.declineOffer();
    expect(c.offer).toBeNull();
    expect(storedCapabilityOverrides().dolbyVisionPlayer).toBeUndefined();
    await finish(c);
  });

  it('“No” changes nothing and is not asked again in this playback', async () => {
    const c = await started();
    dropping(c);
    await seconds(STREAMYBOX_SLOW_MS + 1_000);
    c.declineOffer();
    expect(c.offer).toBeNull();
    dropping(c, false);
    dropping(c);
    await seconds(3 * STREAMYBOX_SLOW_MS);
    expect(c.offer).toBeNull();
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(1);
    expect(c.engine?.kind).toBe('streamybox');
    await finish(c);
  });

  it('goes away on its own after 15 s without switching', async () => {
    const c = await started();
    dropping(c);
    await seconds(STREAMYBOX_SLOW_MS + 1_000);
    expect(c.offer?.kind).toBe('builtInPlayer');
    await seconds(OFFER_MS);
    expect(c.offer).toBeNull();
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(1);
    await finish(c);
  });

  it('a slideshow at the ladder threshold is offered too, never switched (owner decision 2026-11-06)', async () => {
    const c = await started();
    mockEngines.at(-1)!.emit({ type: 'firstFrame' });
    monitorOf(c).stop();
    monitorOf(c).host.escalate('slideshow');
    await seconds(1_000);
    expect(c.offer?.kind).toBe('builtInPlayer');
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(1);
    expect(c.engine?.kind).toBe('streamybox');
    await finish(c);
  });

  it('offers it for Profile 5 as well: the viewer decides', async () => {
    const c = await started(playback());
    dropping(c);
    await seconds(STREAMYBOX_SLOW_MS + 1_000);
    expect(c.offer?.kind).toBe('builtInPlayer');
    await finish(c);
  });

  it('stays quiet when the drops end before the 20 s', async () => {
    const c = await started();
    dropping(c);
    await seconds(STREAMYBOX_SLOW_MS / 2);
    dropping(c, false);
    await seconds(STREAMYBOX_SLOW_MS * 2);
    expect(c.offer).toBeNull();
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(1);
    await finish(c);
  });

  it('a failing Streamybox Player still continues in the built-in player on its own', async () => {
    const c = await started();
    mockEngines.at(-1)!.emit({ type: 'error', reason: 'mpv: hwdec init failed' });
    await seconds(1_000);
    expect(mockApi.startPlayback).toHaveBeenCalledTimes(2);
    expect(c.engine?.kind).toBe('expo-video');
    expect(c.offer).toBeNull();
    await finish(c);
  });
});
