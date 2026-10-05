import type { EngineEvent } from '@/player/engines';

import { VlcEngine } from '../engines/vlc-engine';

jest.mock('expo-libvlc-player', () => ({ LibVlcPlayerView: () => null }));

type Internals = {
  view: { current: unknown };
  onTime(seconds: number): void;
  setState(state: string): void;
  props: { get(): { nonce: number; options: string[] } };
};

type Stats = Record<string, number>;

function setup(stats: Stats | null, options: ConstructorParameters<typeof VlcEngine>[0] = {}) {
  const engine = new VlcEngine(options);
  const internals = engine as unknown as Internals;
  const view = {
    getStats: jest.fn(async () => stats),
    seek: jest.fn(async () => undefined),
    play: jest.fn(async () => undefined),
    pause: jest.fn(async () => undefined),
    dismiss: jest.fn(async () => undefined),
  };
  internals.view.current = view;
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  engine.load({ uri: 'http://x/video.mkv', kind: 'progressive', startPosition: 10 });
  let clock = 10;
  const tick = (seconds: number) => {
    // libVLC time reports pass at most every 250 ms of wall clock.
    jest.setSystemTime(Date.now() + seconds * 1000);
    clock += seconds;
    internals.onTime(clock);
    internals.setState('playing');
  };
  internals.onTime(10.5);
  internals.setState('playing');
  return { engine, internals, view, events, tick };
}

describe('VlcEngine health probe (S7)', () => {
  it('reports libVLC statistics in the one health shape', async () => {
    const { engine } = setup({
      displayedPictures: 240,
      lostPictures: 3,
      decodedVideo: 250,
      decodedAudio: 400,
      playedAbuffers: 380,
      lostAbuffers: 0,
    });
    await expect(engine.readHealth()).resolves.toEqual({
      framesPresented: 240,
      framesDropped: 3,
      framesDecoded: 250,
      audioProgress: 380,
      readyForDisplay: true,
      hasVideoTrack: true,
      hasAudioTrack: true,
    });
    expect(engine.getSnapshot().stats.totalFrames).toBe(240);
    engine.release();
  });

  it('reports no picture yet while libVLC decodes without displaying (no displayedPictures > 0 gate)', async () => {
    const { engine } = setup({ displayedPictures: 0, decodedVideo: 90, decodedAudio: 0 });
    await expect(engine.readHealth()).resolves.toMatchObject({
      framesPresented: 0,
      readyForDisplay: false,
      audioProgress: undefined,
    });
    engine.release();
  });

  it('counts audio as silent when it is decoded but never played', async () => {
    const { engine } = setup({ displayedPictures: 50, decodedVideo: 50, decodedAudio: 80 });
    await expect(engine.readHealth()).resolves.toMatchObject({ audioProgress: 0 });
    engine.release();
  });

  it('a build without getStats reports nothing (no rule runs)', async () => {
    const { engine, internals } = setup(null);
    internals.view.current = { seek: jest.fn() };
    await expect(engine.readHealth()).resolves.toEqual({});
    engine.release();
  });
});

describe('VlcEngine direct rendering retry (D23)', () => {
  const platform = jest.requireActual<typeof import('react-native')>('react-native').Platform;
  const os = platform.OS;
  beforeEach(() => {
    platform.OS = 'android';
    jest.useFakeTimers();
  });
  afterEach(() => {
    platform.OS = os;
    jest.useRealTimers();
  });

  it('reloads once without MediaCodec direct rendering when decoded video never shows', async () => {
    const { engine, internals, tick } = setup(
      { displayedPictures: 0, decodedVideo: 120 },
      { directRendering: true }
    );
    expect(internals.props.get().options).toContain(':mediacodec-dr');
    const nonce = internals.props.get().nonce;
    tick(2);
    await engine.readHealth();
    expect(internals.props.get().nonce).toBe(nonce);
    tick(3);
    await engine.readHealth();
    expect(internals.props.get().nonce).toBe(nonce + 1);
    expect(internals.props.get().options).toContain(':no-mediacodec-dr');
    expect(engine.getSnapshot().state).toBe('loading');
    tick(6);
    await engine.readHealth();
    expect(internals.props.get().nonce).toBe(nonce + 1);
    engine.release();
  });

  it('leaves direct rendering on while pictures show', async () => {
    const { engine, internals, tick } = setup(
      { displayedPictures: 30, decodedVideo: 30 },
      { directRendering: true }
    );
    const nonce = internals.props.get().nonce;
    tick(8);
    await engine.readHealth();
    expect(internals.props.get().nonce).toBe(nonce);
    engine.release();
  });
});

describe('VlcEngine paused load', () => {
  it('defers a pause until the first picture at the start position', () => {
    const engine = new VlcEngine();
    const internals = engine as unknown as Internals;
    const view = { pause: jest.fn(async () => undefined), play: jest.fn(async () => undefined) };
    internals.view.current = view;
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive', startPosition: 40 });
    engine.pause();
    expect(view.pause).not.toHaveBeenCalled();
    internals.onTime(40);
    expect(view.pause).not.toHaveBeenCalled();
    internals.onTime(40.3);
    expect(view.pause).toHaveBeenCalledTimes(1);
    engine.pause();
    expect(view.pause).toHaveBeenCalledTimes(2);
    engine.release();
  });

  it('drops the deferred pause when play follows', () => {
    const engine = new VlcEngine();
    const internals = engine as unknown as Internals;
    const view = { pause: jest.fn(async () => undefined), play: jest.fn(async () => undefined) };
    internals.view.current = view;
    engine.load({ uri: 'http://x/video.mkv', kind: 'progressive', startPosition: 40 });
    engine.pause();
    engine.play();
    internals.onTime(40.3);
    expect(view.pause).not.toHaveBeenCalled();
    engine.release();
  });
});

describe('VlcEngine time events (Q1-25)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('passes at most four libVLC time reports a second to the clock', async () => {
    const { engine, internals, events } = setup({ displayedPictures: 1 });
    events.length = 0;
    for (let i = 1; i <= 20; i++) {
      internals.onTime(10.5 + i * 0.05);
      await jest.advanceTimersByTimeAsync(50);
    }
    expect(events.filter((event) => event.type === 'time').length).toBeLessThanOrEqual(4);
    engine.release();
  });
});
