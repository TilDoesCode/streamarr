import { colors } from '@/theme';

import { ambientScene, smallArtwork } from './ambient-model';

describe('smallArtwork', () => {
  it('downsizes TMDB renditions and leaves other URLs alone', () => {
    expect(smallArtwork('https://image.tmdb.org/t/p/w1280/a.jpg')).toBe(
      'https://image.tmdb.org/t/p/w300/a.jpg'
    );
    expect(smallArtwork('https://image.tmdb.org/t/p/original/a.jpg', 'w185')).toBe(
      'https://image.tmdb.org/t/p/w185/a.jpg'
    );
    expect(smallArtwork('https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
    expect(smallArtwork(null)).toBeNull();
  });
});

describe('ambientScene', () => {
  it('falls back to the neutral Aurora wash while tint is null', () => {
    const scene = ambientScene({ image: 'https://example.com/a.jpg', tint: null });
    expect(scene.neutral).toBe(true);
    expect(scene.tint).toBe(colors.aurora.wash);
    expect(scene.tint2).toBe(colors.aurora.wash2);
  });

  it('changes key when the tint arrives on a refetch, so the backdrop crossfades', () => {
    const before = ambientScene({ image: 'https://example.com/a.jpg', tint: null });
    const after = ambientScene({
      image: 'https://example.com/a.jpg',
      tint: '#3fcf7a',
      tint2: '#0F3A26',
    });
    expect(after.neutral).toBe(false);
    expect(after.tint).toBe('#3FCF7A');
    expect(after.key).not.toBe(before.key);
  });

  it('works without any title', () => {
    expect(ambientScene(null)).toMatchObject({ image: null, neutral: true });
  });
});
