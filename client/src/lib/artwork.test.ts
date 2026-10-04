import { artworkClass, artworkFor } from './artwork';

const sizes = { small: 'w185', medium: 'w342', large: 'w780' };
const stills = { small: 'w300', medium: 'w780', large: 'w1280' };

describe('artwork size classes (B10)', () => {
  it('web 1280 at 1x: posters and landscape cards load the small class', () => {
    // Poster 208 × 0.667 ≈ 139 css px, landscape 352 × 0.667 ≈ 235 css px, card focus lift 1.05.
    expect(artworkFor(sizes, 'plain', { kind: 'poster', cssWidth: 139, dpr: 1, scale: 1.05 })).toBe(
      'w185'
    );
    expect(
      artworkFor(stills, 'plain', { kind: 'backdrop', cssWidth: 235, dpr: 1, scale: 1.05 })
    ).toBe('w300');
  });

  it('retina and iPad (DPR 2) load medium, TV accounts for the focus scale', () => {
    expect(artworkClass('poster', 139, 2, 1.05)).toBe('medium');
    expect(artworkClass('poster', 125, 2, 1.05)).toBe('medium');
    // Android TV: 960 dp canvas at density 2, poster 104 dp, focus 1.1 → 229 px is too wide for w185.
    expect(artworkClass('poster', 104, 2, 1.1)).toBe('medium');
    expect(artworkClass('backdrop', 176, 2, 1.1)).toBe('medium');
  });

  it('wide drawings get large; fixed classes win over the width', () => {
    expect(artworkClass('backdrop', 1280, 1)).toBe('large');
    expect(artworkClass('poster', 2000, 2)).toBe('large');
    expect(artworkFor(stills, 'plain', { kind: 'backdrop', size: 'medium' })).toBe('w780');
  });

  it('keeps the plain URL for servers without size classes or a missing class', () => {
    expect(artworkFor(null, 'plain', { kind: 'poster', cssWidth: 100, dpr: 1 })).toBe('plain');
    expect(
      artworkFor({ small: null, medium: 'm', large: 'l' }, 'plain', {
        kind: 'poster',
        cssWidth: 100,
        dpr: 1,
      })
    ).toBe('plain');
    expect(artworkFor(undefined, undefined, { kind: 'poster', cssWidth: 1, dpr: 1 })).toBeNull();
  });
});
