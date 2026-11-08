import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { createElement } from 'react';

import {
  StreamyboxEngine,
  audioOutputStats,
  hlsSubtitleRenditions,
  mapStreamyboxTracks,
  parseStreamyboxEvent,
  cueBox,
  cueText,
  surfaceRect,
  videoAspect,
} from '../streamybox-engine';
import type { EngineEvent } from '../types';

const mockView = jest.fn(() => null);
let mockAvailable = true;

jest.mock('@modules/streamybox-player', () => ({
  get StreamyboxPlayerView() {
    return mockAvailable ? mockView : null;
  },
}));

let mockTestMuted = false;
jest.mock('../../test-muted', () => ({
  effectiveMuted: (requested: boolean) => mockTestMuted || requested,
}));

type Props = {
  source: string | null;
  loadOptions: string;
  loadNonce: number;
  viewKey: number;
  paused: boolean;
  muted: boolean;
  audioTrack?: number;
  subtitleTrack: number;
  seekMs: number;
  seekNonce: number;
  videoAspect: number;
  cue: string;
  cueLift: number;
  frameRateHint: number;
};
type Internals = {
  props: { get(): Props };
  view: { current: { stop: jest.Mock } | null };
};

function setup() {
  const engine = new StreamyboxEngine();
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  const props = () => (engine as unknown as Internals).props.get();
  const send = (event: object) => engine.onNative(JSON.stringify(event));
  return { engine, events, props, send };
}

const TRACKS = {
  type: 'tracks',
  audio: [
    { id: 1, label: 'English', language: 'eng', codec: 'truehd', channels: 8, selected: true },
    { id: 2, language: 'ger', codec: 'eac3', selected: false },
  ],
  subtitles: [
    { id: 1, label: 'English', language: 'eng', codec: 'subrip', selected: false },
    { id: 2, label: 'Forced', language: 'ger', forced: true, selected: true },
    { id: 3, title: 'Extra', external: true, selected: false },
  ],
  video: {
    width: 3840,
    height: 2160,
    codec: 'hevc',
    frameRate: 23.976,
    range: 'pq',
    dolbyVisionProfile: 8,
    output: 'hdr10',
    hwdec: 'mediacodec',
  },
};

const realFetch = global.fetch;
afterAll(() => {
  global.fetch = realFetch;
});

beforeEach(() => {
  mockAvailable = true;
  mockTestMuted = false;
});

