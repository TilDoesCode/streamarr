import i18n from '@/i18n';

import type { MyListItem } from '../queries';
import { listProgress, listSections, listSubline, listTarget, listTitle } from '../sections';
import { badgeText } from '../tab-badge';

const t = i18n.t.bind(i18n);
const date = (iso: string) => `on ${iso}`;

const base = { tmdbId: 1, source: 'auto', addedAt: '2026-01-01T00:00:00Z' };
const item = (over: Partial<MyListItem>): MyListItem =>
  ({
    ...base,
    workId: 'tmdb-tv-1',
    kind: 'series',
    title: 'Show',
    status: 'watching',
    ...over,
  }) as MyListItem;
const next = (season: number, episode: number, available = true) => ({
  workId: `tmdb-tv-1-s0${season}e0${episode}`,
  seasonNumber: season,
  episodeNumber: episode,
  reason: 'next',
  available,
});

beforeAll(() => i18n.changeLanguage('en'));

describe('My List sections', () => {
  it('orders the rows new, watching, want to watch, caught up, watched and leaves empty ones out', () => {
    const sections = listSections([
      item({ workId: 'a', status: 'watched' }),
      item({ workId: 'b', status: 'caught_up' }),
      item({ workId: 'c', status: 'watching', isNew: true }),
      item({ workId: 'd', status: 'want_to_watch' }),
      item({ workId: 'e', status: 'watching' }),
    ]);
    expect(sections.map((section) => [section.key, section.items.map((i) => i.workId)])).toEqual([
      ['new', ['c']],
      ['watching', ['e']],
      ['want', ['d']],
      ['caughtUp', ['b']],
      ['watched', ['a']],
    ]);
    expect(listSections([item({ status: 'watched' })]).map((section) => section.key)).toEqual([
      'watched',
    ]);
  });

  it('says where the viewer stands', () => {
    const watching = item({ playedEpisodes: 12, totalEpisodes: 20, nextEpisode: next(2, 5) });
    expect(listSubline(watching, t, date)).toBe('S2, E5 · 12/20');
    expect(listProgress(watching)).toBeCloseTo(0.6);

    const waiting = item({
      status: 'caught_up',
      playedEpisodes: 4,
      totalEpisodes: 5,
      nextEpisode: next(1, 5, false),
    });
    expect(listSubline(waiting, t, date)).toBe('Not available yet');

    const upcoming = item({
      status: 'caught_up',
      playedEpisodes: 5,
      totalEpisodes: 5,
      upcomingEpisode: { ...next(1, 6), reason: 'upcoming', airDate: '2026-11-01' },
    });
    expect(listSubline(upcoming, t, date)).toBe('Next episode on 2026-11-01');

    expect(listSubline(item({ status: 'want_to_watch', totalEpisodes: 8 }), t, date)).toBe(
      '8 episodes'
    );
    const season = item({
      kind: 'season',
      workId: 'tmdb-tv-1-s02',
      seasonNumber: 2,
      title: 'Season 2',
      seriesTitle: 'Show',
      status: 'watched',
      playedEpisodes: 8,
      totalEpisodes: 8,
    });
    expect(listTitle(season)).toBe('Show');
    expect(listSubline(season, t, date)).toBe('Season 2 · 8/8');
    expect(listProgress(season)).toBeUndefined();

    const movie = item({
      kind: 'movie',
      workId: 'tmdb-movie-1',
      year: 2024,
      positionTicks: 30,
      durationTicks: 120,
    });
    expect(listSubline(movie, t, date)).toBe('2024');
    expect(listProgress(movie)).toBe(0.25);
  });

  it('opens a series on the episode to watch and a season entry on its season', () => {
    expect(listTarget(item({ nextEpisode: next(2, 5) })).target).toEqual({
      kind: 'series',
      tmdbId: 1,
      season: 2,
      episode: 5,
    });
    expect(listTarget(item({ kind: 'season', seasonNumber: 3, status: 'watched' })).target).toEqual(
      { kind: 'series', tmdbId: 1, season: 3 }
    );
    expect(listTarget(item({ kind: 'movie', tmdbId: 9 })).target).toEqual({
      kind: 'movie',
      tmdbId: 9,
    });
  });

  it('caps the badge text', () => {
    expect([1, 9, 10, 42].map(badgeText)).toEqual(['1', '9', '9+', '9+']);
  });
});
