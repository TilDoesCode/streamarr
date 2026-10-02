import { lockPlayerLandscape } from '@/player/orientation';

const OrientationLock = { LANDSCAPE: 'landscape', PORTRAIT_UP: 'portrait-up' };

function fake() {
  const calls: string[] = [];
  const o = {
    OrientationLock,
    lockAsync: async (lock: string) => void calls.push(`lock ${lock}`),
    unlockAsync: async () => void calls.push('unlock'),
  } as unknown as Parameters<typeof lockPlayerLandscape>[0] extends Promise<infer T> ? T : never;
  return { calls, o };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it('turns a portrait app back to portrait before freeing rotation', async () => {
  const { calls, o } = fake();
  const release = lockPlayerLandscape(Promise.resolve(o), true);
  await settle();
  release();
  await settle();
  expect(calls).toEqual(['lock landscape', 'lock portrait-up', 'unlock']);
});

it('only frees rotation when the app was landscape before the player', async () => {
  const { calls, o } = fake();
  const release = lockPlayerLandscape(Promise.resolve(o), false);
  await settle();
  release();
  await settle();
  expect(calls).toEqual(['lock landscape', 'unlock']);
});
