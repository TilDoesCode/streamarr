import { screen } from 'expo-router/testing-library';

import { ConnectivityMonitor, type NetworkState } from '@/connectivity/monitor';

import { installOfflineLibrary } from '../../../../jest/downloads';
import { clearWorld, open, resetWorld, WAIT, world } from '../../../../jest/mylist-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(async () => {
  await resetWorld();
  world.connectivity = true;
  const offline: NetworkState = { isConnected: false, type: 'none' };
  world.monitor = new ConnectivityMonitor({
    probe: async () => false,
    network: { subscribe: () => () => undefined, fetch: async () => offline },
  });
});
afterEach(clearWorld);

it('without a network the card speaks about this device, not the server', async () => {
  installOfflineLibrary();
  await open('/');
  await screen.findByTestId('offline-screen', {}, WAIT);
  expect(await screen.findByTestId('offline-banner-title', {}, WAIT)).toHaveTextContent(
    'No network'
  );
  expect(screen.getByTestId('offline-banner-retry')).toHaveTextContent(
    'The app returns by itself as soon as this device is online again.'
  );
  expect(screen.queryByText(/once the server answers/)).toBeNull();
});
