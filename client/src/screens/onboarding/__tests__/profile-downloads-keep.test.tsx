import { userEvent } from '@testing-library/react-native';
import { act, screen, waitFor } from 'expo-router/testing-library';

import { useAccountsApi } from '@/accounts/accounts-provider';

import { installOfflineLibrary, WORLD_OWNER } from '../../../../jest/downloads';
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

beforeEach(async () => {
  await resetWorld();
  world.handlers['POST /api/v1/viewer/auth/logout'] = () => noContent();
});
afterEach(clearWorld);

it('C1-23: "Keep downloads" on sign-out keeps them for the same profile when it signs in again', async () => {
  const user = userEvent.setup();
  const test = installOfflineLibrary();
  const { router } = await open('/settings');
  await user.press(await screen.findByTestId('settings-sign-out', {}, WAIT));
  await user.press(screen.getAllByRole('button', { name: /sign out/i }).at(-1)!);
  await user.press(await screen.findByTestId('account-downloads-keep', {}, WAIT));
  await waitFor(() => expect(router.getPathname()).toBe('/profiles'), WAIT);
  expect(
    test.store
      .forAccount(WORLD_OWNER)
      .map((d) => d.id)
      .sort()
  ).toEqual(['d-e1', 'd-e2', 'd-movie']);
  expect(world.requests.filter((request) => request.startsWith('DELETE'))).toEqual([]);

  const api = (
    globalThis as { __streamarr?: { store: ReturnType<typeof useAccountsApi>['store'] } }
  ).__streamarr;
  await act(async () => {
    await api!.store.addSignedIn(
      { url: 'http://dev.test', name: 'Dev World' },
      { id: 'v-anna', username: 'anna', displayName: 'Anna', mustChangePassword: false },
      {
        sessionId: 's2',
        accessToken: 'sva_2',
        accessExpiresAt: Date.now() + 3_600_000,
        refreshToken: 'svr_2',
        refreshExpiresAt: Date.now() + 3_600_000,
      }
    );
  });
  expect(test.store.forAccount(WORLD_OWNER)).toHaveLength(3);
});
