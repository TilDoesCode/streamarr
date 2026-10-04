import { continueRowKeys, FeaturedStore, type Featured } from './featured';

const item = (key: string, title = key): Featured => ({
  key,
  kind: 'movie',
  tmdbId: 1,
  title,
  eyebrow: 'Row',
});

describe('FeaturedStore', () => {
  it('lead features the first card and keeps it current until something else is featured', () => {
    jest.useFakeTimers();
    const store = new FeaturedStore();
    store.initial(item('top'));
    store.lead(item('a', 'Loading'));
    expect(store.get()?.title).toBe('Loading');
    store.lead(item('a', 'Loaded'));
    expect(store.get()?.title).toBe('Loaded');
    store.initial(item('other'));
    expect(store.get()?.key).toBe('a');
    store.set(item('b'));
    jest.runAllTimers();
    store.lead(item('a', 'Later'));
    expect(store.get()?.key).toBe('b');
    store.dispose();
    jest.useRealTimers();
  });

  it('hands the hero to the refreshed first card once the chosen card left Home (Q1-40)', () => {
    jest.useFakeTimers();
    const store = new FeaturedStore();
    store.lead(item('continue-s2e2'));
    store.set(item('continue-s2e2'));
    jest.runAllTimers();
    store.present(new Set(['continue-s2e2', 'next-s3e1']));
    expect(store.get()?.key).toBe('continue-s2e2');
    // Back from the player: S2E2 is watched, the row now starts with S2E3.
    store.lead(item('continue-s2e3'));
    expect(store.get()?.key).toBe('continue-s2e2');
    store.present(new Set(['continue-s2e3', 'next-s3e1']));
    expect(store.get()?.key).toBe('continue-s2e3');
    store.lead(item('continue-s2e3', 'S2, E3 · loaded'));
    expect(store.get()?.title).toBe('S2, E3 · loaded');
    store.dispose();
    jest.useRealTimers();
  });

  it('Play targets the focused card before the hero has caught up', () => {
    jest.useFakeTimers();
    const store = new FeaturedStore();
    store.set(item('a'), true);
    store.set(item('b'));
    expect(store.get()?.key).toBe('a');
    expect(store.playTarget()?.key).toBe('b');
    store.flush();
    expect(store.get()?.key).toBe('b');
    expect(store.playTarget()?.key).toBe('b');
    store.dispose();
    jest.useRealTimers();
  });
});

describe('continueRowKeys (Q1-40)', () => {
  it('keeps a series card across episodes so TV focus stays on it after the player', () => {
    const before = continueRowKeys(['tmdb-tv-7-s02e02', 'tmdb-movie-1']);
    const after = continueRowKeys(['tmdb-tv-7-s02e03', 'tmdb-movie-1']);
    expect(after).toEqual(before);
    expect(before).toEqual(['series-7', 'tmdb-movie-1']);
  });

  it('falls back to the work id when a series shows twice', () => {
    expect(continueRowKeys(['tmdb-tv-7-s02e03', 'tmdb-tv-7-s01e05', 'tmdb-tv-8-s01e01'])).toEqual([
      'tmdb-tv-7-s02e03',
      'tmdb-tv-7-s01e05',
      'series-8',
    ]);
  });
});
