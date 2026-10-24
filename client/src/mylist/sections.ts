import type { TFunction } from 'i18next';

import type { TitlePreview, TitleTarget } from '@/browse/title-open';

import type { MyListItem } from './queries';

export type ListSectionKey = 'new' | 'watching' | 'want' | 'caughtUp' | 'watched';

export type ListSection = { key: ListSectionKey; items: MyListItem[] };

const ORDER: readonly ListSectionKey[] = ['new', 'watching', 'want', 'caughtUp', 'watched'];

function sectionOf(item: MyListItem): ListSectionKey {
  if (item.isNew) return 'new';
  switch (item.status) {
    case 'watching':
      return 'watching';
    case 'caught_up':
      return 'caughtUp';
    case 'watched':
      return 'watched';
    default:
      return 'want';
  }
}

/** The list page's rows in their fixed order (new episodes first); empty rows are left out. */
export function listSections(items: readonly MyListItem[]): ListSection[] {
  const groups = new Map<ListSectionKey, MyListItem[]>();
  for (const item of items) {
    const key = sectionOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return ORDER.filter((key) => groups.has(key)).map((key) => ({ key, items: groups.get(key)! }));
}

/** Card title: a season names its series. */
export function listTitle(item: MyListItem): string {
  return (item.kind === 'season' ? item.seriesTitle : null) ?? item.title ?? '';
}

/** 0..1 for the card's bar: episodes played (series, season) or the movie's position. */
export function listProgress(item: MyListItem): number | undefined {
  if (item.status === 'watched' || item.status === 'want_to_watch') return undefined;
  if (item.kind === 'movie')
    return item.durationTicks && item.positionTicks
      ? Math.min(1, item.positionTicks / item.durationTicks)
      : undefined;
  const total = item.totalEpisodes ?? 0;
  return total > 0 ? Math.min(1, (item.playedEpisodes ?? 0) / total) : undefined;
}

/** Card subline: "S2, E5 · 12/20", "Next episode Mar 9", "Waiting for a release", "8 episodes". */
export function listSubline(
  item: MyListItem,
  t: TFunction,
  formatDate: (iso: string) => string
): string {
  const parts: string[] = [];
  if (item.kind === 'season' && item.title) parts.push(item.title);
  if (item.kind === 'movie') {
    if (item.year) parts.push(String(item.year));
    return parts.join(' · ');
  }
  const played = item.playedEpisodes ?? 0;
  const total = item.totalEpisodes ?? 0;
  const next = item.nextEpisode;
  if (item.status === 'want_to_watch') {
    if (total) parts.push(t('media.episodes', { count: total }));
  } else if (next && next.available !== false && item.status !== 'watched') {
    parts.push(t('media.episodeCode', { season: next.seasonNumber, episode: next.episodeNumber }));
    if (total) parts.push(t('mylist.progress', { played, total }));
  } else if (item.status === 'caught_up') {
    const upcoming = item.upcomingEpisode;
    parts.push(
      next
        ? t('mylist.waitingRelease')
        : upcoming?.airDate
          ? t('mylist.nextOn', { date: formatDate(upcoming.airDate) })
          : t('mylist.caughtUpShort')
    );
  } else if (total) {
    parts.push(t('mylist.progress', { played, total }));
  }
  return parts.join(' · ');
}

/** Where a card leads: the movie, or the series on the episode to watch (a season entry on its season). */
export function listTarget(item: MyListItem): { target: TitleTarget; preview: TitlePreview } {
  const next = item.nextEpisode;
  const target: TitleTarget =
    item.kind === 'movie'
      ? { kind: 'movie', tmdbId: item.tmdbId }
      : next
        ? {
            kind: 'series',
            tmdbId: item.tmdbId,
            season: next.seasonNumber,
            episode: next.episodeNumber,
          }
        : item.seasonNumber != null
          ? { kind: 'series', tmdbId: item.tmdbId, season: item.seasonNumber }
          : { kind: 'series', tmdbId: item.tmdbId };
  return {
    target,
    preview: {
      title: listTitle(item),
      backdropUrl: item.backdropUrl,
      backdropSizes: item.backdropSizes,
      tint: item.tint,
      tint2: item.tint2,
      year: item.year,
    },
  };
}
