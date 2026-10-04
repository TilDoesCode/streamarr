import { WebEngine } from '@/player/engines/web-engine.web';

type Handler = (...args: unknown[]) => void;

class MockHls {
  static last: MockHls | undefined;
  handlers = new Map<string, Handler[]>();
  subtitleTracks = [
    { name: 'Deutsch (forced)', lang: 'de' },
    { name: 'Deutsch', lang: 'de' },
    { name: 'English', lang: 'en' },
  ];
  audioTracks = [{ name: 'Deutsch', lang: 'de' }];
  audioTrack = 0;
  subtitleDisplay = true;
  private trackId = -1;
  bandwidthEstimate = 0;
  constructor() {
    MockHls.last = this;
  }
  get subtitleTrack() {
    return this.trackId;
  }
  set subtitleTrack(id: number) {
    const changed = id !== this.trackId;
    this.trackId = id;
    if (changed) this.trigger('hlsSubtitleTrackSwitch', { id });
  }
  /** What hls.js's onTextTracksChanged does when it reads a track node that is not showing yet. */
  dropSubtitle() {
    this.subtitleDisplay = false;
    this.subtitleTrack = -1;
  }
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  trigger(event: string, data?: unknown) {
    this.handlers.get(event)?.forEach((handler) => handler(event, data));
  }
  loadSource() {}
  attachMedia() {}
  destroy() {}
  recoverMediaError() {}
}

jest.mock('hls.js', () => ({
  __esModule: true,
  default: function Hls() {
    return new MockHls();
  },
  Events: {
    MANIFEST_PARSED: 'hlsManifestParsed',
    AUDIO_TRACKS_UPDATED: 'hlsAudioTracksUpdated',
    AUDIO_TRACK_SWITCHED: 'hlsAudioTrackSwitched',
    SUBTITLE_TRACKS_UPDATED: 'hlsSubtitleTracksUpdated',
    SUBTITLE_TRACK_SWITCH: 'hlsSubtitleTrackSwitch',
    FRAG_LOADED: 'hlsFragLoaded',
    ERROR: 'hlsError',
  },
  ErrorTypes: { MEDIA_ERROR: 'mediaError' },
}));

function fakeVideo() {
  const target = () => Object.assign(new EventTarget(), { length: 0 });
  return Object.assign(new EventTarget(), {
    textTracks: target(),
    audioTracks: target(),
    muted: false,
    play: jest.fn(async () => undefined),
    pause: jest.fn(),
    load: jest.fn(),
    removeAttribute: jest.fn(),
    videoWidth: 1920,
    videoHeight: 1080,
  });
}

const engines: WebEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.release()));

function startedEngine() {
  const engine = new WebEngine();
  engines.push(engine);
  (engine as unknown as { attach(video: unknown): void }).attach(fakeVideo());
  engine.load({ uri: 'http://server.test/hls/master.m3u8', kind: 'hls' });
  const hls = MockHls.last!;
  hls.trigger('hlsManifestParsed');
  return { engine, hls };
}

const shown = (engine: WebEngine) =>
  engine.getSnapshot().tracks.subtitles.find((track) => track.selected)?.id ?? null;

describe('web engine (hls.js) keeps the subtitle the app picked', () => {
  it('re-selects the forced subtitle when hls.js switches it off after the start', () => {
    const { engine, hls } = startedEngine();
    engine.setSubtitleTrack('0');
    expect(shown(engine)).toBe('0');
    hls.dropSubtitle();
    expect(hls.subtitleTrack).toBe(0);
    expect(hls.subtitleDisplay).toBe(true);
    expect(shown(engine)).toBe('0');
  });

  it('keeps "off" when the app switched subtitles off', () => {
    const { engine, hls } = startedEngine();
    engine.setSubtitleTrack(null);
    hls.subtitleDisplay = true;
    hls.subtitleTrack = 2;
    expect(hls.subtitleTrack).toBe(-1);
    expect(shown(engine)).toBeNull();
  });

  it('gives up after a few re-selections instead of fighting hls.js forever', () => {
    const { engine, hls } = startedEngine();
    engine.setSubtitleTrack('1');
    for (let i = 0; i < 10; i++) hls.dropSubtitle();
    expect(hls.subtitleTrack).toBe(-1);
  });
});
