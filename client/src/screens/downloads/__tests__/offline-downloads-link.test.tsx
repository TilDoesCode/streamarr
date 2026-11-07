import { router as navigate } from 'expo-router';
import { act, screen, waitFor } from 'expo-router/testing-library';

import { redirectSystemPath } from '@/app/+native-intent';
import { ConnectivityMonitor } from '@/connectivity/monitor';
import { routeFromUrl } from '@/navigation/title-link';

import { installOfflineLibrary } from '../../../../jest/downloads';
import { clearWorld, open, resetWorld, WAIT, world } from '../../../../jest/mylist-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

afterEach(clearWorld);

// DL-C verify 2, the verifier's offline-link coverage as a regular test.
it('cold and warm Downloads links while offline land in the active profile’s offline library', async () => {
  await resetWorld();
  world.connectivity = true;
  world.monitor = new ConnectivityMonitor({ probe: async () => false });
  installOfflineLibrary();
  const link = 'streamarr://downloads';
  const cold = redirectSystemPath({ path: link, initial: true });
  const { router } = await open(routeFromUrl(cold!));
  await screen.findByTestId('offline-screen', {}, WAIT);
  expect(router.getPathname()).toBe('/offline');
  expect(screen.getByTestId('download-tmdb-movie-603')).toBeTruthy();
  // Another profile's download never shows.
  expect(screen.queryByTestId('download-tmdb-movie-999')).toBeNull();
  const warm = redirectSystemPath({ path: link, initial: false });
  await act(async () => navigate.navigate(routeFromUrl(warm!) as never));
  await waitFor(() => expect(router.getPathname()).toBe('/offline'), WAIT);
  expect(screen.getByTestId('download-tmdb-movie-603')).toBeTruthy();
});
