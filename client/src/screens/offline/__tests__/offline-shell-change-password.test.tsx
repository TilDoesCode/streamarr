import { act, fireEvent, screen, waitFor } from 'expo-router/testing-library';

import type { AccountStore } from '@/accounts/account-store';
import { holdForPlayer } from '@/accounts/player-hold';
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
  world.mustChangePassword = true;
  probe.healthy = false;
  world.monitor = new ConnectivityMonitor({ probe: async () => probe.healthy });
});
afterEach(clearWorld);

it('C1-24: a cold start owing a password change opens the downloads offline, and the change once the server answers', async () => {
  installOfflineLibrary();
  const { router } = await open('/');
  await screen.findByTestId('offline-screen', {}, WAIT);
  expect(router.getPathname()).toBe('/offline');
  expect(screen.queryByTestId('change-password-screen')).toBeNull();
  expect(screen.getByTestId('download-series-tmdb-tv-1396')).toBeTruthy();
  expect(screen.queryByTestId('download-tmdb-movie-999')).toBeNull();
  // No /viewer/me poll while the server is away.
  await act(async () => {
    await jest.advanceTimersByTimeAsync(11 * 60_000);
  });
  expect(world.requests.filter((request) => request.endsWith('/viewer/me'))).toEqual([]);

  fireEvent.press(screen.getByTestId('download-tmdb-movie-603-play'));
  await waitFor(() => expect(router.getPathname()).toBe('/play/new'), WAIT);
  expect(router.getSearchParams()).toMatchObject({ workId: 'tmdb-movie-603' });
  // The route is stubbed: hold the profile as the real play screen does.
  const { store } = (globalThis as { __streamarr?: { store: AccountStore } }).__streamarr!;
  let release = () => undefined as void;
  await act(async () => {
    release = holdForPlayer(store.getSnapshot().activeId!);
  });

  // The server is back: the downloaded movie keeps playing, the change waits for the player to close.
  probe.healthy = true;
  await act(() => world.monitor!.retry());
  expect(world.monitor!.offline).toBe(false);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(500);
  });
  expect(router.getPathname()).toBe('/play/new');

  await act(async () => release());
  await screen.findByTestId('change-password-screen', {}, WAIT);
  expect(router.getPathname()).toBe('/sign-in/change-password');
});
