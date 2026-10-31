import { fireEvent } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';

import { clearWorld, json, open, resetWorld, WAIT, world } from '../../../jest/mylist-world';
import {
  PING,
  serveUsenetRunning as serveState,
  setDeviceMbps,
  usenetResult,
} from '../../../jest/streaming-path-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(resetWorld);
afterEach(clearWorld);

describe('Device test: failure', () => {
  it('shows a failed device test in the path card, not only further down', async () => {
    serveState(0, usenetResult());
    setDeviceMbps(null);
    world.handlers[PING.replace('GET ', '')] = () =>
      json(500, { error: { code: 'server_error', message: 'boom' } });
    await open('/connection');

    fireEvent.press(await screen.findByTestId('connection-path-device-run', {}, WAIT));

    const error = await screen.findByTestId('connection-path-device-error', {}, WAIT);
    expect(error).toHaveTextContent(/did not finish/);
    // Once, in the path card: the details section below stays quiet.
    expect(screen.queryByTestId('connection-speed-error')).toBeNull();
    expect(screen.getAllByText(/did not finish/)).toHaveLength(1);
  });
});
