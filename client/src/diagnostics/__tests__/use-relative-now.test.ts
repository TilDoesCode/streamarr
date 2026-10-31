import { act, renderHook } from '@testing-library/react-native';

import { RELATIVE_NOW_MS, useRelativeNow } from '../use-relative-now';

let mockFocused = true;
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));

beforeEach(() => {
  mockFocused = true;
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-31T10:00:00Z'));
});
afterEach(() => jest.useRealTimers());

describe('useRelativeNow', () => {
  it('moves on while the screen is focused, so "just now" turns into "3 min ago"', async () => {
    const { result } = await renderHook(() => useRelativeNow());
    const first = result.current;

    await act(async () => {
      await jest.advanceTimersByTimeAsync(3 * 60_000);
    });

    expect(result.current - first).toBeGreaterThanOrEqual(3 * 60_000 - RELATIVE_NOW_MS);
    expect(result.current).toBe(Date.now());
  });

  it('stops ticking while another screen is on top and catches up when focused again', async () => {
    mockFocused = false;
    const { result, rerender } = await renderHook(() => useRelativeNow());
    const first = result.current;

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(result.current).toBe(first);

    mockFocused = true;
    await rerender({});
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(Date.now());
  });

  it('clears its timer on unmount', async () => {
    const set = jest.spyOn(globalThis, 'setInterval');
    const clear = jest.spyOn(globalThis, 'clearInterval');
    const { unmount } = await renderHook(() => useRelativeNow());
    const ticker = set.mock.results.find(
      (call, index) => set.mock.calls[index]?.[1] === RELATIVE_NOW_MS
    )?.value;
    expect(ticker).toBeDefined();

    await unmount();

    expect(clear).toHaveBeenCalledWith(ticker);
  });
});
