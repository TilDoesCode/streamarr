import { fireEvent } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import { clearWorld, json, open, resetWorld, WAIT, world } from '../../../jest/mylist-world';
import {
  PING,
  requestCount as count,
  serveUsenetRunning as serveState,
  setDeviceMbps,
  usenetResult,
  USENET_START as START,
} from '../../../jest/streaming-path-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(resetWorld);
afterEach(clearWorld);

describe('Measure everything: a running server test', () => {
  it('pressing while the server reports a running test joins it instead of doing nothing', async () => {
    serveState(1_000);
    setDeviceMbps(null);
    world.handlers[START] = () => json(200, usenetResult({ megabitsPerSecond: 95, joined: true }));
    await open('/connection');
    await screen.findByTestId('connection-path-joined', {}, WAIT);

    fireEvent.press(screen.getByTestId('connection-path-all'));

    await waitFor(() => expect(count(START)).toBe(1), WAIT);
    await waitFor(() => expect(count(PING)).toBeGreaterThan(0), WAIT);
    expect(screen.getByTestId('connection-path-usenet-value')).toHaveTextContent('95 Mbit/s');
  });
});
