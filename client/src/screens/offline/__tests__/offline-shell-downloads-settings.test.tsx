import { fireEvent, screen, waitFor } from 'expo-router/testing-library';

import { ConnectivityMonitor } from '@/connectivity/monitor';

import { installOfflineLibrary } from '../../../../jest/downloads';
import { clearWorld, open, resetWorld, WAIT, world } from '../../../../jest/mylist-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

// One scenario per file: expo-router's test store does not survive a second render after leaving the shell.
beforeEach(async () => {
  await resetWorld();
  world.connectivity = true;
  world.monitor = new ConnectivityMonitor({ probe: async () => false });
});
afterEach(clearWorld);

it('offers the download settings offline, without the Downloads tab link', async () => {
  installOfflineLibrary();
  await open('/');
  await screen.findByTestId('offline-screen', {}, WAIT);
  expect(screen.getByTestId('settings-downloads')).toBeOnTheScreen();
  expect(screen.queryByTestId('settings-downloads-open')).toBeNull();
  expect(screen.getByTestId('settings-downloads-wifi-on')).toBeChecked();
  fireEvent.press(screen.getByTestId('settings-downloads-wifi-off'));
  await waitFor(
    () => expect(screen.getByTestId('settings-downloads-wifi-off')).toBeChecked(),
    WAIT
  );
});
