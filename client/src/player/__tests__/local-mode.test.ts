import type { ApiClient } from '@/api/client';
import type { EngineEvent, EngineKind, EngineSnapshot, PlayerEngine } from '@/player/engines';

import { PlaybackController } from '../controller';
import type { ControllerOptions, LocalSource } from '../controller-types';
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
  emit(event: EngineEvent) {
    for (const listener of this.listeners) listener(event);
  }
  /** The engine's clock moves (a `time` event) and its snapshot follows. */
  at(position: number) {
    this.snapshot = { ...this.snapshot, state: 'playing', position };
    this.emit({ type: 'time', position, duration: 600 });
  }
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
function controller(
  local: LocalSource,
  options: { startSeconds?: number; preferences?: ControllerOptions['preferences'] } = {}
) {
  account += 1;
  const positions: number[] = [];
  const restarts: boolean[] = [];
  const player = new PlaybackController({
    client,
    accountId: `local${account}`,
    serverUrl: 'http://server',
    profile: {} as never,
    nativeEngine: 'expo-video',
    workId: 'tmdb-movie-603',
    startSeconds: options.startSeconds,
    preferences: options.preferences,
    local,
    onPosition: (seconds, _duration, restarted) => {
      positions.push(seconds);
      restarts.push(restarted);
    },
  });
  return { player, positions, restarts };
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
    // Reported once the engine reached its start position (DL device pass).
    mockEngines[0]!.at(30);
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

const flush = async () => {
  for (let round = 0; round < 8; round += 1) await Promise.resolve();
};

/** The viewer answers the resume question with "Resume". */
async function resumed(seconds: number, patch: Partial<LocalSource> = {}) {
  const made = controller(source({ resumeSeconds: seconds, ...patch }));
  const started = made.player.start();
  await flush();
  made.player.chooseStart(true);
  await started;
  return made;
}

const events = () => sent.map((request) => request.body.event);
/** A failure a file on disk can have, in the shape an engine names a network break. */
const breakOff = (engine: MockFakeEngine) =>
  engine.emit({ type: 'error', reason: 'networkError:fragLoadError' });

describe('local playback on the device (DL final pass: resume, positions, engine, errors)', () => {
  afterEach(() => jest.useRealTimers());

  it('starts both engines at the saved position', async () => {
    for (const engine of ['native', 'vlc'] as const) {
      mockEngines.length = 0;
      const { player } = await resumed(120, { engine });
      expect(mockEngines[0]!.kind).toBe(engine === 'vlc' ? 'vlc' : 'expo-video');
      expect(mockEngines[0]!.load).toHaveBeenCalledWith(
        expect.objectContaining({ startPosition: 120 })
      );
      await player.stop();
    }
  });

  it('reports and saves nothing until the start target is reached', async () => {
    const { player, positions } = await resumed(100);
    const engine = mockEngines[0]!;
    // The engine's first reading comes before its start seek lands.
    engine.at(0);
    await flush();
    expect(events()).toEqual([]);
    expect(positions).toEqual([]);
    engine.at(100.4);
    await flush();
    expect(events()).toEqual(['start']);
    expect(Number(sent[0]!.body.positionTicks) / TICKS).toBeCloseTo(100.4, 1);
    expect(positions).toEqual([100.4]);
    await player.stop();
  });

  it('the observed sequence (resume, a reload before the target, stop) keeps the stored and reported positions', async () => {
    jest.useFakeTimers();
    const { player, positions } = await resumed(100);
    const engine = mockEngines[0]!;
    engine.at(0);
    engine.emit({ type: 'error', reason: 'ERROR_CODE_IO_UNSPECIFIED' });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(
      engine.load.mock.calls.map(([load]) => (load as { startPosition?: number }).startPosition)
    ).toEqual([100, 100]);
    engine.at(0);
    await player.stop();
    // Never reached the target: nothing is reported and the stored position stays where it was.
    expect(events()).toEqual([]);
    expect(positions).toEqual([]);
  });

  it('in the first 10 s a smaller position never overwrites the stored one', async () => {
    const { player, positions } = await resumed(100);
    const engine = mockEngines[0]!;
    engine.at(100.3);
    // A clock glitch right after the start, then the viewer leaves.
    engine.at(2);
    await player.stop();
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(100);
    for (const request of sent)
      expect(Number(request.body.positionTicks)).toBeGreaterThanOrEqual(100 * TICKS);
  });

  it('"From the start" and a seek are the viewer\'s own: smaller positions are saved', async () => {
    const { player, positions, restarts } = controller(source({ resumeSeconds: 100 }));
    const started = player.start();
    await flush();
    player.chooseStart(false);
    await started;
    mockEngines[0]!.at(3);
    await player.stop();
    expect(positions.at(-1)).toBeCloseTo(3, 0);
    expect(restarts.at(-1)).toBe(true);

    const again = await resumed(100);
    mockEngines.at(-1)!.at(100.2);
    await flush();
    expect(again.restarts).toEqual([false]);
    again.player.seekTo(20);
    mockEngines.at(-1)!.at(20.5);
    await again.player.stop();
    expect(again.positions.at(-1)).toBeCloseTo(20.5, 0);
    expect(again.restarts.at(-1)).toBe(true);
  });

  it('a native record starts natively, whatever engine was forced outside this playback', async () => {
    const { player } = controller(source(), {
      startSeconds: 0,
      preferences: { engine: 'vlc', forceEngine: true },
    });
    await player.start();
    expect(mockEngines[0]!.kind).toBe('expo-video');
    await player.stop();
  });

  it('a local failure is never a network one: two reloads with backoff, VLC once at the position, then a local card', async () => {
    jest.useFakeTimers();
    const { player } = await resumed(100);
    const native = mockEngines[0]!;
    native.at(100.5);
    breakOff(native);
    await jest.advanceTimersByTimeAsync(999);
    expect(native.load).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(native.load).toHaveBeenCalledTimes(2);
    breakOff(native);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(native.load).toHaveBeenCalledTimes(3);
    breakOff(native);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockEngines.map((engine) => engine.kind)).toEqual(['expo-video', 'vlc']);
    expect(mockEngines[1]!.load).toHaveBeenCalledWith(
      expect.objectContaining({ startPosition: 100.5 })
    );
    breakOff(mockEngines[1]!);
    await jest.advanceTimersByTimeAsync(0);
    expect(player.phase).toBe('failed');
    expect(player.failure?.category).not.toBe('T1');
    expect(player.failure?.code).not.toMatch(/network|timeout|interrupted|unreachable/);
    expect(mockApi.getPlayback).not.toHaveBeenCalled();
    expect(mockEngines).toHaveLength(2);
    await player.stop();
    // The fallback belongs to that playback: the next one starts with the record's engine again.
    const next = controller(source(), { startSeconds: 0 });
    await next.player.start();
    expect(mockEngines.at(-1)!.kind).toBe('expo-video');
    await next.player.stop();
  });

  it('a step that throws a network-shaped error still ends on a local card', async () => {
    jest.useFakeTimers();
    mockVlc.available = false;
    const { player } = await resumed(100);
    const native = mockEngines[0]!;
    native.at(100.5);
    native.load.mockImplementation(() => {
      throw new TypeError('Network request failed');
    });
    breakOff(native);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(player.phase).toBe('failed');
    expect(player.failure?.category).not.toBe('T1');
    expect(player.failure?.code).not.toMatch(/network|timeout|interrupted|unreachable/);
    await player.stop();
  });

  it('a missing file ends on the download-missing card at once, no reload', async () => {
    const verify = jest.fn(async () => false);
    const { player } = await resumed(100, { verify } as Partial<LocalSource>);
    mockEngines[0]!.emit({ type: 'error', reason: 'ERROR_CODE_IO_FILE_NOT_FOUND' });
    await flush();
    await flush();
    expect(verify).toHaveBeenCalled();
    expect(player.phase).toBe('failed');
    expect(player.failure?.code).toBe('download_file_missing');
    expect(mockEngines[0]!.load).toHaveBeenCalledTimes(1);
    await player.stop();
  });
});

