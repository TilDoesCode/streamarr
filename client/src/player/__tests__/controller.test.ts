import type { ApiClient } from '@/api/client';
import type { EngineEvent, EngineSnapshot, PlayerEngine } from '@/player/engines';
import type { Playback } from '@/player/playback-api';

import { rememberedAudioLanguage } from '../audio-preference';
import { AUDIO_SWITCH_TIMEOUT_MS, PlaybackController } from '../controller';

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
function controller(startSeconds?: number, preferences?: { subtitleMode: string }) {
  account += 1;
  return new PlaybackController({
    client,
    accountId: `c${account}`,
    serverUrl: 'http://server',
    profile: {} as never,
    nativeEngine: 'expo-video',
    workId: 'w1',
    startSeconds,
    preferences,
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

  describe('resume floor', () => {
    const reported = (c: PlaybackController) =>
      (c.progress.report as jest.Mock).mock.calls.map(
        ([report]: [{ event: string; positionTicks: number }]) => [
          report.event,
          report.positionTicks / TICKS,
        ]
      );
    async function resumed(start: number) {
      mockApi.startPlayback.mockResolvedValue(ready());
      const c = controller(start);
      jest.spyOn(c.progress, 'report').mockResolvedValue(undefined as never);
      await c.start();
      return c;
    }

    it('never reports below the start while the engine is stuck before it', async () => {
      const c = await resumed(96);
      for (const position of [0, 2, 4]) {
        mockEngine.snapshot.position = position;
        mockEngine.emit({ type: 'time', position, duration: 600 });
      }
      c.setPaused(true);
      await c.stop();
      expect(reported(c)).toEqual([
        ['start', 96],
        ['progress', 96],
        ['stop', 96],
      ]);
    });

    it('keeps the start for a switch while the engine has not reached it', async () => {
      mockApi.switchPlayback.mockResolvedValue(ready({ revision: 1, method: 'remux' }));
      const c = await resumed(96);
      mockEngine.snapshot.position = 3;
      mockEngine.emit({ type: 'time', position: 3, duration: 600 });
      expect(c.resumePosition).toBe(96);
      await c.stop();
    });

    it('reports normally once the start was reached', async () => {
      const c = await resumed(96);
      for (const position of [95, 97, 40]) {
        mockEngine.snapshot.position = position;
        mockEngine.emit({ type: 'time', position, duration: 600 });
      }
      await c.stop();
      expect(reported(c).at(-1)).toEqual(['stop', 40]);
    });

    it('reports normally after the viewer seeks on purpose', async () => {
      const c = await resumed(96);
      c.seekTo(10);
      await c.stop();
      expect(reported(c).at(-1)).toEqual(['stop', 10]);
    });

    it('leaves a start at 0 unchanged', async () => {
      const c = await resumed(0);
      mockEngine.snapshot.position = 3;
      mockEngine.emit({ type: 'time', position: 3, duration: 600 });
      await c.stop();
      expect(reported(c)).toEqual([
        ['start', 0],
        ['stop', 3],
      ]);
    });
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

  it('continues a step-down at the last good position when the failing engine reset its clock', async () => {
    mockApi.startPlayback.mockResolvedValue(ready());
    mockApi.switchPlayback
      .mockResolvedValueOnce(ready({ revision: 1 }))
      .mockResolvedValueOnce(ready({ revision: 2, engine: 'vlc' } as Partial<Playback>));
    const c = controller(0);
    await c.start();
    mockEngine.snapshot.position = 38;
    mockEngine.emit({ type: 'time', position: 38, duration: 600 } as EngineEvent);
    await c.stepDown('decoder');
    expect(mockEngine.load).toHaveBeenLastCalledWith(
      expect.objectContaining({ startPosition: 38 })
    );
    mockEngine.snapshot.state = 'loading';
    mockEngine.snapshot.position = 0;
    mockEngine.emit({ type: 'time', position: 0, duration: 600 } as EngineEvent);
    mockEngine.snapshot.state = 'error';
    await c.stepDown('source');
    expect(mockApi.switchPlayback.mock.calls[1][2]).toMatchObject({ positionTicks: 38 * TICKS });
    expect(mockEngine.load).toHaveBeenLastCalledWith(
      expect.objectContaining({ startPosition: 38 })
    );
    mockEngine.snapshot.state = 'playing';
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

  describe('audio switch', () => {
    const renditions = [
      {
        id: '1',
        streamIndex: 1,
        language: 'de',
        label: 'Deutsch · AAC 2.0',
        channels: 2,
        codec: 'aac',
        default: true,
      },
      {
        id: '2',
        streamIndex: 2,
        language: 'en',
        label: 'English · AAC 2.0',
        channels: 2,
        codec: 'aac',
        default: false,
      },
    ];
    const audioTracks = (renditionIds: (string | null)[], deliveredAs = 'remux') => [
      { index: 1, language: 'ger', selected: true, deliveredAs, renditionId: renditionIds[0] },
      { index: 2, language: 'eng', selected: false, deliveredAs, renditionId: renditionIds[1] },
    ];
    const sintel = (over: Partial<Playback> = {}) =>
      ready({
        method: 'remux',
        url: '/stream/p1/master.m3u8',
        inSessionAudioSwitch: true,
        audioRenditions: renditions,
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: audioTracks(['1', '2']),
          subtitleTracks: [],
        },
        ...over,
      } as never);
    // Engine order differs from the master on purpose.
    const engineTracks = (selected: string) => ({
      audio: [
        { id: 'e0', label: 'English · AAC 2.0', language: 'en', selected: selected === 'e0' },
        { id: 'e1', label: 'Deutsch · AAC 2.0', language: 'de', selected: selected === 'e1' },
      ],
      subtitles: [],
    });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const english = () => ({ index: 2, language: 'eng' }) as never;

    async function playing(playback: Playback, mode?: string) {
      mockApi.startPlayback.mockResolvedValue(playback);
      const c = controller(0, mode ? { subtitleMode: mode } : undefined);
      await c.start();
      mockEngine.snapshot.tracks = engineTracks('e1') as never;
      mockEngine.snapshot.position = 42;
      mockEngine.emit({ type: 'time', position: 42, duration: 600 });
      return c;
    }

    afterEach(() => {
      mockEngine.snapshot.tracks = { audio: [], subtitles: [] } as never;
    });

    it('switches a rendition inside the session: engine track by name, no /switch', async () => {
      const c = await playing(sintel());
      expect(c.currentAudio()).toBe(1);
      const switching = c.selectAudio(english());
      expect(mockEngine.setAudioTrack).toHaveBeenCalledWith('e0');
      expect(c.currentAudio()).toBe(2);
      mockEngine.snapshot.tracks = engineTracks('e0') as never;
      mockEngine.emit({ type: 'tracks', tracks: mockEngine.snapshot.tracks });
      mockEngine.emit({ type: 'time', position: 42.4, duration: 600 });
      await switching;
      expect(mockApi.switchPlayback).not.toHaveBeenCalled();
      expect(mockEngine.load).toHaveBeenCalledTimes(1);
      expect(c.currentAudio()).toBe(2);
      expect(c.audioSwitches).toEqual([
        expect.objectContaining({
          via: 'session',
          from: 1,
          to: 2,
          positionBefore: 42,
          positionAfter: 42.4,
        }),
      ]);
      expect(c.audioSwitches[0]!.ms).toBeGreaterThanOrEqual(0);
      expect(rememberedAudioLanguage(c.options.accountId)).toBe('en');
      await c.stop();
    });

    it.each([
      ['drops', 's0', null],
      ['adds', null, 's0'],
    ])(
      'keeps the subtitle when the engine %s one on an in-session audio switch (AVPlayer)',
      async (_case, before, after) => {
        const c = await playing(sintel());
        const withSubtitle = (audio: string, selected: string | null) => ({
          ...engineTracks(audio),
          subtitles: [
            { id: 's0', label: 'Deutsch erzwungen', language: 'de', selected: !!selected },
          ],
        });
        mockEngine.snapshot.tracks = withSubtitle('e1', before) as never;
        const switching = c.selectAudio(english());
        mockEngine.snapshot.tracks = withSubtitle('e0', after) as never;
        mockEngine.emit({ type: 'tracks', tracks: mockEngine.snapshot.tracks });
        expect(mockEngine.setSubtitleTrack).toHaveBeenCalledWith(before);
        mockEngine.emit({ type: 'time', position: 42.4, duration: 600 });
        await switching;
        await c.selectSubtitle(null);
        mockEngine.setSubtitleTrack.mockClear();
        mockEngine.emit({ type: 'tracks', tracks: withSubtitle('e0', 's0') as never });
        expect(mockEngine.setSubtitleTrack).not.toHaveBeenCalled();
        await c.stop();
      }
    );

    it.each([
      ['plays another rendition', 'e0', ['e1']],
      ['already plays it', 'e1', []],
    ])(
      'selects the server rendition on a new source when the engine %s (ExoPlayer keeps picks)',
      async (_case, heard, calls) => {
        mockApi.startPlayback.mockResolvedValue(sintel());
        const c = controller(0);
        await c.start();
        mockEngine.emit({ type: 'tracks', tracks: engineTracks(heard) as never });
        expect(mockEngine.setAudioTrack.mock.calls.map((call) => call[0])).toEqual(calls);
        await c.stop();
      }
    );

    it('re-applies the server rendition when the engine picks by system language afterwards (Safari)', async () => {
      mockApi.startPlayback.mockResolvedValue(sintel());
      const c = controller(0);
      await c.start();
      for (let i = 0; i < 5; i++)
        mockEngine.emit({ type: 'tracks', tracks: engineTracks('e0') as never });
      expect(mockEngine.setAudioTrack.mock.calls.map((call) => call[0])).toEqual([
        'e1',
        'e1',
        'e1',
      ]);
      await c.stop();
    });

    it('applies the server rendition while the engine lists fewer subtitles (Safari forced kind)', async () => {
      const playback = sintel();
      playback.mediaInfo!.subtitleTracks = [
        { index: 3, language: 'ger', deliveredAs: 'webvtt', selected: false },
      ] as never;
      mockApi.startPlayback.mockResolvedValue(playback);
      const c = controller(0);
      await c.start();
      mockEngine.emit({ type: 'tracks', tracks: engineTracks('e0') as never });
      expect(mockEngine.setAudioTrack).toHaveBeenCalledWith('e1');
      await c.stop();
    });

    it('re-applies the server subtitle when the engine picks a forced one by itself (AVPlayer)', async () => {
      const playback = sintel();
      playback.mediaInfo!.subtitleTracks = [
        { index: 5, language: 'ger', forced: true, deliveredAs: 'webvtt', selected: false },
      ] as never;
      mockApi.startPlayback.mockResolvedValue(playback);
      const c = controller(0);
      await c.start();
      const withForced = (shown: boolean) => ({
        ...engineTracks('e1'),
        subtitles: [{ id: 's0', label: 'Deutsch erzwungen', language: 'de', selected: shown }],
      });
      mockEngine.emit({ type: 'tracks', tracks: withForced(false) as never });
      expect(mockEngine.setSubtitleTrack).not.toHaveBeenCalled();
      mockEngine.emit({ type: 'tracks', tracks: withForced(true) as never });
      expect(mockEngine.setSubtitleTrack).toHaveBeenCalledWith(null);
      mockEngine.snapshot.tracks = withForced(true) as never;
      await c.selectSubtitle({ index: 5 } as never);
      mockEngine.setSubtitleTrack.mockClear();
      mockEngine.emit({ type: 'tracks', tracks: withForced(true) as never });
      expect(mockEngine.setSubtitleTrack).not.toHaveBeenCalled();
      await c.stop();
    });

    it('stops re-applying the server rendition once the viewer picks a track', async () => {
      mockApi.startPlayback.mockResolvedValue(sintel());
      const c = controller(0);
      await c.start();
      mockEngine.snapshot.tracks = engineTracks('e1') as never;
      mockEngine.emit({ type: 'tracks', tracks: mockEngine.snapshot.tracks });
      void c.selectAudio(english());
      mockEngine.setAudioTrack.mockClear();
      mockEngine.emit({ type: 'tracks', tracks: engineTracks('e0') as never });
      expect(mockEngine.setAudioTrack).not.toHaveBeenCalled();
      await c.stop();
    });

    it.each([
      ['inSessionAudioSwitch is false', sintel({ inSessionAudioSwitch: false })],
      [
        'the track has no renditionId',
        sintel({
          mediaInfo: {
            durationTicks: 600 * TICKS,
            audioTracks: audioTracks(['1', null]),
            subtitleTracks: [],
          },
        } as never),
      ],
    ])('uses /switch when %s', async (_case, playback) => {
      const c = await playing(playback);
      mockApi.switchPlayback.mockResolvedValue(sintel({ revision: 1, url: '/stream/p1/r1.m3u8' }));
      const switching = c.selectAudio(english());
      await flush();
      expect(mockApi.switchPlayback.mock.calls[0][2]).toMatchObject({ audioStreamIndex: 2 });
      expect(mockEngine.setAudioTrack).not.toHaveBeenCalled();
      mockEngine.emit({ type: 'time', position: 42.3, duration: 600 });
      await switching;
      expect(c.audioSwitches).toEqual([expect.objectContaining({ via: 'server', to: 2 })]);
      await c.stop();
    });

    it('keeps the engine switch for direct play', async () => {
      const c = await playing(
        ready({
          mediaInfo: {
            durationTicks: 600 * TICKS,
            audioTracks: audioTracks([null, null], 'original'),
            subtitleTracks: [],
          },
        } as never)
      );
      mockEngine.snapshot.tracks = {
        audio: [
          { id: 'v1', label: 'de', selected: true },
          { id: 'v2', label: 'en', selected: false },
        ],
        subtitles: [],
      } as never;
      await c.selectAudio(english());
      expect(mockEngine.setAudioTrack).toHaveBeenCalledWith('v2');
      expect(mockApi.switchPlayback).not.toHaveBeenCalled();
      await c.stop();
    });

    it('falls back to /switch when the rendition fails in the engine', async () => {
      const c = await playing(sintel());
      mockApi.switchPlayback.mockResolvedValue(sintel({ revision: 1, url: '/stream/p1/r1.m3u8' }));
      const switching = c.selectAudio(english());
      mockEngine.emit({ type: 'audioError', code: 'unknown_audio_rendition' });
      await flush();
      await flush();
      expect(mockApi.switchPlayback.mock.calls[0][2]).toMatchObject({ audioStreamIndex: 2 });
      mockEngine.emit({ type: 'time', position: 42.3, duration: 600 });
      await switching;
      expect(c.audioSwitches).toEqual([
        expect.objectContaining({ via: 'session', error: 'unknown_audio_rendition' }),
        expect.objectContaining({
          via: 'server',
          to: 2,
          fallback: 'unknown_audio_rendition',
          ms: expect.any(Number),
        }),
      ]);
      expect(c.notice).toBeNull();
      await c.stop();
    });

    it('uses /switch when no engine track matches the rendition', async () => {
      const c = await playing(sintel());
      mockEngine.snapshot.tracks = {
        audio: [{ id: 'x', label: 'Français', language: 'fr', selected: true }],
        subtitles: [],
      } as never;
      mockApi.switchPlayback.mockResolvedValue(sintel({ revision: 1 }));
      const switching = c.selectAudio(english());
      await flush();
      expect(mockEngine.setAudioTrack).not.toHaveBeenCalled();
      expect(mockApi.switchPlayback.mock.calls[0][2]).toMatchObject({ audioStreamIndex: 2 });
      mockEngine.emit({ type: 'time', position: 42.3, duration: 600 });
      await switching;
      expect(c.audioSwitches).toEqual([
        expect.objectContaining({ via: 'server', fallback: 'no_engine_track' }),
      ]);
      await c.stop();
    });

    it('falls back to /switch when the engine never confirms the track', async () => {
      jest.useFakeTimers();
      try {
        const c = await playing(sintel());
        mockApi.switchPlayback.mockResolvedValue(sintel({ revision: 1 }));
        const switching = c.selectAudio(english());
        await jest.advanceTimersByTimeAsync(AUDIO_SWITCH_TIMEOUT_MS);
        expect(mockApi.switchPlayback).toHaveBeenCalledTimes(1);
        mockEngine.emit({ type: 'time', position: 42.3, duration: 600 });
        await switching;
        expect(c.audioSwitches[0]).toMatchObject({ via: 'session', error: 'audio_switch_timeout' });
        expect(c.audioSwitches[1]).toMatchObject({
          via: 'server',
          fallback: 'audio_switch_timeout',
        });
        await c.stop();
      } finally {
        jest.useRealTimers();
      }
    });
    describe('forced subtitles follow the audio language', () => {
      const subtitleTracks = (englishForced: boolean) => [
        { index: 5, language: 'ger', forced: true, deliveredAs: 'webvtt', selected: false },
        ...(englishForced
          ? [{ index: 6, language: 'eng', forced: true, deliveredAs: 'webvtt', selected: false }]
          : []),
        { index: 7, language: 'eng', forced: false, deliveredAs: 'webvtt', selected: false },
      ];
      const withSubtitles = (playback: Playback, englishForced: boolean) => {
        playback.mediaInfo!.subtitleTracks = subtitleTracks(englishForced) as never;
        return playback;
      };
      const tracks = (audio: string, englishForced: boolean, shown: number | null) => ({
        ...engineTracks(audio),
        subtitles: subtitleTracks(englishForced).map((track) => ({
          id: `s${track.index}`,
          label: track.language,
          language: track.language,
          selected: track.index === shown,
        })),
      });

      async function sessionSwitch(englishForced: boolean, shown: number | null, mode?: string) {
        const c = await playing(withSubtitles(sintel(), englishForced), mode);
        mockEngine.snapshot.tracks = tracks('e1', englishForced, shown) as never;
        const switching = c.selectAudio(english());
        // AVPlayer's own selection keeps the German forced track: the controller overrides it.
        mockEngine.snapshot.tracks = tracks('e0', englishForced, shown) as never;
        mockEngine.emit({ type: 'tracks', tracks: mockEngine.snapshot.tracks });
        mockEngine.emit({ type: 'time', position: 42.4, duration: 600 });
        await switching;
        expect(mockApi.switchPlayback).not.toHaveBeenCalled();
        const calls = mockEngine.setSubtitleTrack.mock.calls.map((call) => call[0]);
        await c.stop();
        return calls;
      }

      it('moves a German forced subtitle to the English forced track', async () => {
        expect(await sessionSwitch(true, 5)).toEqual(['s6', 's6']);
      });

      it('turns a German forced subtitle off when English has no forced track', async () => {
        expect(await sessionSwitch(false, 5)).toEqual([null, null]);
      });

      it('keeps a full subtitle the viewer picked', async () => {
        expect(await sessionSwitch(true, 7)).toEqual([]);
      });

      it('shows the new language forced track when subtitles are off in mode forced', async () => {
        expect(await sessionSwitch(true, null)).toEqual(['s6', 's6']);
      });

      it('keeps subtitles off in mode off', async () => {
        expect(await sessionSwitch(true, null, 'off')).toEqual([]);
      });

      it.each([
        [true, 6],
        [false, -1],
      ])(
        'sends the new forced track on /switch (English forced: %s)',
        async (englishForced, index) => {
          const c = await playing(
            withSubtitles(sintel({ inSessionAudioSwitch: false }), englishForced)
          );
          mockEngine.snapshot.tracks = tracks('e1', englishForced, 5) as never;
          mockApi.switchPlayback.mockResolvedValue(
            sintel({ revision: 1, url: '/stream/p1/r1.m3u8' })
          );
          const switching = c.selectAudio(english());
          await flush();
          expect(mockApi.switchPlayback.mock.calls[0][2]).toMatchObject({
            audioStreamIndex: 2,
            subtitleStreamIndex: index,
          });
          mockEngine.emit({ type: 'time', position: 42.3, duration: 600 });
          await switching;
          await c.stop();
        }
      );

      it('uses /switch when the forced subtitle is burned in', async () => {
        const playback = withSubtitles(sintel(), false);
        playback.mediaInfo!.subtitleTracks = [
          { index: 5, language: 'ger', forced: true, deliveredAs: 'burnedIn', selected: true },
        ] as never;
        const c = await playing(playback);
        mockApi.switchPlayback.mockResolvedValue(
          sintel({ revision: 1, url: '/stream/p1/r1.m3u8' })
        );
        const switching = c.selectAudio(english());
        await flush();
        expect(mockEngine.setAudioTrack).not.toHaveBeenCalled();
        expect(mockApi.switchPlayback.mock.calls[0][2]).toMatchObject({
          audioStreamIndex: 2,
          subtitleStreamIndex: -1,
        });
        mockEngine.emit({ type: 'time', position: 42.3, duration: 600 });
        await switching;
        await c.stop();
      });
    });
  });
});
