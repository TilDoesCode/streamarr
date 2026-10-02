import { clockMoved } from '../use-clock';

const shown = { position: 10, duration: 600, buffered: 30 };

describe('clockMoved', () => {
  it('skips the 100 ms engine ticks below one step', () => {
    expect(clockMoved(shown, { ...shown, position: 10.1 })).toBe(false);
    expect(clockMoved(shown, { ...shown, position: 10.2, buffered: 30.5 })).toBe(false);
  });

  it('re-renders on a visible step, a seek back, a new duration or more buffer', () => {
    expect(clockMoved(shown, { ...shown, position: 10.25 })).toBe(true);
    expect(clockMoved(shown, { ...shown, position: 2 })).toBe(true);
    expect(clockMoved(shown, { ...shown, duration: 601 })).toBe(true);
    expect(clockMoved(shown, { ...shown, buffered: 31 })).toBe(true);
  });
});
