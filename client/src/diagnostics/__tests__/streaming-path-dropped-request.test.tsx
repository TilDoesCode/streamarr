import { fireEvent } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import { clearWorld, open, resetWorld, WAIT, world } from '../../../jest/mylist-world';
import {
  requestCount as count,
  serveUsenetRunning as serveState,
  setDeviceMbps,
  USENET_START as START,
  USENET_STATE as STATE,
} from '../../../jest/streaming-path-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(resetWorld);
afterEach(clearWorld);

describe('Usenet test: dropped request', () => {
  it('shows a dropped request and asks the server for the real state', async () => {
    serveState(0);
    setDeviceMbps(null);
    world.handlers[START] = () => {
      throw new TypeError('Network request failed');
    };
    await open('/connection');
    await screen.findByTestId('connection-path-usenet-run', {}, WAIT);
    const reads = count(STATE);

    fireEvent.press(screen.getByTestId('connection-path-usenet-run'));

    expect(await screen.findByTestId('connection-path-error', {}, WAIT)).toBeOnTheScreen();
    await waitFor(() => expect(count(STATE)).toBeGreaterThan(reads), WAIT);
  });
});
