import { fireEvent } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import { clearWorld, json, open, resetWorld, WAIT, world } from '../../../jest/mylist-world';
import {
  PING,
  serveUsenetRunning as serveState,
  setDeviceMbps,
  USENET_START as START,
} from '../../../jest/streaming-path-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(resetWorld);
afterEach(clearWorld);

describe('Measuring: stale errors', () => {
  it('a new run drops the error of the previous run before showing its own', async () => {
    serveState(0);
    setDeviceMbps(null);
    world.handlers[PING.replace('GET ', '')] = () =>
      json(500, { error: { code: 'server_error', message: 'boom' } });
    world.handlers[START] = () =>
      json(429, {
        error: { code: 'usenet_speedtest_rate_limited', message: 'wait', retryAfterSeconds: 120 },
      });
    await open('/connection');

    fireEvent.press(await screen.findByTestId('connection-path-device-run', {}, WAIT));
    await screen.findByTestId('connection-path-device-error', {}, WAIT);

    fireEvent.press(screen.getByTestId('connection-path-usenet-run'));

    await screen.findByTestId('connection-path-error', {}, WAIT);
    await waitFor(
      () => expect(screen.queryByTestId('connection-path-device-error')).toBeNull(),
      WAIT
    );

    fireEvent.press(screen.getByTestId('connection-path-device-run'));

    await screen.findByTestId('connection-path-device-error', {}, WAIT);
    expect(screen.queryByTestId('connection-path-error')).toBeNull();
  });
});
