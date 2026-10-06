import { act, renderHook } from '@testing-library/react-native';

import { clockMoved, useClock, usePlayerClock } from '../use-clock';

const shown = { position: 10, duration: 600, buffered: 30 };

describe('clockMoved', () => {
  it('skips engine ticks below one whole second and buffer growth below five seconds', () => {
    expect(clockMoved(shown, { ...shown, position: 10.5 })).toBe(false);
    expect(clockMoved(shown, { ...shown, position: 10.9, buffered: 34 })).toBe(false);
  });

  it('re-renders the player at most once a second during playback (was four times, Q1-25)', () => {
    let current = shown;
    let renders = 0;
    for (let tick = 1; tick <= 20; tick++) {
      const next = { ...shown, position: 10 + tick * 0.5, buffered: 30 + tick * 0.5 };
      if (clockMoved(current, next)) {
        renders += 1;
        current = next;
      }
    }
    expect(renders).toBeLessThanOrEqual(10);
  });

  it('re-renders on a visible step, a seek back, a new duration or more buffer', () => {
    expect(clockMoved(shown, { ...shown, position: 11 })).toBe(true);
    expect(clockMoved(shown, { ...shown, position: 2 })).toBe(true);
    expect(clockMoved(shown, { ...shown, duration: 601 })).toBe(true);
    expect(clockMoved(shown, { ...shown, buffered: 35 })).toBe(true);
  });
});

describe('clockMoved while the overlay is hidden (Q1-25)', () => {
  it('re-renders every ten seconds instead of every second', () => {
    expect(clockMoved(shown, { ...shown, position: 15 }, true)).toBe(false);
    expect(clockMoved(shown, { ...shown, position: 20 }, true)).toBe(true);
    expect(clockMoved(shown, { ...shown, buffered: 60 }, true)).toBe(false);
  });

  it('keeps whole seconds in the last minute, where up-next starts', () => {
    const late = { position: 545, duration: 600, buffered: 600 };
    expect(clockMoved(late, { ...late, position: 546 }, true)).toBe(true);
  });

  it('still follows a seek and a new duration', () => {
    expect(clockMoved(shown, { ...shown, position: 2 }, true)).toBe(true);
    expect(clockMoved(shown, { ...shown, duration: 601 }, true)).toBe(true);
  });
});

describe('usePlayerClock wiring (review S1: coarse clock while hidden)', () => {
  function fakeEngine() {
    const listeners = new Set<(event: { type: string }) => void>();
    const snapshot = { position: 100, duration: 600, buffered: 120 };
    return {
      snapshot,
      getSnapshot: () => snapshot,
      subscribe: (listener: (event: { type: string }) => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      tick(position: number) {
        snapshot.position = position;
        for (const listener of listeners) listener({ type: 'time' });
      },
    };
  }

  it('steps in whole seconds while the overlay shows and in ten while it is hidden', async () => {
    const engine = fakeEngine();
    const { result } = await renderHook(() => usePlayerClock(engine as never, false));
    await act(async () => engine.tick(101));
    expect(result.current.clock.position).toBe(101);
    await act(async () => result.current.onVisibleChange(false));
    for (let second = 102; second <= 108; second++) {
      await act(async () => engine.tick(second));
      expect(result.current.clock.position).toBe(101);
    }
    await act(async () => engine.tick(112));
    expect(result.current.clock.position).toBe(112);
  });

  it('keeps whole seconds while a panel is open, even with the overlay hidden', async () => {
    const engine = fakeEngine();
    const { result } = await renderHook(() => usePlayerClock(engine as never, true));
    await act(async () => result.current.onVisibleChange(false));
    await act(async () => engine.tick(102));
    expect(result.current.clock.position).toBe(102);
  });
});

describe('a burst of native state events does not re-render the clock (S6v "Maximum update depth")', () => {
  it('state events with an unchanged clock keep the same clock object; a real change still shows', async () => {
    const listeners = new Set<(event: { type: string }) => void>();
    const snapshot = { position: 100, duration: 600, buffered: 120 };
    const engine = {
      getSnapshot: () => snapshot,
      subscribe: (listener: (event: { type: string }) => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    let renders = 0;
    const { result } = await renderHook(() => {
      renders += 1;
      return useClock(engine as never);
    });
    const first = renders;
    for (let i = 0; i < 50; i++)
      await act(async () => listeners.forEach((listener) => listener({ type: 'state' })));
    // React may run the component once to see the bail-out; never once per event.
    expect(renders).toBeLessThanOrEqual(first + 1);
    const before = renders;
    snapshot.position = 140;
    await act(async () => listeners.forEach((listener) => listener({ type: 'state' })));
    expect(result.current.position).toBe(140);
    expect(renders).toBe(before + 1);
  });
});
