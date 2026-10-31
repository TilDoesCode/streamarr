import { fireEvent } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import { clearWorld, json, open, resetWorld, WAIT, world } from '../../../jest/mylist-world';
import {
  PING,
  requestCount as count,
  serveUsenetRunning as serveState,
  setDeviceMbps,
  USENET_START as START,
} from '../../../jest/streaming-path-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(resetWorld);
afterEach(clearWorld);

describe('Measure everything: rate limit', () => {
  it('shows the rate limit inline and still measures the device', async () => {
    serveState(0);
    setDeviceMbps(null);
    world.handlers[START] = () =>
      json(429, {
        error: { code: 'usenet_speedtest_rate_limited', message: 'wait', retryAfterSeconds: 120 },
      });
    await open('/connection');

    fireEvent.press(await screen.findByTestId('connection-path-all', {}, WAIT));

    const error = await screen.findByTestId('connection-path-error', {}, WAIT);
    expect(error).toHaveTextContent(/Measured just now/);
    expect(error).toHaveTextContent(/Wait a little and try again/);
    await waitFor(() => expect(count(PING)).toBeGreaterThan(0), WAIT);
  });
});
