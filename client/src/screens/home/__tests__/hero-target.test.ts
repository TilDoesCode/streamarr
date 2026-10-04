import type { Featured } from '../featured';
import { featuredInfoHref } from '../home-hero';

const base: Featured = { key: 'k', kind: 'series', tmdbId: 19885, title: 'Sherlock', eyebrow: '' };

describe('Home hero "More info" (Q1-04/26/36)', () => {
  it('opens the series on the episode of the continue card the hero shows', () => {
    const featured: Featured = {
      ...base,
      episode: { workId: 'tmdb-tv-19885-s02e02', season: 2, episode: 2, playTitle: 'S2 E2' },
    };
    expect(featuredInfoHref(featured, undefined)).toEqual({
      pathname: '/series/[id]',
      params: { id: '19885', season: '2', episode: '2' },
    });
  });

  it('opens a discover series on its focus episode, a movie on its detail', () => {
    const detail = { season: 1, episode: 4 } as Parameters<typeof featuredInfoHref>[1];
    expect(featuredInfoHref(base, detail)).toEqual({
      pathname: '/series/[id]',
      params: { id: '19885', season: '1', episode: '4' },
    });
    expect(featuredInfoHref(base, undefined)).toEqual({
      pathname: '/series/[id]',
      params: { id: '19885' },
    });
    expect(featuredInfoHref({ ...base, kind: 'movie', tmdbId: 133701 }, undefined)).toEqual({
      pathname: '/movie/[id]',
      params: { id: '133701' },
    });
  });
});