/** DL-C-verify3 C3-05: a download's start target or explicit seek counts only once it landed (±3 s, as StartSeek). */
describe('local start and seek landing (C3-05)', () => {
  const ENGINES = ['native', 'vlc'] as const;

  it.each(ENGINES)(
    '%s: a reading far above the resume point before the seek lands is never saved',
    async (engine) => {
      const { player, positions } = await resumed(100, { engine });
      const fake = mockEngines.at(-1)!;
      // A stale reading from before the start seek (the engine's previous place).
      fake.at(400);
      await flush();
      expect(positions).toEqual([]);
      expect(events()).toEqual([]);
      expect(player.position).toBe(100);
      fake.at(100.5);
      await flush();
      expect(events()).toEqual(['start']);
      expect(positions).toEqual([100.5]);
      await player.stop();
    }
  );

  it.each(ENGINES)(
    '%s: a transient 0 before an explicit seek lands keeps the last valid position',
    async (engine) => {
      const { player, positions } = await resumed(100, { engine });
      const fake = mockEngines.at(-1)!;
      fake.at(101);
      await flush();
      expect(positions).toEqual([101]);
      player.seekTo(50);
      fake.at(0);
      expect(player.position).toBe(50);
      await player.stop();
      expect(positions.at(-1)).toBe(101);
      expect(Math.min(...positions)).toBeGreaterThan(47);
    }
  );

  it.each(ENGINES)(
    '%s: the explicit seek counts once it landed, also backwards',
    async (engine) => {
      const { player, positions, restarts } = await resumed(100, { engine });
      const fake = mockEngines.at(-1)!;
      fake.at(101);
      player.seekTo(50);
      fake.at(400);
      fake.at(50.4);
      await player.stop();
      expect(positions.at(-1)).toBeCloseTo(50.4, 1);
      expect(positions).not.toContain(400);
      expect(restarts.at(-1)).toBe(true);
    }
  );

  it.each(ENGINES)('%s: "From the beginning" still saves 0', async (engine) => {
    const { player, positions, restarts } = controller(source({ resumeSeconds: 100, engine }));
    const started = player.start();
    await flush();
    player.chooseStart(false);
    await started;
    mockEngines.at(-1)!.at(0);
    await player.stop();
    expect(positions.at(-1)).toBe(0);
    expect(restarts.at(-1)).toBe(true);
  });

  it.each(ENGINES)(
    '%s: a seek back to 0 counts once it landed, not a stale reading of the old place',
    async (engine) => {
      const { player, positions } = await resumed(100, { engine });
      const fake = mockEngines.at(-1)!;
      fake.at(100.2);
      player.seekTo(0);
      fake.at(100.4);
      expect(positions).toEqual([100.2]);
      fake.at(0.3);
      await player.stop();
      expect(positions.at(-1)).toBeCloseTo(0.3, 1);
    }
  );
});

