import { clockMoved } from '../use-clock';

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
