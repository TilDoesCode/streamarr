import { detailHref, isDetailOf, openerLeaf } from '@/navigation/routes';

const stack = (opener: { name: string; params?: object }) => ({
  index: 1,
  routes: [
    {
      name: '(tabs)',
      state: {
        index: 0,
        routes: [{ name: '(home)', state: { index: 1, routes: [{ name: 'index' }, opener] } }],
      },
    },
    { name: 'play/[playbackId]', params: { playbackId: 'new' } },
  ],
});

describe('Back to details', () => {
  it('goes back when the opener is the detail screen of the title', () => {
    expect(
      isDetailOf(openerLeaf(stack({ name: 'movie/[id]', params: { id: '603' } })), 'tmdb-movie-603')
    ).toBe(true);
    expect(
      isDetailOf(
        openerLeaf(stack({ name: 'series/[id]/index', params: { id: '19885' } })),
        'tmdb-tv-19885-s02e03'
      )
    ).toBe(true);
    expect(
      isDetailOf(
        openerLeaf(stack({ name: 'series/[id]/season/[n]', params: { id: '19885', n: '2' } })),
        'tmdb-tv-19885-s02e03'
      )
    ).toBe(true);
  });

  it('replaces the player when the opener is Home, another title or missing', () => {
    expect(isDetailOf(openerLeaf(stack({ name: 'index' })), 'tmdb-movie-603')).toBe(false);
    expect(
      isDetailOf(openerLeaf(stack({ name: 'movie/[id]', params: { id: '604' } })), 'tmdb-movie-603')
    ).toBe(false);
    expect(
      isDetailOf(openerLeaf(stack({ name: 'movie/[id]', params: { id: '1' } })), 'tmdb-tv-1-s01e01')
    ).toBe(false);
    expect(
      isDetailOf(
        openerLeaf({ index: 0, routes: [{ name: 'play/[playbackId]' }] }),
        'tmdb-movie-603'
      )
    ).toBe(false);
    expect(isDetailOf(openerLeaf(undefined), 'tmdb-movie-603')).toBe(false);
  });

  it('opens movies, series and the season of an episode', () => {
    expect(detailHref('tmdb-movie-603')).toEqual({
      pathname: '/movie/[id]',
      params: { id: '603' },
    });
    expect(detailHref('tmdb-tv-19885')).toEqual({
      pathname: '/series/[id]',
      params: { id: '19885' },
    });
    expect(detailHref('tmdb-tv-19885-s02e03')).toEqual({
      pathname: '/series/[id]',
      params: { id: '19885', season: '2' },
    });
    expect(detailHref('garbage')).toBeUndefined();
  });
});