/** A download's start an engine overshot (a keyframe past the target) lands by playback, as for a stream. */
describe('local start gate fallback', () => {
  const ENGINES = ['native', 'vlc'] as const;
  let now = 1_800_000_000_000;
  let info: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(ENGINES)(
    '%s: lands at 106 and plays to 111 over 5 s: the start counts there',
    async (engine) => {
      const { player, positions } = await resumed(100, { engine });
      const fake = mockEngines.at(-1)!;
      fake.at(106);
      for (const position of [107, 108, 109, 110]) {
        now += 1_000;
        fake.at(position);
      }
      await flush();
      expect(positions).toEqual([]);
      expect(events()).toEqual([]);
      now += 1_000;
      fake.at(111);
      await flush();
      expect(events()).toEqual(['start']);
      expect(positions).toEqual([111]);
      expect(info).toHaveBeenCalledWith(
        '[player] start gate opened by playback at 111.0 s, target 100.0 s'
      );
      await player.stop();
      expect(positions.at(-1)).toBe(111);
    }
  );

  it.each(ENGINES)('%s: a stale reading that does not advance never counts', async (engine) => {
    const { player, positions } = await resumed(100, { engine });
    const fake = mockEngines.at(-1)!;
    for (let tick = 0; tick < 20; tick++) {
      now += 1_000;
      fake.at(400);
    }
    await player.stop();
    expect(positions).toEqual([]);
    expect(events()).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });
});
