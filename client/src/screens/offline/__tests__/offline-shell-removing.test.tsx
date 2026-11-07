import { fireEvent, screen, waitFor } from 'expo-router/testing-library';

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

const MB = 1024 ** 2;
const WORK = 'tmdb-movie-10378';

beforeEach(async () => {
  await resetWorld();
  world.connectivity = true;
  world.monitor = new ConnectivityMonitor({ probe: async () => false });
});
afterEach(clearWorld);

it('a download being removed stays as a subdued row without actions until its transfer ended', async () => {
  const test = installTestDownloads();
  const relativePath = 'test/d-active/Big Buck Bunny.mkv';
  seedDownloads(test, [
    fakeOfflineDownload({
      id: 'd-active',
      accountKey: WORLD_OWNER,
      workId: WORK,
      state: 'downloading',
      relativePath,
      sizeBytes: 12 * MB,
      bytesWritten: 3 * MB,
      meta: { title: 'Big Buck Bunny' },
    }),
  ]);
  await test.engine.start({
    id: 'd-active',
    url: 'http://dev.test/api/v1/offline/cap-d-active',
    relativePath,
    expectedBytes: 12 * MB,
  });
  test.engine.controls.progress('d-active', 3 * MB);
  test.engine.controls.stallDrain('d-active');

  await open('/');
  await screen.findByTestId('offline-screen', {}, WAIT);
  fireEvent.press(await screen.findByTestId(`download-${WORK}-delete`, {}, WAIT));
  fireEvent.press(await screen.findByTestId('downloads-confirm-delete', {}, WAIT));
  const removedAt = Date.now();

  await waitFor(() => expect(screen.queryByTestId(`download-${WORK}-delete`)).toBeNull(), WAIT);
  expect(screen.getByTestId(`download-${WORK}`)).toBeTruthy();
  expect(screen.queryByTestId(`download-${WORK}-pause`)).toBeNull();
  expect(screen.queryByTestId(`download-${WORK}-open`)).toBeNull();
  expect(screen.getByText('In progress')).toBeTruthy();
  // Most removals are gone before a label could be read: it only shows after a moment.
  expect(screen.queryByText('Removing…')).toBeNull();
  expect(await screen.findByText('Removing…', {}, WAIT)).toBeTruthy();
  expect(Date.now() - removedAt).toBeGreaterThanOrEqual(550);
  expect(test.store.get('d-active')!.state).toBe('removing');

  test.engine.controls.releaseDrain('d-active');
  await waitFor(() => expect(screen.queryByTestId(`download-${WORK}`)).toBeNull(), {
    timeout: 5_000,
  });
  expect(test.store.get('d-active')).toBeUndefined();
  expect(await screen.findByTestId('downloads-empty', {}, WAIT)).toBeTruthy();
});
