import { fireEvent, screen, waitFor } from 'expo-router/testing-library';

import { ConnectivityMonitor } from '@/connectivity/monitor';

import { installOfflineLibrary, WORLD_OWNER } from '../../../../jest/downloads';
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

it('expands a series, deletes a season after confirmation and plays a download', async () => {
  const test = installOfflineLibrary();
  const { router } = await open('/');
  await screen.findByTestId('offline-screen', {}, WAIT);
  fireEvent.press(screen.getByTestId('download-series-tmdb-tv-1396-open'));
  await screen.findByTestId('download-tmdb-tv-1396-s02e02', {}, WAIT);

  fireEvent.press(screen.getByTestId('download-season-tmdb-tv-1396-s02-delete'));
  fireEvent.press(await screen.findByTestId('downloads-confirm-delete', {}, WAIT));
  await waitFor(
    () => expect(screen.queryByTestId('download-series-tmdb-tv-1396')).toBeNull(),
    WAIT
  );
  expect(test.store.forAccount(WORLD_OWNER).map((download) => download.workId)).toEqual([
    'tmdb-movie-603',
  ]);

  fireEvent.press(screen.getByTestId('download-tmdb-movie-603-open'));
  await waitFor(() => expect(router.getPathname()).toBe('/play/new'), WAIT);
  expect(router.getSearchParams()).toMatchObject({ workId: 'tmdb-movie-603', title: 'The Matrix' });
});
