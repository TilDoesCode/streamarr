import { act, waitFor } from 'expo-router/testing-library';

import { ConnectivityMonitor } from '@/connectivity/monitor';
import { holdStreamPlayback } from '@/connectivity/stream-playback';

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

it('C1-24: losing the server during a stream leaves the player for the offline shell', async () => {
  installOfflineLibrary();
  probe.healthy = true;
  const { router } = await open('/play/new?workId=tmdb-movie-603');
  await waitFor(() => expect(router.getPathname()).toBe('/play/new'), WAIT);
  const release = holdStreamPlayback();
  try {
    probe.healthy = false;
    await act(() => world.monitor!.retry());
    await waitFor(() => expect(router.getPathname()).toBe('/offline'), WAIT);
  } finally {
    release();
  }
});
