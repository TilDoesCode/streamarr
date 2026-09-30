import type { ApiClient } from '@/api/client';
import type { EngineEvent, EngineSnapshot, PlayerEngine } from '@/player/engines';
import type { Playback } from '@/player/playback-api';

import { PlaybackController } from '../controller';

class FakeEngine implements PlayerEngine {
  readonly kind = 'expo-video' as const;
  readonly Surface = () => null;
  snapshot: EngineSnapshot = {
    state: 'playing',
    position: 0,
    duration: 0,
    buffered: 0,
    tracks: { audio: [], subtitles: [] },
    stats: {},
  } as unknown as EngineSnapshot;
  sources: string[] = [];
  private listeners = new Set<(event: EngineEvent) => void>();
  load = jest.fn((source: { uri: string }) => void this.sources.push(source.uri));
  play = jest.fn();
  pause = jest.fn();
  seek = jest.fn((position: number) => void (this.snapshot.position = position));
  setAudioTrack = jest.fn();
  setSubtitleTrack = jest.fn();
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

const mockEngine = new FakeEngine();
jest.mock('@/player/engines', () => ({ createEngine: () => mockEngine }));

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
const ready = (over: Partial<Playback> = {}): Playback =>
  ({
    playbackId: 'p1',
    workId: 'w1',
    state: 'ready',
    revision: 0,
    method: 'direct',
    url: '/stream/p1',
    mediaInfo: { durationTicks: 600 * TICKS, audioTracks: [], subtitleTracks: [] },
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
function controller(startSeconds?: number) {
  account += 1;
  return new PlaybackController({
    client,
    accountId: `c${account}`,
    serverUrl: 'http://server',
    profile: {} as never,
    nativeEngine: 'expo-video',
    workId: 'w1',
    startSeconds,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEngine.sources = [];
  mockEngine.snapshot.position = 0;
  mockEngine.snapshot.duration = 0;
});

describe('PlaybackController', () => {
  it('asks resume vs start over when the server has a saved position', async () => {
    mockApi.startPlayback.mockResolvedValue(ready({ resumePositionTicks: 120 * TICKS }));
    const c = controller();
    const started = c.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(c.phase).toBe('resume');
    expect(c.resumeSeconds).toBe(120);
    c.chooseStart(true);
    await started;
    expect(c.phase).toBe('playing');
    expect(mockEngine.load).toHaveBeenCalledWith(expect.objectContaining({ startPosition: 120 }));
    await c.stop();
  });

  it('does not ask when the route passes an explicit start', async () => {
    mockApi.startPlayback.mockResolvedValue(ready({ resumePositionTicks: 120 * TICKS }));
    const c = controller(0);
    await c.start();
    expect(c.phase).toBe('playing');
    await c.stop();
  });

  it('steps down once per revision on an engine error and shows a notice', async () => {
    mockApi.startPlayback.mockResolvedValue(ready());
    mockApi.switchPlayback.mockResolvedValue(
      ready({ revision: 1, method: 'remux', url: '/hls/p1' })
    );
    const c = controller(0);
    await c.start();
    mockEngine.snapshot.position = 42;
    mockEngine.emit({ type: 'error', reason: 'decoder' });
    mockEngine.emit({ type: 'error', reason: 'decoder' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockApi.switchPlayback).toHaveBeenCalledTimes(1);
    expect(mockApi.switchPlayback.mock.calls[0][2]).toEqual({
      stepDown: true,
      subtitleStreamIndex: -1,
      positionTicks: 42 * TICKS,
    });
    expect(c.notice).toMatchObject({ kind: 'stepDown', params: { from: 'direct', to: 'remux' } });
    expect(c.playback?.revision).toBe(1);
    await c.stop();
  });

  it('keeps a client-side subtitle pick across a quality switch, not across a version switch', async () => {
    const subtitleTracks = [3, 4].map((index) => ({ index, deliveredAs: 'webvtt' }));
    mockApi.startPlayback.mockResolvedValue(
      ready({ mediaInfo: { durationTicks: 600 * TICKS, audioTracks: [], subtitleTracks } } as never)
    );
    mockApi.switchPlayback.mockResolvedValue(ready({ revision: 1 }));
    const c = controller(0);
    await c.start();
    mockEngine.snapshot.tracks = {
      audio: [],
      subtitles: [
        { id: 'a', label: 'de', selected: false },
        { id: 'b', label: 'en', selected: true },
      ],
    } as never;
    await c.setQuality(720);
    expect(mockApi.switchPlayback.mock.calls[0][2]).toMatchObject({ subtitleStreamIndex: 4 });
    await c.selectVersion('r2');
    expect(mockApi.switchPlayback.mock.calls[1][2]).not.toHaveProperty('subtitleStreamIndex');
    mockEngine.snapshot.tracks = { audio: [], subtitles: [] } as never;
    await c.stop();
  });

  it('ignores playToEnd that is not at the end (new source loading)', async () => {
    mockApi.startPlayback.mockResolvedValue(ready());
    const c = controller(0);
    await c.start();
    mockEngine.snapshot.duration = 600;
    mockEngine.snapshot.position = 3;
    mockEngine.emit({ type: 'ended' });
    expect(c.ended).toBe(false);
    mockEngine.snapshot.position = 599;
    mockEngine.emit({ type: 'ended' });
    expect(c.ended).toBe(true);
    await c.stop();
  });

  it('restores the previous playback when a user switch is refused', async () => {
    mockApi.startPlayback.mockResolvedValue(ready());
    const c = controller(0);
    await c.start();
    mockEngine.snapshot.position = 50;
    mockApi.switchPlayback.mockResolvedValue(
      ready({ state: 'failed', error: { code: 'transcoding_not_allowed' } as never })
    );
    mockApi.startPlayback.mockResolvedValue(ready({ playbackId: 'p2', url: '/stream/p2' }));
    const ok = await c.setQuality(480);
    expect(ok).toBe(false);
    expect(mockApi.stopPlayback).toHaveBeenCalledWith(client, 'p1');
    expect(mockApi.startPlayback).toHaveBeenLastCalledWith(
      client,
      expect.objectContaining({ startPositionTicks: 50 * TICKS, preferences: { engine: 'auto' } }),
      expect.anything()
    );
    expect(c.preferences).toEqual({ engine: 'auto' });
    expect(c.playback?.playbackId).toBe('p2');
    expect(c.notice).toMatchObject({
      kind: 'switchFailed',
      params: { code: 'transcoding_not_allowed' },
    });
    await c.stop();
  });
});
