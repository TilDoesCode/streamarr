import { parseWorkId } from '@/lib/work-id';

import { cardActions } from '../home-cards';

const ref = (workId: string) => parseWorkId(workId);

describe('Continue watching / Next up card actions', () => {
  it('an episode opens its series page on that season and episode, long press plays', () => {
    expect(cardActions(ref('tmdb-tv-7-s02e03'), true)).toEqual({
      press: { kind: 'open', target: { kind: 'series', tmdbId: 7, season: 2, episode: 3 } },
      longPress: { kind: 'play' },
    });
  });

  it('an episode without a version opens on both presses (no failing player)', () => {
    const open = { kind: 'open', target: { kind: 'series', tmdbId: 7, season: 3, episode: 1 } };
    expect(cardActions(ref('tmdb-tv-7-s03e01'), false)).toEqual({ press: open, longPress: open });
  });

  it('a movie keeps resuming on press and opens its page on long press', () => {
    const open = { kind: 'open', target: { kind: 'movie', tmdbId: 123 } };
    expect(cardActions(ref('tmdb-movie-123'), true)).toEqual({
      press: { kind: 'play' },
      longPress: open,
    });
    expect(cardActions(ref('tmdb-movie-123'), false)).toEqual({ press: open, longPress: open });
  });

  it('an unparsable work id still plays on press', () => {
    expect(cardActions(undefined, true)).toEqual({ press: { kind: 'play' } });
  });
});
