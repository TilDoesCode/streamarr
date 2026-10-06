import { engineEnd } from '@/player/recovery/early-end';

const base = {
  position: 0,
  duration: 600,
  engineDuration: 600,
  loadPosition: 0,
  blank: false,
  pictured: true,
  startFloor: 0,
};

describe('an "ended" from the engine (C13, C31, D26)', () => {
  it('a file without media is empty, the real end is the end', () => {
    expect(engineEnd({ ...base, engineDuration: 0.4 })).toEqual({ kind: 'empty' });
    expect(engineEnd({ ...base, position: 59, engineDuration: 60, duration: 180 })).toEqual({
      kind: 'early',
      endAt: 59,
    });
    expect(engineEnd({ ...base, position: 598 })).toEqual({ kind: 'end' });
  });

  it('a reloaded short file that ends again before its first time event ends where it was loaded', () => {
    const again = { ...base, position: 0, loadPosition: 431, startFloor: 431, firstEnd: 430 };
    expect(engineEnd(again)).toEqual({ kind: 'early', endAt: 431, firstEnd: 430 });
  });

  it('a source that played and stops short ended early; one still loading did not end', () => {
    expect(engineEnd({ ...base, position: 300 })).toEqual({ kind: 'early', endAt: 300 });
    expect(engineEnd({ ...base, position: 300, pictured: false })).toBeNull();
  });
});
