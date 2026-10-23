import type { CatalogItem, NextUpItem, WatchState } from '@/browse/queries';

import {
  homeLead,
  homeLists,
  homeReady,
  orderHome,
  stableMerge,
  type HomeLists,
} from '../home-data';

const watch = (workId: string, title = workId): WatchState =>
  ({ workId, kind: 'movie', title }) as WatchState;
const next = (workId: string): NextUpItem => ({ workId }) as NextUpItem;
const item = (tmdbId: number, mediaType = 'movie'): CatalogItem =>
  ({ tmdbId, mediaType, workId: `tmdb-${mediaType}-${tmdbId}` }) as CatalogItem;
const lists = (patch: Partial<HomeLists>): HomeLists => ({
  continueItems: [],
  nextItems: [],
  discover: [],
  ...patch,
});
const ids = (list: readonly { workId: string | null }[]) => list.map((entry) => entry.workId);

describe('stableMerge', () => {
  const keys = (list: readonly string[]) => list;

  it('keeps the shown order, drops gone items and appends new ones', () => {
    expect(stableMerge(['a', 'b', 'c'], ['d', 'c', 'a'], keys)).toEqual(['a', 'c', 'd']);
  });

  it('takes the server order when nothing was shown yet', () => {
    expect(stableMerge([], ['b', 'a'], keys)).toEqual(['b', 'a']);
  });
});

describe('orderHome: a background refresh does not reorder Home', () => {
  it('keeps Continue watching in place and updates the entries in place', () => {
    const shown = lists({ continueItems: [watch('tmdb-movie-1'), watch('tmdb-movie-2')] });
    const fresh = lists({
      continueItems: [watch('tmdb-movie-3'), watch('tmdb-movie-2', 'New'), watch('tmdb-movie-1')],
    });
    const merged = orderHome(shown, fresh);
    expect(ids(merged.continueItems)).toEqual(['tmdb-movie-1', 'tmdb-movie-2', 'tmdb-movie-3']);
    // Fresh data (progress, title) still comes through.
    expect(merged.continueItems[1]!.title).toBe('New');
  });

  it('keeps a series card in place when its next episode replaces the played one', () => {
    const shown = lists({ continueItems: [watch('tmdb-tv-7-s01e02'), watch('tmdb-movie-1')] });
    const fresh = lists({ continueItems: [watch('tmdb-movie-1'), watch('tmdb-tv-7-s01e03')] });
    expect(ids(orderHome(shown, fresh).continueItems)).toEqual([
      'tmdb-tv-7-s01e03',
      'tmdb-movie-1',
    ]);
  });

  it('keeps Next up, the discover rows and their items in place', () => {
    const shown = lists({
      nextItems: [next('tmdb-tv-1-s01e01'), next('tmdb-tv-2-s01e01')],
      discover: [
        { id: 'trending-movies', items: [item(1), item(2)] },
        { id: 'trending-series', items: [item(5, 'tv')] },
      ] as HomeLists['discover'],
    });
    const fresh = lists({
      nextItems: [next('tmdb-tv-2-s01e01'), next('tmdb-tv-1-s01e01')],
      discover: [
        { id: 'trending-series', items: [item(5, 'tv')] },
        { id: 'trending-movies', items: [item(3), item(2), item(1)] },
      ] as HomeLists['discover'],
    });
    const merged = orderHome(shown, fresh);
    expect(ids(merged.nextItems)).toEqual(['tmdb-tv-1-s01e01', 'tmdb-tv-2-s01e01']);
    expect(merged.discover.map((row) => row.id)).toEqual(['trending-movies', 'trending-series']);
    expect(merged.discover[0]!.items.map((entry) => entry.tmdbId)).toEqual([1, 2, 3]);
  });
});

describe('homeLists', () => {
  it('drops Next up entries that are already in Continue watching and empty rows', () => {
    const result = homeLists(
      [
        { id: 'a', items: [] },
        { id: 'b', items: [item(1)] },
      ] as never,
      [watch('tmdb-tv-1-s01e02')],
      [next('tmdb-tv-1-s01e02'), next('tmdb-tv-2-s01e01')]
    );
    expect(ids(result.nextItems)).toEqual(['tmdb-tv-2-s01e01']);
    expect(result.discover.map((row) => row.id)).toEqual(['b']);
  });
});

describe('homeLead', () => {
  it('is the first Continue watching card, else Next up, else the top pick', () => {
    const discover = [{ id: 'r', items: [item(9)] }] as HomeLists['discover'];
    expect(homeLead(lists({ continueItems: [watch('tmdb-movie-4')], discover }))).toEqual({
      movie: 4,
    });
    expect(homeLead(lists({ continueItems: [watch('tmdb-tv-7-s02e03')] }))).toEqual({
      series: 7,
      season: 2,
    });
    expect(homeLead(lists({ nextItems: [next('tmdb-tv-8-s01e01')], discover }))).toEqual({
      series: 8,
    });
    expect(homeLead(lists({ discover }))).toEqual({ movie: 9 });
    expect(homeLead(lists({}))).toEqual({});
  });
});

describe('homeReady: one gate for the first render', () => {
  const done = { data: [], error: null };
  const pending = { data: undefined, error: null };
  const failed = { data: undefined, error: new Error('boom') };

  it('waits for every section and the lead detail', () => {
    expect(homeReady({ sections: [done, pending, done], lead: [], timedOut: false })).toBe(false);
    expect(homeReady({ sections: [done, done, done], lead: [pending], timedOut: false })).toBe(
      false
    );
    expect(homeReady({ sections: [done, done, done], lead: [done, null], timedOut: false })).toBe(
      true
    );
  });

  it('counts an error as an answer', () => {
    expect(homeReady({ sections: [done, failed, done], lead: [failed], timedOut: false })).toBe(
      true
    );
  });

  it('falls back after the timeout once any section answered', () => {
    expect(homeReady({ sections: [done, pending, pending], lead: [], timedOut: true })).toBe(true);
    expect(homeReady({ sections: [done, done, done], lead: [pending], timedOut: true })).toBe(true);
    // Nothing at all yet: the skeleton stays (an empty Home would claim there is nothing).
    expect(homeReady({ sections: [pending, pending, pending], lead: [], timedOut: true })).toBe(
      false
    );
  });
});
