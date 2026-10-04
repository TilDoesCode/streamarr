import type { CatalogItem } from './queries';

export type LibraryKind = 'movie' | 'series';
export type LibrarySort = 'popular' | 'top_rated' | 'newest';
export const LIBRARY_SORTS: readonly LibrarySort[] = ['popular', 'top_rated', 'newest'];
// The age gate filters after paging: skip at most this many empty pages in one fetch.
const EMPTY_PAGE_SKIP = 3;

export type LibraryPage = { items: CatalogItem[]; nextPage: number | null };

/** Fetches `page`, following empty (age-gated) pages up to `EMPTY_PAGE_SKIP` in a row while `hasMore`. */
export async function fetchLibraryPage(
  load: (page: number) => Promise<{ items?: CatalogItem[] | null; hasMore: boolean }>,
  page: number
): Promise<LibraryPage> {
  let current = page;
  for (let tries = 0; ; tries++) {
    const response = await load(current);
    const items = response.items ?? [];
    const nextPage = response.hasMore ? current + 1 : null;
    if (items.length || nextPage === null || tries + 1 >= EMPTY_PAGE_SKIP)
      return { items, nextPage };
    current = nextPage;
  }
}

/** Library items of all loaded pages, without duplicates across pages (by work id). */
export function libraryItems(pages: readonly LibraryPage[] | undefined): CatalogItem[] {
  const seen = new Set<string>();
  const items: CatalogItem[] = [];
  for (const item of (pages ?? []).flatMap((page) => page.items)) {
    const key = item.workId ?? `${item.mediaType}-${item.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

export type LibraryParams = { genre?: string; sort?: string };

/** Genre and sort from the route (URL on web, deep link query), unknown values fall back to defaults. */
export function libraryParams(params: LibraryParams): { genre: number | null; sort: LibrarySort } {
  const genre = Number(params.genre);
  const sort = LIBRARY_SORTS.find((value) => value === params.sort) ?? 'popular';
  return { genre: Number.isInteger(genre) && genre > 0 ? genre : null, sort };
}
