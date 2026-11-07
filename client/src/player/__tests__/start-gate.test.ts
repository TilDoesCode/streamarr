import { harness, newController, reply } from '@/../jest/player/harness';
import { FakeExpoPlayer } from '@/../jest/player/library-fakes';
import { record } from '@/../jest/player/native';
import { settle, TICKS } from '@/../jest/player/play';
import type { PlaybackController } from '@/player/controller';
import { ExpoVideoEngine } from '@/player/engines/expo-video-engine';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());
jest.mock('expo-video', () =>
  jest.requireActual('@/../jest/player/library-fakes').expoVideoModule()
);

beforeEach(() => {
  harness.reset();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

const HEARTBEAT = 10_000;
const ENGINES = ['expo-video', 'vlc'] as const;

/** A stream resumed at `at` ("Resume" answered); the engine loads there and has reported nothing yet. */
async function resumed(at: number, engine: (typeof ENGINES)[number]): Promise<PlaybackController> {
  const playback = harness.server.playback({ resumePositionTicks: at * TICKS } as never);
  harness.server.answer('start', reply.ok(engine === 'vlc' ? { ...playback, engine } : playback));
  const c = newController({ startSeconds: undefined });
  const started = c.start();
  await settle();
  c.chooseStart(true);
  await started;
  expect(harness.engine.kind).toBe(engine);
  return c;
}

/** The engine shows its first frame and plays; its clock says `position`. */
function plays(position: number): void {
  harness.engine.emit({ type: 'firstFrame' });
  harness.engine.state('playing');
  harness.engine.time(position, 600);
}

const progress = () =>
  harness.server
    .sent('progress')
    .map((request) => ({
      event: request.body?.event,
      at: Number(request.body?.positionTicks) / TICKS,
    }))
    .filter((report) => report.event !== 'start');

/** A stream's start counts only once it landed within ±3 s of its target, as the engines' start checks do. */
describe('streaming start gate: a start lands only within ±3 s of its target', () => {
  it.each(ENGINES)(
    '%s: a stale far-above reading is never reported; reports start at the landing',
    async (engine) => {
      const c = await resumed(100, engine);
      plays(400);
      await jest.advanceTimersByTimeAsync(HEARTBEAT);
      expect(progress()).toEqual([]);
      expect(c.position).toBe(100);
      expect(c.resumePosition).toBe(100);

      harness.engine.time(100.4, 600);
      harness.engine.time(101.4, 600);
      await jest.advanceTimersByTimeAsync(HEARTBEAT);
      expect(progress()).toEqual([{ event: 'progress', at: 101.4 }]);
      await c.stop();
      expect(progress().at(-1)?.at).toBeCloseTo(101.4, 1);
    }
  );

  it.each(ENGINES)('%s: a stale reading at stop keeps the chosen position', async (engine) => {
    const c = await resumed(100, engine);
    plays(400);
    await c.stop();
    expect(progress().map((report) => report.at)).not.toContain(400);
    expect(harness.server.sent('progress').at(-1)?.body?.positionTicks).toBe(100 * TICKS);
  });

  it.each(ENGINES)(
    '%s: a normal start (100 → 103 → 110) reports as it plays on',
    async (engine) => {
      const c = await resumed(100, engine);
      plays(100);
      harness.engine.time(103, 600);
      await jest.advanceTimersByTimeAsync(HEARTBEAT);
      harness.engine.time(110, 600);
      await jest.advanceTimersByTimeAsync(HEARTBEAT);
      expect(progress()).toEqual([
        { event: 'progress', at: 103 },
        { event: 'progress', at: 110 },
      ]);
      expect(c.position).toBe(110);
      await c.stop();
    }
  );

  it.each(ENGINES)('%s: a reading 3 s past the target is the landing', async (engine) => {
    const c = await resumed(100, engine);
    plays(103);
    await jest.advanceTimersByTimeAsync(HEARTBEAT);
    expect(progress()).toEqual([{ event: 'progress', at: 103 }]);
    await c.stop();
  });

  it.each(ENGINES)(
    '%s: a viewer seek during an unlanded start counts at its own target',
    async (engine) => {
      const c = await resumed(100, engine);
      plays(400);
      c.seekTo(40);
      harness.engine.time(41, 600);
      await jest.advanceTimersByTimeAsync(HEARTBEAT);
      expect(progress()).toEqual([{ event: 'progress', at: 41 }]);
      await c.stop();
    }
  );

  it.each(ENGINES)('%s: "From the beginning" counts from 0', async (engine) => {
    const playback = harness.server.playback({ resumePositionTicks: 100 * TICKS } as never);
    harness.server.answer('start', reply.ok(engine === 'vlc' ? { ...playback, engine } : playback));
    const c = newController({ startSeconds: undefined });
    const started = c.start();
    await settle();
    c.chooseStart(false);
    await started;
    plays(0.5);
    harness.engine.time(2, 600);
    await jest.advanceTimersByTimeAsync(HEARTBEAT);
    expect(progress()).toEqual([{ event: 'progress', at: 2 }]);
    await c.stop();
  });
});

/** expo-video's start check gives up on stale readings, then the seek lands late (c4a64a64 keeps uncovering then). */
describe('a given-up start check with a late landing (real expo-video engine → controller)', () => {
  const covered = (engine: ExpoVideoEngine) =>
    (engine as unknown as { cover: { get(): { covered: boolean } } }).cover.get().covered;

  async function realEngineAt(target: number) {
    const engine = new ExpoVideoEngine();
    const recorded = record(engine);
    engine.load({ uri: 'http://server/media.m3u8', kind: 'hls', startPosition: target });
    const player = FakeExpoPlayer.last;
    player.loaded();
    await Promise.resolve();
    player.ready();
    player.setPlaying(true);
    return { engine, player, recorded };
  }

  it.each([
    ['below (the item sits at 0:00)', 0.4],
    ['far above (the old place)', 400],
  ])(
    'stale readings %s: nothing is reported before the landing, the landing uncovers and reports',
    async (_, stale) => {
      const c = await resumed(148, 'expo-video');
      const { engine, player, recorded } = await realEngineAt(148);
      for (let tick = 0; tick < 12; tick++)
        player.fire('timeUpdate', { currentTime: stale, bufferedPosition: 0 });
      expect(player.calls.filter((call) => call.startsWith('seek'))).toEqual([
        'seek 148',
        'seek 148',
      ]);
      recorded.replay();
      // The native surface renders frames under the cover (onFirstFrameRender).
      harness.engine.emit({ type: 'firstFrame' });
      await jest.advanceTimersByTimeAsync(HEARTBEAT);
      expect(progress()).toEqual([]);
      expect(c.resumePosition).toBe(148);

      player.fire('timeUpdate', { currentTime: 150.2, bufferedPosition: 160 });
      expect(covered(engine)).toBe(false);
      player.fire('timeUpdate', { currentTime: 151.2, bufferedPosition: 160 });
      recorded.replay();
      await jest.advanceTimersByTimeAsync(HEARTBEAT);
      expect(progress()).toEqual([{ event: 'progress', at: 151.2 }]);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      engine.release();
      await c.stop();
    }
  );
});

/** An engine that lands past the ±3 s window (libVLC on a keyframe): 5 s of normal-speed playback open the gate. */
describe('start gate fallback: playback that plays on past its target', () => {
  let info: jest.SpyInstance;
  beforeEach(() => {
    info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => info.mockRestore());

  const opened = () =>
    info.mock.calls.filter(([line]) => String(line).startsWith('[player] start gate opened'));

  /** One reading a second: the wall clock moves 1 s, then the engine reports `position`. */
  async function second(position: number): Promise<void> {
    await jest.advanceTimersByTimeAsync(1_000);
    harness.engine.time(position, 600);
  }

  it.each(ENGINES)(
    '%s: lands at 106, plays 106 → 111 over 5 s: opens at 111 and reports from there',
    async (engine) => {
      const c = await resumed(100, engine);
      plays(106);
      for (const position of [107, 108, 109, 110]) await second(position);
      expect(c.resumePosition).toBe(100);
      expect(opened()).toEqual([]);
      await second(111);
      expect(c.resumePosition).toBe(111);
      expect(opened()).toEqual([
        ['[player] start gate opened by playback at 111.0 s, target 100.0 s'],
      ]);
      await jest.advanceTimersByTimeAsync(HEARTBEAT);
      expect(progress()).toEqual([{ event: 'progress', at: 111 }]);
      await c.stop();
      expect(opened()).toHaveLength(1);
    }
  );

  it.each(ENGINES)('%s: a stale 400 that does not advance never opens', async (engine) => {
    const c = await resumed(100, engine);
    plays(400);
    for (let tick = 0; tick < 30; tick++) await second(400);
    expect(progress()).toEqual([]);
    expect(c.resumePosition).toBe(100);
    expect(opened()).toEqual([]);
    await c.stop();
  });

  it.each(ENGINES)(
    '%s: a clock that advances faster than playback (jumping) never opens',
    async (engine) => {
      const c = await resumed(100, engine);
      plays(106);
      for (let tick = 1; tick <= 20; tick++) await second(106 + tick * 4);
      expect(progress()).toEqual([]);
      expect(c.resumePosition).toBe(100);
      expect(opened()).toEqual([]);
      await c.stop();
    }
  );

  it.each(ENGINES)('%s: readings while paused do not count toward the 5 s', async (engine) => {
    const c = await resumed(100, engine);
    plays(106);
    for (const position of [107, 108, 109]) await second(position);
    // The engine still reports a moment after the pause (libVLC, Android): advancing, but not playing.
    c.setPaused(true);
    harness.engine.state('paused');
    for (const position of [110, 111]) await second(position);
    expect(opened()).toEqual([]);
    c.setPaused(false);
    harness.engine.state('playing');
    for (const position of [112, 113, 114, 115, 116]) await second(position);
    expect(opened()).toEqual([]);
    await second(117);
    expect(opened()).toEqual([
      ['[player] start gate opened by playback at 117.0 s, target 100.0 s'],
    ]);
    expect(c.resumePosition).toBe(117);
    await c.stop();
  });

  it.each(ENGINES)('%s: readings while buffering do not count toward the 5 s', async (engine) => {
    const c = await resumed(100, engine);
    plays(106);
    for (const position of [107, 108]) await second(position);
    harness.engine.state('buffering');
    for (const position of [109, 110, 111]) await second(position);
    expect(opened()).toEqual([]);
    harness.engine.state('playing');
    let position = 111;
    while (!opened().length && position < 130) await second(++position);
    // At least 5 s of playing readings after the buffering, never the 5 s since 106.
    expect(position).toBeGreaterThanOrEqual(117);
    expect(c.resumePosition).toBe(position);
    await c.stop();
  });

  it.each(ENGINES)(
    '%s: nothing counts while the engine still handles its own start seek',
    async (engine) => {
      const c = await resumed(100, engine);
      let settled = false;
      Object.assign(harness.engine, { startSettled: () => settled });
      plays(106);
      for (let tick = 1; tick <= 8; tick++) await second(106 + tick);
      expect(opened()).toEqual([]);
      settled = true;
      for (let tick = 9; tick <= 13; tick++) await second(106 + tick);
      expect(opened()).toEqual([]);
      await second(120);
      expect(opened()).toEqual([
        ['[player] start gate opened by playback at 120.0 s, target 100.0 s'],
      ]);
      await c.stop();
    }
  );

  it.each(ENGINES)(
    '%s: playback that runs below the target (a dropped start seek) never opens',
    async (engine) => {
      const c = await resumed(100, engine);
      plays(0.5);
      for (let tick = 1; tick <= 20; tick++) await second(0.5 + tick);
      expect(progress()).toEqual([]);
      expect(c.resumePosition).toBe(100);
      expect(opened()).toEqual([]);
      await c.stop();
    }
  );

  it.each(ENGINES)(
    '%s: the landing within ±3 s still opens at once, without the fallback',
    async (engine) => {
      const c = await resumed(100, engine);
      plays(102.5);
      expect(c.resumePosition).toBe(102.5);
      await jest.advanceTimersByTimeAsync(HEARTBEAT);
      expect(progress()).toEqual([{ event: 'progress', at: 102.5 }]);
      expect(opened()).toEqual([]);
      await c.stop();
    }
  );
});
