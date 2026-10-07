import { lockPlayerLandscape } from '@/player/orientation';

const OrientationLock = { LANDSCAPE: 'landscape', PORTRAIT_UP: 'portrait-up' };
const Orientation = { PORTRAIT_UP: 1, LANDSCAPE_LEFT: 3 };

/** The screen turns `turnAfter` orientation reads after a portrait lock (iOS reports the turn asynchronously). */
function fake(turnAfter = 0) {
  const calls: string[] = [];
  let current = Orientation.PORTRAIT_UP;
  let reads = 0;
  const o = {
    OrientationLock,
    Orientation,
    lockAsync: async (lock: string) => {
      calls.push(`lock ${lock}`);
      if (lock === 'landscape') current = Orientation.LANDSCAPE_LEFT;
      else reads = 0;
    },
    unlockAsync: async () =>
      void calls.push(`unlock (${current === Orientation.PORTRAIT_UP ? 'portrait' : 'landscape'})`),
  } as unknown as Parameters<typeof lockPlayerLandscape>[0] extends Promise<infer T> ? T : never;
  // The window, not the module: expo-screen-orientation reports portrait before the window turned.
  const isPortrait = () => {
    if (current !== Orientation.PORTRAIT_UP && (reads += 1) > turnAfter) {
      current = Orientation.PORTRAIT_UP;
      calls.push('turned');
    }
    return current === Orientation.PORTRAIT_UP;
  };
  return { calls, o, isPortrait };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it('turns a portrait app back to portrait before freeing rotation', async () => {
  const { calls, o, isPortrait } = fake();
  const { release } = lockPlayerLandscape(Promise.resolve(o), true, isPortrait);
  await settle();
  release();
  await settle();
  expect(calls).toEqual(['lock landscape', 'lock portrait-up', 'turned', 'unlock (portrait)']);
});

it('only frees rotation when the app was landscape before the player', async () => {
  const { calls, o, isPortrait } = fake();
  const { release } = lockPlayerLandscape(Promise.resolve(o), false, isPortrait);
  await settle();
  release();
  await settle();
  expect(calls).toEqual(['lock landscape', 'unlock (landscape)']);
});

it('frees rotation only after the portrait turn was reported (iOS kept landscape otherwise)', async () => {
  jest.useFakeTimers();
  const { calls, o, isPortrait } = fake(3);
  const { release } = lockPlayerLandscape(Promise.resolve(o), true, isPortrait);
  await jest.advanceTimersByTimeAsync(0);
  release();
  await jest.advanceTimersByTimeAsync(1000);
  expect(calls).toEqual(['lock landscape', 'lock portrait-up', 'turned', 'unlock (portrait)']);
  jest.useRealTimers();
});

it('frees rotation after a timeout when the turn is never reported', async () => {
  jest.useFakeTimers();
  const { calls, o, isPortrait } = fake(1000);
  const { release } = lockPlayerLandscape(Promise.resolve(o), true, isPortrait);
  await jest.advanceTimersByTimeAsync(0);
  release();
  await jest.advanceTimersByTimeAsync(2000);
  expect(calls.at(-1)).toBe('unlock (landscape)');
  jest.useRealTimers();
});

it('restore turns a portrait app back and resolves before anything leaves; release afterwards only frees rotation, once (Q2-07)', async () => {
  const { calls, o, isPortrait } = fake();
  const lock = lockPlayerLandscape(Promise.resolve(o), true, isPortrait);
  await settle();
  await lock.restore();
  calls.push('navigate');
  lock.release();
  lock.release();
  await settle();
  expect(calls).toEqual([
    'lock landscape',
    'lock portrait-up',
    'turned',
    'navigate',
    'unlock (portrait)',
  ]);
});

it('a player that replaced this one (up-next) keeps landscape: the old one neither turns back nor unlocks (Q2-07)', async () => {
  const first = fake();
  const old = lockPlayerLandscape(Promise.resolve(first.o), true, first.isPortrait);
  await settle();
  lockPlayerLandscape(Promise.resolve(first.o), true, first.isPortrait);
  await settle();
  old.release();
  await settle();
  expect(first.calls).toEqual(['lock landscape', 'lock landscape']);
});
