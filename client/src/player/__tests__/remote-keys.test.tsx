import { renderHook } from '@testing-library/react-native';
import { act } from 'react';

import { useRemoteKeys } from '../remote-keys';

const mockKeys = { listener: null as ((event: { key: string; repeat: number }) => void) | null };
const mockCapture = jest.fn();

jest.mock('@modules/player-keys', () => ({
  playerKeysAvailable: true,
  setKeyCapture: (groups: string[]) => mockCapture(groups),
  addKeyListener: (listener: (event: { key: string; repeat: number }) => void) => {
    mockKeys.listener = listener;
    return { remove: () => (mockKeys.listener = null) };
  },
}));

const press = (key: string, repeat = 0) => act(async () => mockKeys.listener?.({ key, repeat }));

describe('useRemoteKeys with the iPad keyboard (iOS player-keys)', () => {
  beforeEach(() => mockCapture.mockClear());

  it('maps Escape to Back (stop), m to mute and passes the repeat count', async () => {
    const handler = jest.fn();
    await renderHook(() => useRemoteKeys(true, handler));
    expect(mockCapture).toHaveBeenLastCalledWith(['dpad', 'media']);
    await press('escape');
    await press('mute');
    await press('playPause');
    await press('right', 3);
    expect(handler.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ['stop', 0],
      ['mute', 0],
      ['toggle', 0],
      ['forward30', 3],
    ]);
  });

  it('keeps the arrows captured after up on iOS (no focus row to hand them to)', async () => {
    await renderHook(() => useRemoteKeys(true, () => 'release'));
    mockCapture.mockClear();
    await press('up');
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('ignores arrows while a panel owns the keys', async () => {
    const handler = jest.fn();
    await renderHook(() => useRemoteKeys(false, handler));
    await press('left');
    await press('escape');
    expect(handler.mock.calls.map((call) => call[0])).toEqual(['stop']);
  });
});
