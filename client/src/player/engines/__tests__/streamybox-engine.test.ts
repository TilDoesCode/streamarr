import {
  StreamyboxEngine,
  hlsSubtitleRenditions,
  mapStreamyboxTracks,
  parseStreamyboxEvent,
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
    expect(JSON.parse(props().loadOptions)).toEqual({ title: 'Film', startPositionMs: 61_500 });
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
