import { heroCopyTop, heroRowsTop } from '../shell-hero';

const scale = (factor: number) => (value: number) => Math.round(value * factor * 2) / 2;

describe('heroCopyTop', () => {
  it('keeps the mockup top when the copy fits above the rows (TV 1080p)', () => {
    expect(heroCopyTop(scale(1), 474, 0)).toBe(96);
  });

  it('raises the copy on a short tablet window so the rows keep their gap', () => {
    const s = scale(0.6);
    const top = heroCopyTop(s, 320, 24);
    expect(top).toBeLessThan(s(96));
    expect(top + 320).toBeLessThanOrEqual(s(648) - s(48));
  });

  it('never goes above the rail top under the status bar', () => {
    const s = scale(0.6);
    expect(heroCopyTop(s, 500, 24)).toBe(24 + s(24));
  });
});

describe('heroRowsTop', () => {
  it('keeps the mockup rows top when the copy ends early', () => {
    expect(heroRowsTop(scale(1), 570)).toBe(648);
  });

  it('moves the rows below a copy that does not fit, keeping two row gaps', () => {
    const s = scale(0.6);
    expect(heroRowsTop(s, 500)).toBe(500 + s(48));
  });
});
