import { fireEvent, screen, waitFor } from 'expo-router/testing-library';

import { ConnectivityMonitor } from '@/connectivity/monitor';

import { installOfflineLibrary } from '../../../../jest/downloads';
import { clearWorld, open, resetWorld, WAIT, world } from '../../../../jest/mylist-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

// One scenario per file: expo-router's test store does not survive a second render after leaving the shell.
const probe = { healthy: false };
beforeEach(async () => {
  await resetWorld();
  world.connectivity = true;
  probe.healthy = false;
  world.monitor = new ConnectivityMonitor({ probe: async () => probe.healthy });
});
afterEach(clearWorld);

it("opens on the active profile's downloads when the server does not answer, and returns once it does", async () => {
  installOfflineLibrary();
  const { router } = await open('/');
  await screen.findByTestId('offline-screen', {}, WAIT);
  expect(router.getPathname()).toBe('/offline');
  expect(screen.getByTestId('offline-banner-title')).toHaveTextContent('Server not reachable');
  expect(screen.getByTestId('download-tmdb-movie-603')).toBeTruthy();
  expect(screen.getByTestId('download-series-tmdb-tv-1396')).toBeTruthy();
  expect(screen.queryByTestId('download-tmdb-movie-999')).toBeNull();

  probe.healthy = true;
  fireEvent.press(screen.getByTestId('offline-retry'));
  await waitFor(() => expect(router.getPathname()).toBe('/'), WAIT);
});
