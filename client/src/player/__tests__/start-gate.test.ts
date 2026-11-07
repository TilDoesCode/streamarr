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
