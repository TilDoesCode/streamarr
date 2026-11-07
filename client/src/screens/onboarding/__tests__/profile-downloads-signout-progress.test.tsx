import { userEvent } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import {
  fakeOfflineDownload,
  installOfflineLibrary,
  seedDownloads,
  WORLD_OWNER,
} from '../../../../jest/downloads';
import {
  clearWorld,
  noContent,
  open,
  resetWorld,
  WAIT,
  world,
} from '../../../../jest/mylist-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const MB = 1024 ** 2;

beforeEach(async () => {
  await resetWorld();
  world.handlers['POST /api/v1/viewer/auth/logout'] = () => noContent();
});
afterEach(clearWorld);

it('"Delete downloads" shows progress only while the server is told; a transfer still ending never holds up the sign-out', async () => {
  const user = userEvent.setup();
  const test = installOfflineLibrary();
  const relativePath = 'test/d-running/Big Buck Bunny.mkv';
  seedDownloads(test, [
    fakeOfflineDownload({
      id: 'd-running',
      accountKey: WORLD_OWNER,
      workId: 'tmdb-movie-10378',
      state: 'downloading',
      relativePath,
      sizeBytes: 12 * MB,
      bytesWritten: 3 * MB,
      meta: { title: 'Big Buck Bunny' },
    }),
  ]);
  await test.engine.start({
    id: 'd-running',
    url: 'http://dev.test/api/v1/offline/cap-d-running',
    relativePath,
    expectedBytes: 12 * MB,
  });
  test.engine.controls.progress('d-running', 3 * MB);
  test.engine.controls.stallDrain('d-running');
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  for (const id of ['d-movie', 'd-e1', 'd-e2', 'd-running'])
    world.handlers[`DELETE /api/v1/viewer/downloads/srv-${id}`] = async () => {
      await answered;
      return noContent();
    };

  const { router } = await open('/settings');
  await user.press(await screen.findByTestId('settings-sign-out', {}, WAIT));
  await user.press(screen.getAllByRole('button', { name: /sign out/i }).at(-1)!);
  await user.press(await screen.findByTestId('account-downloads-delete', {}, WAIT));

  // The server is told while the session still works: progress, no buttons, not signed out yet.
  expect(await screen.findByTestId('account-downloads-removing', {}, WAIT)).toBeOnTheScreen();
  expect(screen.getByText('Removing downloads…')).toBeOnTheScreen();
  expect(screen.queryByTestId('account-downloads-delete')).toBeNull();
  expect(world.requests).not.toContain('POST /api/v1/viewer/auth/logout');
  expect(test.store.forAccount(WORLD_OWNER).every((item) => item.state === 'removing')).toBe(true);

  answer();
  await waitFor(() => expect(router.getPathname()).toBe('/profiles'), WAIT);
  expect(world.requests).toContain('DELETE /api/v1/viewer/downloads/srv-d-running');
  // Signed out while the transfer still ends: its record stays removing in the background.
  expect(test.store.get('d-running')!.state).toBe('removing');
  expect(screen.queryByText('Removing downloads…')).toBeNull();

  test.engine.controls.releaseDrain('d-running');
  await waitFor(() => expect(test.store.forAccount(WORLD_OWNER)).toEqual([]), { timeout: 10_000 });
  expect(test.store.forAccount('http://dev.test#v-ben').map((d) => d.id)).toEqual(['d-other']);
  expect(test.store.pendingDeletes()).toEqual([]);
});
