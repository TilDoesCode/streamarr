import { subtitleAfterAudio } from '../forced-subtitle';

const tracks = [
  { index: 3, language: 'ger', forced: true },
  { index: 4, language: 'deu', forced: false },
  { index: 5, language: null, forced: true },
  { index: 6, language: 'fre', forced: true },
];

describe('subtitleAfterAudio', () => {
  it('matches the forced track across 639-1/639-2 codes', () => {
    expect(subtitleAfterAudio(tracks, 6, 'de', 'forced')).toBe(3);
    expect(subtitleAfterAudio(tracks, 3, 'fra', undefined)).toBe(6);
  });

  it('falls back to a forced track without a language, else off', () => {
    expect(subtitleAfterAudio(tracks, 3, 'en', 'forced')).toBe(5);
    expect(subtitleAfterAudio(tracks.slice(0, 2), 3, 'en', 'forced')).toBeNull();
  });

  it('keeps a full subtitle, and off outside mode forced', () => {
    expect(subtitleAfterAudio(tracks, 4, 'fr', 'forced')).toBe(4);
    expect(subtitleAfterAudio(tracks, null, 'fr', 'off')).toBeNull();
    expect(subtitleAfterAudio(tracks, null, 'fr', 'always')).toBeNull();
    expect(subtitleAfterAudio(tracks, null, 'fr', null)).toBe(6);
  });
});