describe('StreamyboxEngine event mapping', () => {
  it('turns contract milliseconds into seconds', () => {
    const { engine, events, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    send({ type: 'time', positionMs: 12_500, durationMs: 7_200_000, bufferedMs: 30_000 });
    expect(events.at(-1)).toEqual({ type: 'time', position: 12.5, duration: 7200, buffered: 30 });
    expect(engine.getSnapshot()).toMatchObject({ position: 12.5, duration: 7200, buffered: 30 });
  });

  it('maps state, buffering, first frame and stats', () => {
    const { engine, events, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    send({ type: 'state', state: 'playing' });
    send({ type: 'buffering', buffering: true });
    send({ type: 'firstFrame' });
    send({
      type: 'stats',
      decoder: 'hevc',
      hwdec: 'mediacodec',
      droppedFrames: 2,
      totalFrames: 400,
    });
    send({ type: 'state', state: 'bogus' });
    expect(events.slice(1)).toEqual([
      { type: 'state', state: 'playing' },
      { type: 'buffering', buffering: true },
      { type: 'firstFrame' },
      {
        type: 'stats',
        stats: { decoder: 'hevc hwdec=mediacodec', droppedFrames: 2, totalFrames: 400 },
      },
    ]);
  });

  it('ignores the idle and error phases the player passes while it opens a file', () => {
    const { engine, events, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    send({ type: 'state', state: 'idle' });
    send({ type: 'state', state: 'loading' });
    send({ type: 'state', state: 'error' });
    send({ type: 'state', state: 'playing' });
    expect(events.slice(1)).toEqual([{ type: 'state', state: 'playing' }]);
    expect(engine.getSnapshot().state).toBe('playing');
  });

  it('reports the end once, whether by state or by event', () => {
    const { engine, events, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    send({ type: 'state', state: 'ended' });
    send({ type: 'ended' });
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1);
    expect(engine.getSnapshot().state).toBe('ended');
  });

  it('ignores malformed JSON', () => {
    expect(parseStreamyboxEvent('{nope')).toBeNull();
    expect(parseStreamyboxEvent('{"no":"type"}')).toBeNull();
    const { events, engine } = setup();
    engine.onNative('[]');
    expect(events).toEqual([]);
  });
});

describe('StreamyboxEngine audio output (Tonausgabe)', () => {
  const tracks = (output: Record<string, string | undefined>) => ({
    type: 'tracks',
    audio: [
      {
        id: 1,
        language: 'eng',
        codec: 'truehd',
        channels: 8,
        selected: true,
        output: output.first,
      },
      {
        id: 2,
        language: 'ger',
        codec: 'eac3',
        channels: 6,
        selected: false,
        output: output.second,
      },
    ],
    subtitles: [],
  });

  it('reads the selected track: a bitstream or PCM with its channels', () => {
    expect(audioOutputStats([{ id: 1, selected: true, output: 'passthrough:truehd' }])).toEqual({
      audioEncoding: 'truehd',
    });
    expect(audioOutputStats([{ id: 1, selected: true, output: 'pcm:2' }])).toEqual({
      audioEncoding: 'pcm',
      audioChannels: 2,
    });
    expect(audioOutputStats([{ id: 1, selected: false, output: 'pcm:2' }])).toEqual({});
    expect(audioOutputStats([{ id: 1, selected: true }])).toEqual({});
    expect(audioOutputStats([{ id: 1, selected: true, output: 'bogus' }])).toEqual({});
  });

  it('puts the output in the stats the info panel shows, and switches with the track', () => {
    const { engine, events, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    send(tracks({ first: 'passthrough:truehd', second: 'pcm:2' }));
    expect(events.at(-1)).toEqual({ type: 'stats', stats: { audioEncoding: 'truehd' } });
    expect(engine.getSnapshot().stats.audioEncoding).toBe('truehd');
    send({
      ...tracks({ first: 'passthrough:truehd', second: 'pcm:2' }),
      audio: [
        { id: 1, codec: 'truehd', selected: false, output: 'passthrough:truehd' },
        { id: 2, codec: 'eac3', selected: true, output: 'pcm:2' },
      ],
    });
    expect(engine.getSnapshot().stats).toMatchObject({ audioEncoding: 'pcm', audioChannels: 2 });
  });

  it('shows no output row for player 1.5.5 (no output field)', () => {
    const { engine, events, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    send(tracks({}));
    expect(events.some((event) => event.type === 'stats')).toBe(false);
    expect(engine.getSnapshot().stats.audioEncoding).toBeUndefined();
  });
});

describe('StreamyboxEngine tracks', () => {
  it('maps mpv ids to string ids in mpv order and keeps the video info', () => {
    const tracks = mapStreamyboxTracks(TRACKS as Parameters<typeof mapStreamyboxTracks>[0]);
    expect(tracks.audio).toEqual([
      { id: '1', label: 'English', language: 'eng', codec: 'truehd', selected: true },
      { id: '2', label: 'ger', language: 'ger', codec: 'eac3', selected: false },
    ]);
    expect(
      tracks.subtitles.map((track) => [track.id, track.label, !!track.forced, track.selected])
    ).toEqual([
      ['1', 'English', false, false],
      ['2', 'Forced', true, true],
      ['3', 'Extra', false, false],
    ]);
    expect(tracks.video).toEqual({
      width: 3840,
      height: 2160,
      codec: 'hevc',
      frameRate: 23.976,
      range: 'pq',
    });
  });

  it('drops tracks without a usable id', () => {
    const tracks = mapStreamyboxTracks({ type: 'tracks', audio: [{ label: 'x' }, { id: -1 }] });
    expect(tracks).toEqual({ audio: [], subtitles: [] });
  });

  it('sends mpv ids; subtitles off is -1', () => {
    const { engine, props, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    send(TRACKS);
    engine.setAudioTrack('2');
    engine.setSubtitleTrack('3');
    expect(props()).toMatchObject({ audioTrack: 2, subtitleTrack: 3 });
    expect(engine.getSnapshot().tracks.subtitles.find((track) => track.selected)?.id).toBe('3');
    engine.setSubtitleTrack(null);
    expect(props().subtitleTrack).toBe(-1);
    expect(engine.getSnapshot().tracks.subtitles.some((track) => track.selected)).toBe(false);
  });
});

describe('StreamyboxEngine commands', () => {
  it('loads progressive sources directly with title and start position', () => {
    const { engine, props } = setup();
    engine.load({
      uri: 'http://x/video.mkv',
      kind: 'progressive',
      startPosition: 61.5,
      title: 'Film',
    });
    expect(props()).toMatchObject({
      source: 'http://x/video.mkv',
      loadNonce: 1,
      subtitleTrack: -1,
    });
    expect(JSON.parse(props().loadOptions)).toEqual({
      surfaceFitsVideo: true,
      subtitleEvents: true,
      title: 'Film',
      startPositionMs: 61_500,
    });
  });

  it('hands the HLS subtitle renditions to mpv as external subtitles', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,URI="subtitles/2/main.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",URI="audio/1/main.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Deutsch",LANGUAGE="de",URI="subtitles/3/main.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1,SUBTITLES="subs"',
      'video/main.m3u8',
    ].join('\n');
    global.fetch = jest.fn(async () => ({ ok: true, text: async () => master })) as never;
    const { engine, props } = setup();
    engine.load({ uri: 'http://host/api/v1/transcode/t/master.m3u8', kind: 'hls' });
    expect(props().source).toBeNull();
    await new Promise((resolve) => setImmediate(resolve));
    expect(props().source).toBe('http://host/api/v1/transcode/t/master.m3u8');
    expect(JSON.parse(props().loadOptions).externalSubtitles).toEqual([
      {
        url: 'http://host/api/v1/transcode/t/subtitles/2/main.m3u8',
        title: 'English',
        language: 'en',
      },
      {
        url: 'http://host/api/v1/transcode/t/subtitles/3/main.m3u8',
        title: 'Deutsch',
        language: 'de',
      },
    ]);
  });

  it('still plays an HLS source whose master cannot be read', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('offline');
    }) as never;
    const { engine, props } = setup();
    engine.load({ uri: 'http://host/master.m3u8', kind: 'hls' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(props().source).toBe('http://host/master.m3u8');
    expect(JSON.parse(props().loadOptions).externalSubtitles).toBeUndefined();
  });

  it('parses only subtitle renditions with a URI', () => {
    expect(
      hlsSubtitleRenditions('#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="x"', 'http://h/m.m3u8')
    ).toEqual([]);
  });

  it('play, pause and seek become props; a seek publishes its target at once', () => {
    const { engine, events, props } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    engine.pause();
    expect(props().paused).toBe(true);
    engine.play();
    expect(props().paused).toBe(false);
    engine.seek(90.25);
    expect(props()).toMatchObject({ seekMs: 90_250, seekNonce: 1 });
    expect(JSON.parse(props().loadOptions).startPositionMs).toBe(90_250);
    expect(events.at(-1)).toMatchObject({ type: 'time', position: 90.25 });
  });

  it('plays again from the start after the end', () => {
    const { engine, props, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive', startPosition: 10 });
    send({ type: 'ended' });
    engine.play();
    expect(props().loadNonce).toBe(2);
    expect(JSON.parse(props().loadOptions).startPositionMs).toBeUndefined();
  });

  it('a seek after the end loads again at the target and keeps the pause (mpv is released)', () => {
    const { engine, props, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    engine.pause();
    send({ type: 'ended' });
    engine.seek(42);
    expect(props().loadNonce).toBe(2);
    expect(JSON.parse(props().loadOptions).startPositionMs).toBe(42_000);
    expect(props().paused).toBe(true);
    expect(props().seekNonce).toBe(0);
  });

  it('play after a fatal player error loads again at the position with the viewer tracks', () => {
    const { engine, props, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    send(TRACKS);
    engine.setAudioTrack('2');
    engine.setSubtitleTrack('1');
    send({ type: 'time', positionMs: 30_000, durationMs: 120_000 });
    send({ type: 'error', reason: 'decoder', fatal: true });
    engine.play();
    expect(props().loadNonce).toBe(2);
    expect(JSON.parse(props().loadOptions).startPositionMs).toBe(30_000);
    expect(props()).toMatchObject({ audioTrack: 2, subtitleTrack: 1, paused: false });
  });

  it("hands the server's frame rate to the view as the display vote's fallback", () => {
    const { engine, props } = setup();
    expect(props().frameRateHint).toBe(0);
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive', frameRate: 23.976 });
    expect(props()).toMatchObject({ loadNonce: 1, frameRateHint: 23.976 });
  });

  it('keeps the frame rate across a reload and drops it for a source without one', () => {
    const { engine, props, send } = setup();
    engine.load({ uri: 'http://x/a.mkv', kind: 'progressive', frameRate: 25 });
    send({ type: 'ended' });
    engine.play();
    expect(props()).toMatchObject({ loadNonce: 2, frameRateHint: 25 });
    engine.load({ uri: 'http://x/b.mkv', kind: 'progressive' });
    expect(props()).toMatchObject({ loadNonce: 3, frameRateHint: 0 });
    engine.load({ uri: 'http://x/c.mkv', kind: 'progressive', frameRate: Number.NaN });
    expect(props().frameRateHint).toBe(0);
  });

  it('seeks in place while the session plays (no reload)', () => {
    const { engine, props } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    engine.seek(10);
    engine.play();
    expect(props().loadNonce).toBe(1);
    expect(props().seekNonce).toBe(1);
  });
});

describe('StreamyboxEngine muted', () => {
  it('passes the requested mute', () => {
    const { engine, props } = setup();
    expect(props().muted).toBe(false);
    engine.setMuted(true);
    expect(props().muted).toBe(true);
    engine.setMuted(false);
    expect(props().muted).toBe(false);
  });

  it('a test-muted build stays silent', () => {
    mockTestMuted = true;
    const { engine, props } = setup();
    expect(props().muted).toBe(true);
    engine.setMuted(false);
    expect(props().muted).toBe(true);
  });

  it('a test-muted build loads muted, so the player plays PCM at volume 0 instead of a bitstream', () => {
    mockTestMuted = true;
    const { engine, props, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    engine.setMuted(false);
    expect(props()).toMatchObject({ muted: true, loadNonce: 1 });
    send({ type: 'ended' });
    engine.play();
    expect(props()).toMatchObject({ muted: true, loadNonce: 2 });
  });
});

describe('StreamyboxEngine errors', () => {
  it('reports a fatal player error with its HTTP status', () => {
    const { engine, events, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    send({ type: 'error', reason: 'http 403', fatal: true, status: 403 });
    expect(events.slice(-2)).toEqual([
      { type: 'state', state: 'error' },
      { type: 'error', reason: 'http 403', status: 403 },
    ]);
  });

  it('a failed subtitle is a subtitle error, other non-fatal errors are ignored', () => {
    const { engine, events, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    send({ type: 'error', reason: 'subtitle load failed', fatal: false, status: 404 });
    send({ type: 'error', reason: 'cache hiccup', fatal: false });
    expect(events.slice(1)).toEqual([{ type: 'subtitleError', code: 'unknown_subtitle_stream' }]);
  });

  it('binds a fresh view on the next load after the binding died or was replaced', () => {
    const { engine, events, props, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    send({ type: 'error', reason: 'streamybox_service_died', fatal: true });
    expect(events.at(-1)).toEqual({ type: 'error', reason: 'streamybox_service_died' });
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive', startPosition: 5 });
    expect(props().viewKey).toBe(1);
    send({ type: 'error', reason: 'replaced' });
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    expect(props().viewKey).toBe(2);
    send({ type: 'error', reason: 'demuxer failed', fatal: true });
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    expect(props().viewKey).toBe(2);
  });

  it('fails the load where the native module is missing', () => {
    mockAvailable = false;
    const { engine, events, props } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    expect(events.slice(1)).toEqual([
      { type: 'state', state: 'error' },
      { type: 'error', reason: 'streamybox_unavailable' },
    ]);
    expect(props().source).toBeNull();
  });
});

describe('StreamyboxEngine health and teardown', () => {
  it('reports fresh frame counters only', async () => {
    jest.useFakeTimers();
    const { engine, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    send(TRACKS);
    send({ type: 'firstFrame' });
    send({ type: 'stats', totalFrames: 100, droppedFrames: 1 });
    await expect(engine.readHealth()).resolves.toEqual({
      framesPresented: 100,
      framesDropped: 1,
      readyForDisplay: true,
      hasVideoTrack: true,
    });
    jest.setSystemTime(Date.now() + 5_000);
    await expect(engine.readHealth()).resolves.toEqual({
      readyForDisplay: true,
      hasVideoTrack: true,
    });
    jest.useRealTimers();
  });

  it('stops the player on shutdown and unmounts the view on release', async () => {
    const { engine, events, props, send } = setup();
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive' });
    const stop = jest.fn(async () => undefined);
    (engine as unknown as Internals).view.current = { stop };
    await engine.shutdown();
    expect(stop).toHaveBeenCalled();
    engine.release();
    expect(props().source).toBeNull();
    const before = events.length;
    send({ type: 'state', state: 'playing' });
    expect(events).toHaveLength(before);
  });
});

describe('StreamyboxEngine surface geometry (mediacodec_embed fills its surface)', () => {
  it('takes the display aspect, else width / height, else unknown', () => {
    expect(videoAspect({ width: 3840, height: 2024 })).toBeCloseTo(1.8972, 4);
    expect(videoAspect({ width: 720, height: 576, aspect: 16 / 9 })).toBeCloseTo(1.7778, 4);
    expect(videoAspect({ width: 720, height: 576, aspect: 0 })).toBeCloseTo(1.25, 4);
    expect(videoAspect({ codec: 'hevc' })).toBe(0);
    expect(videoAspect(null)).toBe(0);
  });

  it('letterboxes a wide film and pillarboxes a narrow one, centred', () => {
    const wide = surfaceRect(1920, 1080, 3840 / 2024)!;
    expect(wide.width).toBe(1920);
    expect(wide.height).toBeCloseTo(1012, 0);
    expect(wide.left).toBe(0);
    expect(wide.top).toBeCloseTo(34, 0);
    expect(surfaceRect(1920, 1080, 4 / 3)).toEqual({
      left: 240,
      top: 0,
      width: 1440,
      height: 1080,
    });
    expect(surfaceRect(1920, 1080, 16 / 9)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
  });

  it('overfills the area for cover (zoom), still centred', () => {
    const cover = surfaceRect(1920, 1080, 2.4, 'cover')!;
    expect(cover.height).toBe(1080);
    expect(cover.width).toBeCloseTo(2592, 0);
    expect(cover.left).toBeCloseTo(-336, 0);
    expect(cover.top).toBe(0);
  });

  it('fills the area while the area or the aspect is unknown', () => {
    expect(surfaceRect(0, 0, 1.9)).toBeNull();
    expect(surfaceRect(1920, 1080, 0)).toBeNull();
  });

  it('follows the video track, ignores rounding, and starts unknown for another file', () => {
    const { engine, props, send } = setup();
    engine.load({ uri: 'http://x/film.mkv', kind: 'progressive' });
    expect(props().videoAspect).toBe(0);
    send({ type: 'tracks', video: { width: 3840, height: 2024 } });
    expect(props().videoAspect).toBeCloseTo(1.8972, 4);
    const before = props();
    send({ type: 'tracks', video: { width: 3838, height: 2023 } });
    expect(props()).toBe(before);
    send({ type: 'tracks', audio: [] });
    expect(props().videoAspect).toBeCloseTo(1.8972, 4);
    engine.seek(10);
    engine.load({ uri: 'http://x/film.mkv', kind: 'progressive', startPosition: 10 });
    expect(props().videoAspect).toBeCloseTo(1.8972, 4);
    engine.load({ uri: 'http://x/episode.mkv', kind: 'progressive' });
    expect(props().videoAspect).toBe(0);
  });

  it('lays the native view out letterboxed, re-laid-out when the area changes', async () => {
    const { engine, send } = setup();
    engine.load({ uri: 'http://x/film.mkv', kind: 'progressive' });
    send({ type: 'tracks', video: { width: 3840, height: 2024 } });
    await render(createElement(engine.Surface, { fit: 'contain' }));
    const style = () => (mockView.mock.calls.at(-1) as unknown as [{ style: object }])[0].style;
    expect(style()).toMatchObject({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 });
    const layout = (width: number, height: number) =>
      act(() =>
        fireEvent(screen.getByTestId('streamybox-surface'), 'layout', {
          nativeEvent: { layout: { x: 0, y: 0, width, height } },
        })
      );
    await layout(1920, 1080);
    expect(style()).toMatchObject({ position: 'absolute', left: 0, width: 1920 });
    expect((style() as { top: number }).top).toBeCloseTo(34, 0);
    await layout(1080, 1920);
    expect((style() as { width: number; height: number }).width).toBe(1080);
    expect((style() as { height: number }).height).toBeCloseTo(569, 0);
  });
});

describe('StreamyboxEngine text cues (subtitle events while mpv shows the decoder output)', () => {
  it('turns a cue into plain lines: ASS overrides and tags go, \\N breaks a line', () => {
    expect(cueText('{\\an8}<i>Hallo</i>\\NWelt ')).toBe('Hallo\nWelt');
    expect(cueText('  \n ')).toBe('');
    expect(cueText(undefined)).toBe('');
  });

  it('sits bottom-centre inside the picture, above the TV-safe edge and the control bar', () => {
    const area = { width: 1920, height: 1080 };
    const rect = surfaceRect(1920, 1080, 3840 / 2024)!;
    const box = cueBox(area, rect);
    expect(box.left).toBe(0);
    expect(box.width).toBe(1920);
    // 34 px letterbox below + 6 % of the 1012 px picture
    expect(box.bottom).toBeCloseTo(34 + 1012 * 0.05, 0);
    expect(box.fontSize).toBe(Math.round(1012 * 0.05));
    expect(cueBox(area, rect, 0.2).bottom).toBeCloseTo(216, 0);
    const pillar = cueBox(area, surfaceRect(1920, 1080, 4 / 3));
    expect(pillar.left).toBe(240);
    expect(pillar.width).toBe(1440);
    expect(cueBox(area, null).bottom).toBeCloseTo(1080 * 0.05, 0);
  });

  it('shows the cue, hides it when empty or invisible, and clears it on track off, end and a new load', () => {
    const { engine, props, send } = setup();
    engine.load({ uri: 'http://x/film.mkv', kind: 'progressive' });
    send({ type: 'subtitle', text: 'Wo ist er?', visible: true });
    expect(props().cue).toBe('Wo ist er?');
    send({ type: 'subtitle', text: '', visible: true });
    expect(props().cue).toBe('');
    send({ type: 'subtitle', text: 'Da!', visible: false });
    expect(props().cue).toBe('');
    send({ type: 'subtitle', text: 'Da!' });
    expect(props().cue).toBe('Da!');
    engine.setSubtitleTrack(null);
    expect(props().cue).toBe('');
    send({ type: 'subtitle', text: 'Wieder' });
    send({ type: 'ended' });
    expect(props().cue).toBe('');
    send({ type: 'subtitle', text: 'Noch einmal' });
    engine.load({ uri: 'http://x/other.mkv', kind: 'progressive' });
    expect(props().cue).toBe('');
  });

  it('never draws over a bitmap track the player draws itself', () => {
    const { engine, props, send } = setup();
    engine.load({ uri: 'http://x/film.mkv', kind: 'progressive' });
    send({
      type: 'tracks',
      subtitles: [{ id: 1, codec: 'hdmv_pgs_subtitle', selected: true }],
      video: { width: 1920, height: 1080 },
    });
    send({ type: 'subtitle', text: 'Bitmap', visible: true });
    expect(props().cue).toBe('');
    send({
      type: 'tracks',
      subtitles: [{ id: 2, codec: 'subrip', selected: true }],
      video: { width: 1920, height: 1080 },
    });
    send({ type: 'subtitle', text: 'Text', visible: true });
    expect(props().cue).toBe('Text');
  });

  it('moves above the control bar while it shows', () => {
    const { engine, props } = setup();
    engine.setSubtitleLift(0.18);
    expect(props().cueLift).toBe(0.18);
    engine.setSubtitleLift(-1);
    expect(props().cueLift).toBe(0);
  });

  it('draws the cue over the letterboxed picture', async () => {
    const { engine, send } = setup();
    engine.load({ uri: 'http://x/film.mkv', kind: 'progressive' });
    send({ type: 'tracks', video: { width: 3840, height: 2024 } });
    send({ type: 'subtitle', text: 'Untertitel', visible: true });
    await render(createElement(engine.Surface, { fit: 'contain' }));
    await act(() =>
      fireEvent(screen.getByTestId('streamybox-surface'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 1920, height: 1080 } },
      })
    );
    expect(screen.getByTestId('streamybox-cue-text')).toHaveTextContent('Untertitel');
    await act(async () => send({ type: 'subtitle', text: '', visible: false }));
    expect(screen.queryByTestId('streamybox-cue')).toBeNull();
  });
});

describe('StreamyboxEngine subtitle in the load (forced subtitles stay on)', () => {
  it('loads with the chosen embedded track, off only when none is chosen', () => {
    const { engine, props } = setup();
    engine.load({ uri: 'http://x/film.mkv', kind: 'progressive', subtitle: 1 });
    expect(props().subtitleTrack).toBe(1);
    engine.load({ uri: 'http://x/other.mkv', kind: 'progressive' });
    expect(props().subtitleTrack).toBe(-1);
  });
});
