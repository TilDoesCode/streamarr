import { fireEvent } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import { clearWorld, json, open, resetWorld, WAIT, world } from '../../../jest/mylist-world';
import { serveUsenet, setDeviceMbps, usenetResult } from '../../../jest/streaming-path-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(resetWorld);
afterEach(clearWorld);

describe('Measure everything', () => {
  // Last in its file: it mutates.
  it('measures Usenet first, then this device, so the two never share the line', async () => {
    serveUsenet(null);
    setDeviceMbps(null);
    world.handlers['POST /api/v1/viewer/diagnostics/usenet-speed'] = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return json(
        200,
        usenetResult({ megabitsPerSecond: 210, measuredAt: new Date().toISOString() })
      );
    };
    await open('/connection');

    fireEvent.press(await screen.findByTestId('connection-path-all', {}, WAIT));

    await waitFor(
      () => expect(world.requests).toContain('GET /api/v1/viewer/diagnostics/ping'),
      WAIT
    );
    const post = world.requests.indexOf('POST /api/v1/viewer/diagnostics/usenet-speed');
    const ping = world.requests.indexOf('GET /api/v1/viewer/diagnostics/ping');
    expect(post).toBeGreaterThanOrEqual(0);
    expect(post).toBeLessThan(ping);
    await waitFor(
      () =>
        expect(screen.getByTestId('connection-path-usenet-value')).toHaveTextContent('210 Mbit/s'),
      WAIT
    );
  });
});
