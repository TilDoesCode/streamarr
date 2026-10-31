import { StyleSheet } from 'react-native';
import { screen } from 'expo-router/testing-library';

import { clearWorld, open, resetWorld, WAIT } from '../../../jest/mylist-world';
import { serveUsenet, setDeviceMbps, usenetResult } from '../../../jest/streaming-path-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(resetWorld);
afterEach(clearWorld);

const style = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style);

describe('streaming path diagram (large shell)', () => {
  // Layout is not computed in jest: the invariants below are what keeps the row inside any column width.
  it('sizes the nodes to their label and lets the legs between them take the slack', async () => {
    serveUsenet(usenetResult());
    setDeviceMbps(40);
    await open('/connection');
    await screen.findByTestId('connection-path-diagram', {}, WAIT);

    expect(style('connection-path-diagram')).toMatchObject({ flexDirection: 'row' });
    for (const id of ['usenet', 'server', 'device']) {
      const stop = style(`connection-path-stop-${id}`);
      expect(stop.flexShrink).toBe(0);
      expect(stop.minWidth).toBeUndefined();
      expect(stop.width).toBeUndefined();
    }
    for (const id of ['usenet', 'device']) {
      const leg = style(`connection-path-${id}`);
      expect(leg.flex).toBe(1);
      expect(leg.minWidth).toBe(0);
    }
  });
});
