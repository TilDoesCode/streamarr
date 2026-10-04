import { WebEngine } from '@/player/engines/web-engine.web';
import type { EngineEvent } from '@/player/engines';

jest.mock('hls.js', () => ({
  __esModule: true,
  default: function Hls() {
    return {};
  },
  Events: {},
  ErrorTypes: {},
}));

type FakeTrack = { kind: string; label: string; language: string; mode: string };

/** A `<video>` in Safari's native HLS mode: currentTime, paused and text tracks under test control. */
function fakeVideo(textTracks: FakeTrack[] = [], frameCallbacks = true) {
  const list = Object.assign(new EventTarget(), { length: textTracks.length }, textTracks);
  const video = Object.assign(new EventTarget(), {
    textTracks: list,
    currentTime: 0,
    duration: 600,
    paused: true,
    ended: false,
    muted: false,
    seeking: false,
    buffered: { length: 0, end: () => 0 },
    videoWidth: 1920,
    videoHeight: 1080,
    play: jest.fn(async () => {
      video.paused = false;
      video.dispatchEvent(new Event('play'));
    }),
    pause: jest.fn(() => {
      video.paused = true;
      video.dispatchEvent(new Event('pause'));
    }),
    load: jest.fn(),
    removeAttribute: jest.fn(),
    readyState: 4,
    // Safari's native HLS (iOS 27 simulator) never calls it back.
    requestVideoFrameCallback: (done: () => void) => void (frameCallbacks && done()),
  });
  return video;
}

const engines: WebEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.release()));

function engineOn(video: ReturnType<typeof fakeVideo>) {
  const engine = new WebEngine();
  engines.push(engine);
  const internals = engine as unknown as { attach(video: unknown): void; mode: string };
  Object.defineProperty(engine, 'mode', { value: 'native' });
  internals.attach(video);
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  engine.load({ uri: 'http://server.test/master.m3u8', kind: 'hls' });
  return { engine, events };
}

describe('web engine (Safari native HLS)', () => {
  it('a seek moves the clock to the target at once (review S1: scrubber snapped back)', async () => {
    const video = fakeVideo();
    const { engine, events } = engineOn(video);
    await Promise.resolve();
    events.length = 0;
    engine.seek(720);
    expect(
      events
        .filter((event) => event.type === 'time')
        .map((event) => event.type === 'time' && event.position)
    ).toEqual([720]);
    expect(engine.getSnapshot().position).toBe(720);
  });

  it("lists Safari's forced-narrative text tracks as forced subtitles (BACKLOG)", () => {
    const video = fakeVideo([
      { kind: 'subtitles', label: 'Deutsch', language: 'de', mode: 'disabled' },
      { kind: 'forced', label: 'Deutsch (forced)', language: 'de', mode: 'showing' },
      { kind: 'metadata', label: 'id3', language: '', mode: 'hidden' },
    ]);
    const { engine } = engineOn(video);
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(engine.getSnapshot().tracks.subtitles).toEqual([
      { id: '0', label: 'Deutsch', language: 'de', selected: false },
      { id: '1', label: 'Deutsch (forced)', language: 'de', forced: true, selected: true },
    ]);
  });

  it('reports a pause and a resume from the system full-screen controls, not its own (BACKLOG)', async () => {
    const video = fakeVideo();
    const { engine, events } = engineOn(video);
    await Promise.resolve();
    const user = () => events.filter((event) => event.type === 'userPlayback');
    engine.pause();
    engine.play();
    await Promise.resolve();
    expect(user()).toEqual([]);
    video.paused = true;
    video.dispatchEvent(new Event('webkitendfullscreen'));
    expect(user()).toEqual([{ type: 'userPlayback', paused: true }]);
    video.paused = false;
    video.dispatchEvent(new Event('play'));
    expect(user()).toEqual([
      { type: 'userPlayback', paused: true },
      { type: 'userPlayback', paused: false },
    ]);
  });

  it('adopts a system play when the frame callback never fires (Safari native HLS, S4b)', async () => {
    const video = fakeVideo([], false);
    const { engine, events } = engineOn(video);
    await Promise.resolve();
    video.currentTime = 30.4;
    video.dispatchEvent(new Event('timeupdate'));
    expect(events.some((event) => event.type === 'firstFrame')).toBe(true);
    engine.pause();
    video.paused = false;
    video.dispatchEvent(new Event('play'));
    expect(events.filter((event) => event.type === 'userPlayback')).toEqual([
      { type: 'userPlayback', paused: false },
    ]);
  });
});
