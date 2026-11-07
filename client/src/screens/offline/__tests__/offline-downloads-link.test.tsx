import { act, screen, waitFor } from 'expo-router/testing-library';
import { router as navigate } from 'expo-router';

import { redirectSystemPath } from '@/app/+native-intent';
import { ConnectivityMonitor } from '@/connectivity/monitor';
import { routeFromUrl } from '@/navigation/title-link';

import { installOfflineLibrary } from '../../../../jest/downloads';
import { clearWorld, open, resetWorld, WAIT, world } from '../../../../jest/mylist-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

// One scenario per file: expo-router's test store does not survive a second render after leaving the shell.
beforeEach(async () => {
  await resetWorld();
  world.connectivity = true;
  world.monitor = new ConnectivityMonitor({ probe: async () => false });
});
afterEach(clearWorld);

it('the Downloads link lands in the offline shell with the downloads while the server is unreachable', async () => {
  const LINK = 'streamarr://downloads';
  installOfflineLibrary();
  expect(redirectSystemPath({ path: LINK, initial: true })).toBe(LINK);
  const { router } = await open(routeFromUrl(LINK));
  expect(await screen.findByTestId('offline-screen', {}, WAIT)).toBeOnTheScreen();
  expect(router.getPathname()).toBe('/offline');
  expect(screen.getByTestId('download-tmdb-movie-603')).toBeOnTheScreen();

  // A second tap while the shell is open keeps it (warm start).
  const path = redirectSystemPath({ path: LINK, initial: false });
  await act(async () => navigate.navigate(routeFromUrl(path!) as never));
  await waitFor(() => expect(router.getPathname()).toBe('/offline'), WAIT);
  expect(screen.getByTestId('offline-screen')).toBeOnTheScreen();
  expect(screen.getByTestId('download-tmdb-movie-603')).toBeOnTheScreen();
});
