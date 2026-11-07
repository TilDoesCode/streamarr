import { act, screen } from 'expo-router/testing-library';

import { ConnectivityMonitor, PROBE_TIMEOUT_MS } from '@/connectivity/monitor';

import { clearWorld, open, resetWorld, WAIT, world } from '../../../../jest/mylist-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

let answer: ((reachable: boolean) => void) | null = null;
beforeEach(async () => {
  await resetWorld();
  world.connectivity = true;
  world.mustChangePassword = true;
  answer = null;
  world.monitor = new ConnectivityMonitor({
    probe: () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  });
});
afterEach(clearWorld);

describe('a cold start owing a password change (C1-24)', () => {
  it('waits on the launch background for the first probe, then the server answers: the change', async () => {
    const { router } = await open('/');
    expect(await screen.findByTestId('launch-pending', {}, WAIT)).toBeTruthy();
    expect(screen.queryByTestId('change-password-screen')).toBeNull();
    await act(async () => answer!(true));
    await screen.findByTestId('change-password-screen', {}, WAIT);
    expect(router.getPathname()).toBe('/sign-in/change-password');
  });

  it('a probe that never answers holds the launch background no longer than its own timeout', async () => {
    await open('/');
    expect(await screen.findByTestId('launch-pending', {}, WAIT)).toBeTruthy();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    });
    expect(screen.getByTestId('launch-pending')).toBeTruthy();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
    await screen.findByTestId('change-password-screen', {}, WAIT);
  });
});
