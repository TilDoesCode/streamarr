import { render } from '@testing-library/react-native';

import type { EngineEvent } from '@/player/engines';
import { ExpoVideoEngine } from '@/player/engines/expo-video-engine';
import { VlcEngine } from '@/player/engines/vlc-engine';
import { loadHls, WebEngine } from '@/player/engines/web-engine.web';
import { classify } from '@/player/recovery/classify';
import {
  FakeExpoPlayer,
  FakeHls,
  FakeVideoElement,
  FakeVlcView,
} from '@/../jest/player/library-fakes';

jest.mock('hls.js', () => jest.requireActual('@/../jest/player/library-fakes').hlsJsModule());
jest.mock('expo-video', () =>
  jest.requireActual('@/../jest/player/library-fakes').expoVideoModule()
);
jest.mock('expo-libvlc-player', () =>
  jest.requireActual('@/../jest/player/library-fakes').vlcModule()
);

const errors = (events: EngineEvent[]) =>
  events.flatMap((event) => (event.type === 'error' ? [event.reason] : []));

function record(engine: { subscribe(listener: (event: EngineEvent) => void): () => void }) {
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  return events;
}

const released: { release(): void }[] = [];
afterEach(() => released.splice(0).forEach((engine) => engine.release()));

describe('scriptable library fakes drive the real engines (state-matrix § 2 d.1)', () => {
  it('hls.js: fatal network errors reach the controller, media errors are recovered', async () => {
    const engine = new WebEngine();
    released.push(engine);
    (engine as unknown as { attach(video: unknown): void }).attach(new FakeVideoElement());
    await loadHls();
    const events = record(engine);
    engine.load({ uri: 'http://server.test/master.m3u8', kind: 'hls' });
    const hls = FakeHls.last;
    expect(hls.source).toBe('http://server.test/master.m3u8');
    hls.error('mediaError', 'bufferAppendError');
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(1);
    hls.error('networkError', 'fragLoadError', { fatal: false, status: 404 });
    expect(errors(events)).toEqual([]);
    hls.error('networkError', 'fragLoadError', { status: 404 });
    expect(errors(events)).toEqual(['networkError:fragLoadError']);
    expect(classify({ kind: 'engine', engine: 'web', reason: errors(events)[0]! })).toMatchObject({
      category: 'T1',
    });
    expect(
      classify({ kind: 'engine', engine: 'web', reason: errors(events)[0]!, status: 404 })
    ).toMatchObject({ category: 'T2', code: 'unknown_transcode' });
  });

  it('<video>: MediaError codes become error events with a category', async () => {
    const fetchMock = jest.fn(async () => ({ status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const engine = new WebEngine();
    released.push(engine);
    const video = new FakeVideoElement();
    Object.defineProperty(engine, 'mode', { value: 'native' });
    (engine as unknown as { attach(video: unknown): void }).attach(video);
    const events = record(engine);
    engine.load({ uri: 'http://server.test/a.mkv', kind: 'progressive' });
    video.present();
    video.tick(1);
    video.fire('waiting');
    expect(events).toContainEqual({ type: 'buffering', buffering: true });
    video.fail(3, 'PIPELINE_ERROR_DECODE: video decode failed');
    video.fail(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledWith('http://server.test/a.mkv', { method: 'HEAD' });
    const failures = events.flatMap((event) => (event.type === 'error' ? [event] : []));
    expect(failures.map((event) => event.reason)).toEqual([
      'PIPELINE_ERROR_DECODE: video decode failed',
      'media_error_2',
    ]);
    expect(
      failures.map((event) => classify({ kind: 'engine', engine: 'web', ...event }).category)
    ).toEqual(['T7', 'T2']);
  });

  it('expo-video: a failed item and a rejected replace classify by message', async () => {
    const engine = new ExpoVideoEngine();
    released.push(engine);
    const events = record(engine);
    engine.load({ uri: 'https://server.test/v.m3u8', kind: 'hls' });
    const player = FakeExpoPlayer.last;
    player.loaded();
    await Promise.resolve();
    player.failWith({
      message: 'A playback exception has occurred: Source error … Response code: 410',
    });
    player.failWith({
      message: 'The operation couldn’t be completed. (CoreMediaErrorDomain error -12927.)',
    });
    const reasons = errors(events);
    expect(reasons).toHaveLength(2);
    expect(
      reasons.map((reason) => classify({ kind: 'engine', engine: 'expo-video', reason }))
    ).toEqual([
      expect.objectContaining({ category: 'T2', code: 'session_closed' }),
      expect.objectContaining({ category: 'T7', code: 'decode_error' }),
    ]);
  });

  it('VLC: an encountered error reaches the engine events', async () => {
    FakeVlcView.reset();
    const engine = new VlcEngine();
    released.push(engine);
    const events = record(engine);
    engine.load({ uri: 'http://server.test/a.mkv', kind: 'progressive' });
    await render(<engine.Surface />);
    expect(FakeVlcView.props?.source).toBeTruthy();
    FakeVlcView.call('onEncounteredError', { message: 'VLC is unable to open the MRL' });
    expect(errors(events)).toEqual(['VLC is unable to open the MRL']);
    expect(
      classify({ kind: 'engine', engine: 'vlc', reason: 'VLC is unable to open the MRL' })
    ).toMatchObject({ category: 'T7', code: 'vlc_error' });
  });
});
