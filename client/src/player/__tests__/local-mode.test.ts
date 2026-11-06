import type { ApiClient } from '@/api/client';
import type { EngineEvent, EngineKind, EngineSnapshot, PlayerEngine } from '@/player/engines';

import { PlaybackController } from '../controller';
import type { LocalSource } from '../controller-types';
import { pendingProgress } from '../progress-queue';

class MockFakeEngine implements PlayerEngine {
  constructor(readonly kind: EngineKind) {}
  readonly Surface = () => null;
  snapshot = {
    state: 'playing',
    position: 0,
    duration: 0,
    buffered: 0,
    tracks: {
      audio: [
        { id: 'a0', label: 'Deutsch', language: 'de', selected: true },
        { id: 'a1', label: 'English', language: 'en', selected: false },
      ],
      subtitles: [{ id: 's0', label: 'Deutsch', language: 'de', selected: false }],
    },
    stats: {},
  } as unknown as EngineSnapshot;
  sources: string[] = [];
  private listeners = new Set<(event: EngineEvent) => void>();
  load = jest.fn((source: { uri: string }) => void this.sources.push(source.uri));
  play = jest.fn();
  pause = jest.fn();
  seek = jest.fn();
  setAudioTrack = jest.fn();
  setSubtitleTrack = jest.fn();
  release = jest.fn();
  subscribe(listener: (event: EngineEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  getSnapshot = () => this.snapshot;
}

const mockEngines: MockFakeEngine[] = [];
const mockVlc = { available: true };
jest.mock('@/player/engines', () => ({
  createEngine: (kind: EngineKind) => {
    const engine = new MockFakeEngine(kind);
    mockEngines.push(engine);
    return engine;
  },
  streamyboxAvailable: () => false,
  vlcAvailable: () => mockVlc.available,
}));

const mockApi = {
  startPlayback: jest.fn(),
  stopPlayback: jest.fn((..._args: unknown[]) => Promise.resolve()),
  getPlayback: jest.fn(),
};
jest.mock('@/player/playback-api', () => ({
  ...jest.requireActual('@/player/playback-api'),
  startPlayback: (...args: unknown[]) => mockApi.startPlayback(...args),
  stopPlayback: (...args: unknown[]) => mockApi.stopPlayback(...args),
  getPlayback: (...args: unknown[]) => mockApi.getPlayback(...args),
}));

const TICKS = 10_000_000;
const sent: { body: Record<string, unknown> }[] = [];
const online = { value: true };
const client = {
  POST: jest.fn((_path: string, init: { body: Record<string, unknown> }) => {
    if (!online.value) return Promise.reject(new TypeError('Network request failed'));
    sent.push(init);
    return Promise.resolve({
      data: undefined,
      response: { ok: true, status: 204, headers: new Headers() },
    });
  }),
} as unknown as ApiClient;

function source(patch: Partial<LocalSource> = {}): LocalSource {
  return {
    downloadId: 'd1',
    uri: 'file:///data/downloads/a1/d1/Movie.mkv',
    engine: 'native',
    releaseId: 'rel-1',
    version: null,
    resumeSeconds: 0,
    mediaInfo: {
      container: 'mkv',
      durationTicks: 600 * TICKS,
      audioTracks: [
        {
          index: 1,
          codec: 'aac',
          channels: 2,
          language: 'de',
          deliveredAs: 'original',
          selected: true,
        },
        {
          index: 2,
          codec: 'aac',
          channels: 2,
          language: 'en',
          deliveredAs: 'original',
          selected: false,
        },
      ],
      subtitleTracks: [
        { index: 3, codec: 'srt', language: 'de', deliveredAs: 'embedded', selected: false },
        { index: 4, codec: 'pgs', language: 'en', deliveredAs: 'none', selected: false },
      ],
    },
    offline: () => !online.value,
    ...patch,
  };
}

let account = 0;
function controller(local: LocalSource, options: { startSeconds?: number } = {}) {
  account += 1;
  const positions: number[] = [];
  const player = new PlaybackController({
    client,
    accountId: `local${account}`,
    serverUrl: 'http://server',
    profile: {} as never,
    nativeEngine: 'expo-video',
    workId: 'tmdb-movie-603',
    startSeconds: options.startSeconds,
    local,
    onPosition: (seconds) => positions.push(seconds),
  });
  return { player, positions };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEngines.length = 0;
  sent.length = 0;
  online.value = true;
  mockVlc.available = true;
});

describe('player local mode (DL)', () => {
  it('plays the file with the saved native engine and never asks the server', async () => {
    const { player } = controller(source(), { startSeconds: 0 });
    await player.start();
    expect(player.isLocal).toBe(true);
    expect(mockApi.startPlayback).not.toHaveBeenCalled();
    expect(mockEngines).toHaveLength(1);
    expect(mockEngines[0]!.kind).toBe('expo-video');
    expect(mockEngines[0]!.sources).toEqual(['file:///data/downloads/a1/d1/Movie.mkv']);
    expect(player.playback?.method).toBe('direct');
    await player.stop();
    expect(mockApi.stopPlayback).not.toHaveBeenCalled();
  });

  it('plays a VLC download in VLC', async () => {
    const { player } = controller(source({ engine: 'vlc' }), { startSeconds: 0 });
    await player.start();
    expect(mockEngines[0]!.kind).toBe('vlc');
    await player.stop();
  });

  it('offers only the subtitles the file itself carries and switches tracks in the engine', async () => {
    const { player } = controller(source(), { startSeconds: 0 });
    await player.start();
    const info = player.playback!.mediaInfo!;
    expect(info.subtitleTracks!.map((track) => track.index)).toEqual([3]);
    await player.selectAudio(info.audioTracks![1]!);
    expect(mockEngines[0]!.setAudioTrack).toHaveBeenCalledWith('a1');
    expect(mockApi.startPlayback).not.toHaveBeenCalled();
    expect(await player.setQuality(720)).toBe(false);
    await player.stop();
  });

  it('asks resume vs start over with the saved position', async () => {
    const { player } = controller(source({ resumeSeconds: 120 }));
    const started = player.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(player.phase).toBe('resume');
    player.chooseStart(true);
    await started;
    expect(mockEngines[0]!.load).toHaveBeenCalledWith(
      expect.objectContaining({ startPosition: 120 })
    );
    await player.stop();
  });

  it('reports progress online and records the local position', async () => {
    const { player, positions } = controller(source(), { startSeconds: 30 });
    await player.start();
    await Promise.resolve();
    expect(sent.map((request) => request.body.event)).toEqual(['start']);
    expect(sent[0]!.body.workId).toBe('tmdb-movie-603');
    expect(String(sent[0]!.body.playbackId)).toMatch(/^local-d1-/);
    expect(positions).toEqual([30]);
    await player.stop();
  });

  it('queues progress offline with its real time instead of sending it', async () => {
    online.value = false;
    const { player } = controller(source(), { startSeconds: 0 });
    await player.start();
    await player.stop();
    expect(client.POST).not.toHaveBeenCalled();
    expect(pendingProgress(`local${account}`)).toBe(2);
  });

  it('switches engines locally from the engine menu', async () => {
    const { player } = controller(source(), { startSeconds: 0 });
    await player.start();
    expect(await player.setEnginePreference('vlc')).toBe(true);
    expect(mockEngines.map((engine) => engine.kind)).toEqual(['expo-video', 'vlc']);
    expect(mockEngines[1]!.sources).toEqual(['file:///data/downloads/a1/d1/Movie.mkv']);
    await player.stop();
  });

  it('offers no server-only action on its hints (no lower quality, no other version)', async () => {
    const { player } = controller(source(), { startSeconds: 0 });
    await player.start();
    Object.assign(player, {
      serverStatus: () => ({
        spinner: true,
        hint: { key: 'startSlow' },
        actions: ['lowerQuality', 'otherVersion', 'cancel'],
      }),
    });
    expect(player.status.actions).toEqual(['cancel']);
    await player.stop();
  });
});
