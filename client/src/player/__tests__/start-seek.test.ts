import { StartSeek } from '../engines/start-seek';

describe('StartSeek', () => {
  it('applies the start only when ready and stops once it landed', () => {
    const apply = jest.fn();
    const start = new StartSeek(96, apply);
    start.time(0);
    expect(apply).not.toHaveBeenCalled();
    start.ready();
    start.ready();
    expect(apply).toHaveBeenCalledTimes(1);
    start.time(95.5);
    expect(start.pending).toBe(false);
  });

  it('retries once when the seek was dropped, then gives up', () => {
    const apply = jest.fn();
    const start = new StartSeek(96, apply);
    start.ready();
    for (let i = 0; i < 5; i++) start.time(i * 0.1);
    expect(apply).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 5; i++) start.time(1 + i * 0.1);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(start.pending).toBe(false);
  });

  it('does nothing for a start at 0 or after a cancel', () => {
    const apply = jest.fn();
    const zero = new StartSeek(0, apply);
    zero.ready();
    expect(zero.pending).toBe(false);
    const cancelled = new StartSeek(96, apply);
    cancelled.cancel();
    cancelled.ready();
    expect(apply).not.toHaveBeenCalled();
  });
});
