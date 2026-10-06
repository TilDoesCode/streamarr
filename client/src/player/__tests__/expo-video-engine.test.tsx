import { act, render } from '@testing-library/react-native';

import { ExpoVideoEngine } from '../engines/expo-video-engine';

type Listener = (event: Record<string, unknown>) => void;

// A fake expo-video mockPlayer that records seeks and play/pause in call order.
class FakePlayer {
  calls: string[] = [];
  status = 'idle';
  playing = false;
  listeners = new Map<string, Listener[]>();
  resolveReplace: () => void = () => undefined;
  availableAudioTracks = [];
  availableSubtitleTracks = [];
  audioTrack = null;
  subtitleTrack = null;
  videoTrack = null;
  duration = 600;
  timeUpdateEventInterval = 0;
  set currentTime(value: number) {
    this.calls.push(`seek ${value}`);
  }
  addListener(name: string, listener: Listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    return { remove: () => undefined };
  }
  replaceAsync() {
    return new Promise<void>((resolve) => (this.resolveReplace = resolve));
  }
  play() {
    this.calls.push('play');
  }
  pause() {
    this.calls.push('pause');
  }
  release() {}
  fire(name: string, event: Record<string, unknown>) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  ready() {
    this.status = 'readyToPlay';
    this.fire('statusChange', { status: 'readyToPlay' });
  }
}

let mockPlayer: FakePlayer;
jest.mock('expo-video', () => ({
  createVideoPlayer: () => mockPlayer,
  VideoView: () => null,
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function engineWith(startPosition?: number) {
  mockPlayer = new FakePlayer();
  const engine = new ExpoVideoEngine();
  engine.load({ uri: 'https://dev.test/v.m3u8', kind: 'hls', startPosition });
  return engine;
}

it('plays as soon as the source is loaded when there is no start position', async () => {
  engineWith(0);
  mockPlayer.resolveReplace();
  await flush();
  expect(mockPlayer.calls).toEqual(['play']);
});

it('waits for readyToPlay, seeks to the start, then plays', async () => {
  engineWith(96);
  mockPlayer.resolveReplace();
  await flush();
  expect(mockPlayer.calls).toEqual([]);
  mockPlayer.ready();
  expect(mockPlayer.calls).toEqual(['seek 96', 'play']);
});

it('applies the start when readyToPlay came before the source finished loading', async () => {
  engineWith(96);
  mockPlayer.ready();
  expect(mockPlayer.calls).toEqual([]);
  mockPlayer.resolveReplace();
  await flush();
  expect(mockPlayer.calls).toEqual(['seek 96', 'play']);
});

it('holds play() until the start landed and plays once', async () => {
  const engine = engineWith(96);
  engine.play();
  mockPlayer.resolveReplace();
  await flush();
  expect(mockPlayer.calls).toEqual([]);
  mockPlayer.ready();
  expect(mockPlayer.calls).toEqual(['seek 96', 'play']);
});

it('keeps a pause from before readyToPlay: seeks but does not play', async () => {
  const engine = engineWith(96);
  engine.pause();
  mockPlayer.resolveReplace();
  await flush();
  mockPlayer.ready();
  expect(mockPlayer.calls).toEqual(['pause', 'seek 96']);
});

it('posts time events twice a second while playing and none while paused (Q1-25)', () => {
  const engine = engineWith(0);
  expect(mockPlayer.timeUpdateEventInterval).toBe(0.5);
  mockPlayer.ready();
  mockPlayer.fire('playingChange', { isPlaying: false });
  expect(mockPlayer.timeUpdateEventInterval).toBe(0);
  mockPlayer.fire('playingChange', { isPlaying: true });
  expect(mockPlayer.timeUpdateEventInterval).toBe(0.5);
  engine.release();
});

it('a seek while paused still moves the clock without time events', () => {
  const engine = engineWith(0);
  mockPlayer.ready();
  const times: number[] = [];
  engine.subscribe((event) => {
    if (event.type === 'time') times.push(event.position);
  });
  engine.seek(120);
  expect(times).toEqual([120]);
  expect(engine.getSnapshot().position).toBe(120);
  engine.release();
});

it('a seek while playing moves the clock at once instead of after the next time event (review S1)', () => {
  const engine = engineWith(0);
  mockPlayer.ready();
  mockPlayer.playing = true;
  const times: number[] = [];
  engine.subscribe((event) => {
    if (event.type === 'time') times.push(event.position);
  });
  engine.seek(720);
  expect(times).toEqual([720]);
  engine.release();
});

it('an expo-video build without the S6 patch reports no health, so no watchdog rule runs', async () => {
  const engine = engineWith(0);
  await expect(engine.readHealth()).resolves.toEqual({});
  engine.release();
});

describe('start cover (S9b: the new item\'s frame 0 must not show under "Resuming at …")', () => {
  const covered = (engine: ExpoVideoEngine) =>
    (engine as unknown as { cover: { get(): { covered: boolean } } }).cover.get().covered;

  it('stays black from the load until the clock reached the start position', async () => {
    const engine = engineWith(41);
    expect(covered(engine)).toBe(true);
    const { queryByTestId } = await render(<engine.Surface />);
    expect(queryByTestId('engine-start-cover')).not.toBeNull();
    mockPlayer.resolveReplace();
    await flush();
    mockPlayer.ready();
    expect(mockPlayer.calls).toEqual(['seek 41', 'play']);
    mockPlayer.fire('timeUpdate', { currentTime: 0.2, bufferedPosition: 0 });
    expect(covered(engine)).toBe(true);
    await act(async () =>
      mockPlayer.fire('timeUpdate', { currentTime: 41.1, bufferedPosition: 50 })
    );
    expect(covered(engine)).toBe(false);
    expect(queryByTestId('engine-start-cover')).toBeNull();
    engine.release();
  });

  it('never covers a start from the beginning', () => {
    const engine = engineWith(0);
    expect(covered(engine)).toBe(false);
    engine.release();
  });

  it('a paused start shows the seeked frame at once (no time event follows)', async () => {
    const engine = engineWith(41);
    engine.pause();
    mockPlayer.resolveReplace();
    await flush();
    mockPlayer.ready();
    expect(covered(engine)).toBe(false);
    engine.release();
  });

  it('a viewer seek ends the cover', () => {
    const engine = engineWith(41);
    engine.seek(80);
    expect(covered(engine)).toBe(false);
    engine.release();
  });
});
