import { validHex, withAlpha } from './color';

describe('withAlpha', () => {
  it('turns hex into rgba', () => {
    expect(withAlpha('#3FCF7A', 0.5)).toBe('rgba(63, 207, 122, 0.5)');
    expect(withAlpha('0f3a26', 2)).toBe('rgba(15, 58, 38, 1)');
  });
  it('leaves other colours alone', () => {
    expect(withAlpha('rgba(1, 2, 3, 0.4)', 0.5)).toBe('rgba(1, 2, 3, 0.4)');
  });
});

describe('validHex', () => {
  it('accepts server tints and rejects junk', () => {
    expect(validHex('#3fcf7a')).toBe('#3FCF7A');
    expect(validHex(null)).toBeNull();
    expect(validHex('red')).toBeNull();
  });
});
