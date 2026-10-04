import type { EngineEvent } from '@/player/engines';

import { VlcEngine } from '../engines/vlc-engine';

jest.mock('expo-libvlc-player', () => ({ LibVlcPlayerView: () => null }));

type Internals = {
  view: { current: unknown };
  onTime(seconds: number): void;
  setState(state: string): void;
  props: { get(): { nonce: number } };
};

function setup(stats: { displayedPictures: number } | null) {
  const engine = new VlcEngine();
  const internals = engine as unknown as Internals;
  const view = {
    getStats: jest.fn(async () => stats),
    seek: jest.fn(async () => undefined),
    play: jest.fn(async () => undefined),
    pause: jest.fn(async () => undefined),
  };
  internals.view.current = view;
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  engine.load({ uri: 'http://x/video.mkv', kind: 'progressive', startPosition: 10 });
  let clock = 10;
  const tick = async (seconds: number) => {
    for (let i = 0; i < seconds; i += 1) {
      clock += 1;
      internals.onTime(clock);
      internals.setState('playing');
      await jest.advanceTimersByTimeAsync(1000);
    }
  };
  internals.onTime(10.5);
  internals.setState('playing');
  return { engine, internals, view, events, tick };
}

describe('VlcEngine stall watchdog', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('leaves a picture that keeps advancing alone', async () => {
    const stats = { displayedPictures: 1 };
    const { view, tick, engine } = setup(stats);
    for (let i = 0; i < 8; i += 1) {
      stats.displayedPictures += 25;
      await tick(1);
    }
    expect(view.seek).not.toHaveBeenCalled();
    expect(engine.getSnapshot().stats.totalFrames).toBe(201);
    engine.release();
  });

  it('re-seeks, then reloads, then fails when the clock runs over a frozen picture', async () => {
    const { view, tick, internals, events, engine } = setup({ displayedPictures: 12 });
    const nonce = internals.props.get().nonce;
    await tick(5);
    expect(view.seek).toHaveBeenCalledTimes(1);
    await tick(6);
    expect(internals.props.get().nonce).toBe(nonce + 1);
    await tick(20);
    expect(events.some((event) => event.type === 'error')).toBe(true);
    engine.release();
  });

  it('ignores media without displayed pictures (audio only)', async () => {
    const { view, tick, engine } = setup({ displayedPictures: 0 });
    await tick(8);
    expect(view.seek).not.toHaveBeenCalled();
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
