import { screen } from 'expo-router/testing-library';

import { ConnectivityMonitor } from '@/connectivity/monitor';

import {
  fakeOfflineDownload,
  installTestDownloads,
  seedDownloads,
  WORLD_OWNER,
} from '../../../../jest/downloads';
import { clearWorld, open, resetWorld, WAIT, world } from '../../../../jest/mylist-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(async () => {
  await resetWorld();
  world.connectivity = true;
  world.monitor = new ConnectivityMonitor({ probe: async () => false });
});
afterEach(clearWorld);

it('a download blocked by the admin offers only Delete: no Retry, no Pause', async () => {
  const test = installTestDownloads();
  seedDownloads(test, [
    fakeOfflineDownload({
      id: 'd-blocked',
      accountKey: WORLD_OWNER,
      workId: 'tmdb-movie-133701',
      state: 'failed',
      bytesWritten: 2 * 1024 ** 2,
      sizeBytes: 12 * 1024 ** 2,
      error: { code: 'downloads_not_allowed', at: 1, status: 403, actions: ['remove'] },
      meta: { title: 'Tears of Steel' },
    }),
    fakeOfflineDownload({
      id: 'd-broken',
      accountKey: WORLD_OWNER,
      workId: 'tmdb-movie-10378',
      state: 'failed',
      bytesWritten: 1024 ** 2,
      sizeBytes: 9 * 1024 ** 2,
      error: { code: 'http', at: 1, status: 418, actions: ['retry'] },
      meta: { title: 'Big Buck Bunny' },
    }),
  ]);
  await open('/');
  await screen.findByTestId('offline-screen', {}, WAIT);
  expect(await screen.findByTestId('download-tmdb-movie-133701-delete', {}, WAIT)).toBeTruthy();
  expect(screen.queryByTestId('download-tmdb-movie-133701-retry')).toBeNull();
  expect(screen.queryByTestId('download-tmdb-movie-133701-pause')).toBeNull();
  // The list's short reason (DL-C2); the detail card shows the full sentence.
  expect(screen.getByText(/resumes on its own once allowed/)).toBeTruthy();
  // Another failure keeps its Retry, still no Pause.
  expect(screen.getByTestId('download-tmdb-movie-10378-retry')).toBeTruthy();
  expect(screen.queryByTestId('download-tmdb-movie-10378-pause')).toBeNull();
});
