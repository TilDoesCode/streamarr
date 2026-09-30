import { clock, parseEpisodeWorkId, scrubStep } from '../format';

describe('player format', () => {
  it('formats the clock', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(65.9)).toBe('1:05');
    expect(clock(3723)).toBe('1:02:03');
    expect(clock(Number.NaN)).toBe('0:00');
  });

  it('accelerates hold-scrub steps', () => {
    expect(scrubStep(-1, 0)).toBe(-10);
    expect(scrubStep(1, 0)).toBe(30);
    expect(scrubStep(1, 3)).toBe(10);
    expect(scrubStep(1, 10)).toBe(30);
    expect(scrubStep(-1, 30)).toBe(-60);
    expect(scrubStep(1, 50)).toBe(120);
  });

  it('parses episode work ids', () => {
    expect(parseEpisodeWorkId('tmdb-tv-1396-s01e02')).toEqual({
      tmdbId: 1396,
      season: 1,
      episode: 2,
    });
    expect(parseEpisodeWorkId('tmdb-movie-603')).toBeNull();
  });
});
