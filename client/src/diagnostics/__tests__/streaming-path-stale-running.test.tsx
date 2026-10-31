import { fireEvent } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import { clearWorld, json, open, resetWorld, WAIT, world } from '../../../jest/mylist-world';
import {
  requestCount as count,
  serveUsenetRunning as serveState,
  setDeviceMbps,
  usenetResult,
  USENET_START as START,
  USENET_STATE as STATE,
} from '../../../jest/streaming-path-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(resetWorld);
afterEach(clearWorld);

const POLL = { timeout: 9000 };

describe('Measure everything: a stale running flag', () => {
  it('a running flag left over on the server is polled until it clears, then measuring works', async () => {
    serveState(2);
    setDeviceMbps(null);
    world.handlers[START] = () => json(200, usenetResult({ megabitsPerSecond: 180 }));
    await open('/connection');

    expect(await screen.findByTestId('connection-path-joined', {}, WAIT)).toBeOnTheScreen();
    expect(screen.getByTestId('connection-path-usenet-detail')).toHaveTextContent(
      /Server is measuring/
    );
    await waitFor(() => expect(screen.queryByTestId('connection-path-joined')).toBeNull(), POLL);
    expect(count(STATE)).toBeGreaterThanOrEqual(3);

    fireEvent.press(screen.getByTestId('connection-path-all'));
    await waitFor(() => expect(count(START)).toBe(1), WAIT);
    await waitFor(
      () =>
        expect(screen.getByTestId('connection-path-usenet-value')).toHaveTextContent('180 Mbit/s'),
      WAIT
    );
  }, 20_000);
});
