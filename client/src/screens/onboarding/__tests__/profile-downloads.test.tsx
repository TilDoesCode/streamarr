import { userEvent } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

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

it("signing out asks about the profile's downloads; delete removes only that profile's", async () => {
  const user = userEvent.setup();
  const test = installOfflineLibrary();
  const { router } = await open('/settings');
  await user.press(await screen.findByTestId('settings-sign-out', {}, WAIT));
  await user.press(screen.getAllByRole('button', { name: /sign out/i }).at(-1)!);
  expect(await screen.findByTestId('account-downloads-dialog', {}, WAIT)).toBeOnTheScreen();
  expect(screen.getByText(/3 downloads/)).toBeOnTheScreen();

  await user.press(screen.getByTestId('account-downloads-delete'));
  await waitFor(() => expect(router.getPathname()).toBe('/profiles'), WAIT);
  // The server was told before the sign-out; the files go in the background.
  await waitFor(() => expect(test.store.forAccount(WORLD_OWNER)).toEqual([]), WAIT);
  expect(test.store.forAccount('http://dev.test#v-ben').map((d) => d.id)).toEqual(['d-other']);
  expect(world.requests).toContain('DELETE /api/v1/viewer/downloads/srv-d-movie');
});
