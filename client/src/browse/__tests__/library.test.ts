import { fetchLibraryPage, libraryItems, libraryParams } from '@/browse/library';
import type { CatalogItem } from '@/browse/queries';

const item = (tmdbId: number) =>
  ({
    workId: `tmdb-movie-${tmdbId}`,
    tmdbId,
    mediaType: 'movie',
    title: `T${tmdbId}`,
  }) as CatalogItem;

function pages(map: Record<number, { items: CatalogItem[]; hasMore: boolean }>) {
  const calls: number[] = [];
  const load = (page: number) => {
    calls.push(page);
    return Promise.resolve(map[page] ?? { items: [], hasMore: false });
  };
  return { load, calls };
}

describe('fetchLibraryPage', () => {
  it('returns a full page and the next page while hasMore', async () => {
    const { load, calls } = pages({ 1: { items: [item(1)], hasMore: true } });
    await expect(fetchLibraryPage(load, 1)).resolves.toEqual({ items: [item(1)], nextPage: 2 });
    expect(calls).toEqual([1]);
  });

  it('follows empty (age-gated) pages until one has items', async () => {
    const { load, calls } = pages({
      1: { items: [], hasMore: true },
      2: { items: [], hasMore: true },
      3: { items: [item(9)], hasMore: false },
    });
    await expect(fetchLibraryPage(load, 1)).resolves.toEqual({ items: [item(9)], nextPage: null });
    expect(calls).toEqual([1, 2, 3]);
  });

  it('stops after three empty pages in a row and keeps paging on hasMore', async () => {
    const { load, calls } = pages({
      1: { items: [], hasMore: true },
      2: { items: [], hasMore: true },
      3: { items: [], hasMore: true },
      4: { items: [item(4)], hasMore: true },
    });
    await expect(fetchLibraryPage(load, 1)).resolves.toEqual({ items: [], nextPage: 4 });
    expect(calls).toEqual([1, 2, 3]);
  });

  it('ends on an empty last page', async () => {
    const { load } = pages({ 5: { items: [], hasMore: false } });
    await expect(fetchLibraryPage(load, 5)).resolves.toEqual({ items: [], nextPage: null });
  });
});

describe('libraryItems', () => {
  it('flattens pages without duplicate works', () => {
    const result = libraryItems([
      { items: [item(1), item(2)], nextPage: 2 },
      { items: [item(2), item(3)], nextPage: null },
    ]);
    expect(result.map((entry) => entry.tmdbId)).toEqual([1, 2, 3]);
  });
});

describe('libraryParams', () => {
  it('reads genre and sort from the route', () => {
    expect(libraryParams({ genre: '27', sort: 'top_rated' })).toEqual({
      genre: 27,
      sort: 'top_rated',
    });
  });

  it('falls back to all genres and popular for missing or unknown values', () => {
    expect(libraryParams({})).toEqual({ genre: null, sort: 'popular' });
    expect(libraryParams({ genre: 'x', sort: 'best' })).toEqual({ genre: null, sort: 'popular' });
    expect(libraryParams({ genre: '-3' })).toEqual({ genre: null, sort: 'popular' });
  });
});
