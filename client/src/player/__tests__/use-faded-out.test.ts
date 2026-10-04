import { act, renderHook } from '@testing-library/react-native';

import { useFadedOut } from '../use-faded-out';

describe('useFadedOut (Q1-46: hidden player controls leave the screen)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('turns true once the overlay stayed hidden for the fade, and false at once when it shows', async () => {
    const { result, rerender } = await renderHook(
      ({ visible }: { visible: boolean }) => useFadedOut(visible, 450),
      { initialProps: { visible: true } }
    );
    expect(result.current).toBe(false);
    await rerender({ visible: false });
    expect(result.current).toBe(false);
    await act(async () => jest.advanceTimersByTime(450));
    expect(result.current).toBe(true);
    await rerender({ visible: true });
    expect(result.current).toBe(false);
  });

  it('never removes the controls when disabled (TV keeps focus on hidden controls)', async () => {
    const { result } = await renderHook(() => useFadedOut(false, 450, false));
    await act(async () => jest.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });
});
