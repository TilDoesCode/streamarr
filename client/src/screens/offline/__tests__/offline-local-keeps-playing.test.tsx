import { act, waitFor } from 'expo-router/testing-library';

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

it('C1-24: a player that is starting or plays a downloaded file stays when the server goes away', async () => {
  installOfflineLibrary();
  probe.healthy = true;
  const { router } = await open('/play/new?workId=tmdb-movie-603');
  await waitFor(() => expect(router.getPathname()).toBe('/play/new'), WAIT);
  probe.healthy = false;
  await act(() => world.monitor!.retry());
  expect(world.monitor!.offline).toBe(true);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(500);
  });
  expect(router.getPathname()).toBe('/play/new');
});
