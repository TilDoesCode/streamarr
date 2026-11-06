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

it('C1-23: removing a profile asks about its downloads; "Delete" removes only that profile\'s', async () => {
  const user = userEvent.setup();
  const test = installOfflineLibrary();
  await open('/profiles');
  await user.press(await screen.findByTestId('profiles-manage', {}, WAIT));
  await user.press(await screen.findByTestId('profile-anna', {}, WAIT));
  await user.press(await screen.findByText('Remove from this device', {}, WAIT));
  await user.press(screen.getAllByRole('button', { name: /^remove$/i }).at(-1)!);
  expect(await screen.findByTestId('account-downloads-dialog', {}, WAIT)).toBeOnTheScreen();
  await user.press(screen.getByTestId('account-downloads-delete'));
  await waitFor(() => expect(test.store.forAccount(WORLD_OWNER)).toEqual([]), WAIT);
  expect(test.store.forAccount('http://dev.test#v-ben').map((d) => d.id)).toEqual(['d-other']);
});
