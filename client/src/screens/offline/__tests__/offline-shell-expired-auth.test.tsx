import { screen } from 'expo-router/testing-library';

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

it('C1-24: a cold start with an expired access token and no server still opens the profile downloads', async () => {
  world.expiredAccess = true;
  installOfflineLibrary();
  const { router } = await open('/');
  await screen.findByTestId('offline-screen', {}, WAIT);
  expect(router.getPathname()).toBe('/offline');
  expect(screen.getByTestId('download-tmdb-movie-603')).toBeTruthy();
});
