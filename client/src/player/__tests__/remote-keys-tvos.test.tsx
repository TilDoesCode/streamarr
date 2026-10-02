import { renderHook } from '@testing-library/react-native';
import { act } from 'react';
import { Platform } from 'react-native';

import { TVOS_LONG_REPEAT, useRemoteKeys } from '../remote-keys';

type TVEvent = { eventType: string; eventKeyAction?: number };
const mockTV = { listener: null as ((event: TVEvent) => void) | null };

jest.mock('@modules/player-keys', () => ({
  playerKeysAvailable: false,
  setKeyCapture: jest.fn(),
  addKeyListener: jest.fn(),
}));

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return Object.defineProperty(actual, 'useTVEventHandler', {
    value: (listener: (event: TVEvent) => void) => {
      mockTV.listener = listener;
    },
  });
});

const send = (eventType: string, eventKeyAction?: number) =>
  act(async () => mockTV.listener?.({ eventType, eventKeyAction }));

describe('useRemoteKeys on Apple TV (react-native-tvos events)', () => {
  const os = Platform.OS;
  beforeAll(() => {
    Platform.OS = 'ios';
  });
  afterAll(() => {
    Platform.OS = os;
  });

  it('acts on tap key-up events and long-press starts', async () => {
    const handler = jest.fn();
    await renderHook(() => useRemoteKeys(true, handler));
    await send('right', 1);
    await send('select', 1);
    await send('longLeft', 0);
    await send('longLeft', 1);
    await send('left', 0);
    expect(handler.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ['forward30', 0],
      ['toggle', 0],
      ['back10', TVOS_LONG_REPEAT],
    ]);
  });
});
