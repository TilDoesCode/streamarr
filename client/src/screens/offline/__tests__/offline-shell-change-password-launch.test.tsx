import { act, screen, waitFor } from 'expo-router/testing-library';

import { ConnectivityMonitor } from '@/connectivity/monitor';

import { installOfflineLibrary } from '../../../../jest/downloads';
import { clearWorld, open, resetWorld, WAIT, world } from '../../../../jest/mylist-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

/** Every render of the change-password screen, also one that only redirects (a frame on the device). */
const mockRenders = { change: 0 };
jest.mock('@/screens/onboarding/password-screens', () => {
  const actual = jest.requireActual('@/screens/onboarding/password-screens');
  const React = jest.requireActual('react');
  return {
    ...actual,
    ChangePasswordScreen: (props: object) => {
      mockRenders.change += 1;
      return React.createElement(actual.ChangePasswordScreen, props);
    },
  };
});

// One scenario per file: expo-router's test store does not survive a second render after leaving the shell.
let answer: ((reachable: boolean) => void) | null = null;
beforeEach(async () => {
  await resetWorld();
  mockRenders.change = 0;
  world.connectivity = true;
  world.mustChangePassword = true;
  // The first probe hangs until the test answers it; later ones say the server is down.
  answer = null;
  let first = true;
  world.monitor = new ConnectivityMonitor({
    probe: () => {
      if (!first) return Promise.resolve(false);
      first = false;
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    },
  });
});
afterEach(clearWorld);

it('C1-24: a cold start owing a password change never shows a frame of it while the server is down', async () => {
  installOfflineLibrary();
  await open('/');
  // The first probe is still out: the launch background, neither the change nor the shell.
  expect(await screen.findByTestId('launch-pending', {}, WAIT)).toBeTruthy();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(2_000);
  });
  expect(screen.getByTestId('launch-pending')).toBeTruthy();
  expect(mockRenders.change).toBe(0);

  // The server does not answer: the offline shell, still no frame of the change.
  await act(async () => answer!(false));
  await screen.findByTestId('offline-screen', {}, WAIT);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(60_000);
  });
  expect(screen.queryByTestId('launch-pending')).toBeNull();
  expect(mockRenders.change).toBe(0);
  await waitFor(() => expect(world.monitor!.offline).toBe(true));
});
