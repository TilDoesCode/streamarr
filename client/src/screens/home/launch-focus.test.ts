import { renderHook } from '@testing-library/react-native';
import { Platform, type View } from 'react-native';

import { resetLaunchFocus, useLaunchFocus } from './launch-focus';

const node = () =>
  ({ requestTVFocus: jest.fn() }) as unknown as View & { requestTVFocus: jest.Mock };

describe('useLaunchFocus (Q1-53: Apple TV Home opens with the hero focused)', () => {
  let clock = 0;
  const now = () => clock;
  const os = Platform.OS;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    Platform.OS = 'ios';
    resetLaunchFocus();
    clock = 0;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    Platform.OS = os;
  });

  it('focuses the hero once per app run, following the main button when it replaces More info', async () => {
    const info = node();
    const play = node();
    const { rerender, unmount } = await renderHook(
      ({ target }: { target: View }) => useLaunchFocus(target, true, now),
      { initialProps: { target: info as View } }
    );
    jest.runOnlyPendingTimers();
    expect(info.requestTVFocus).toHaveBeenCalledTimes(1);
    clock = 800;
    await rerender({ target: play });
    jest.runOnlyPendingTimers();
    expect(play.requestTVFocus).toHaveBeenCalledTimes(1);
    await unmount();

    // Back to Home later (tab switch): the tab bar keeps its focus.
    clock = 60_000;
    const later = node();
    await renderHook(() => useLaunchFocus(later, true, now));
    jest.runOnlyPendingTimers();
    expect(later.requestTVFocus).not.toHaveBeenCalled();
  });

  it('leaves focus alone once the viewer moved into the rows', async () => {
    const play = node();
    await renderHook(() => useLaunchFocus(play, false, now));
    jest.runOnlyPendingTimers();
    expect(play.requestTVFocus).not.toHaveBeenCalled();
  });
});
