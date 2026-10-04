import { useEffect, useState } from 'react';

import type { Episode, NextEpisode, SeriesDetail, WatchState } from '@/browse/queries';

/** TV focus previews a card after this much rest (same as the home hero). */
export const PREVIEW_DELAY_MS = 150;

/** The episode the series Bühne shows; `episode: null` = the season's entry episode. */
export type Selection = { season: number; episode: number | null };

type Season = NonNullable<SeriesDetail['seasons']>[number];

/** Regular seasons in order, specials (season 0) last. */
export function orderedSeasons(seasons: readonly Season[] | null | undefined): Season[] {
  return [...(seasons ?? [])].sort((a, b) => (a.seasonNumber || 1e6) - (b.seasonNumber || 1e6));
}

/** The series' current episode (the server's `nextEpisode`) with the version last played on it. */
export type SeriesFocus = NextEpisode & { lastReleaseId?: string | null };

/** The server decides the current episode (B9: an active replay wins); continue watching only adds the version. */
export function seriesFocus(
  series: Pick<SeriesDetail, 'watch'>,
  resume?: readonly WatchState[] | null
): SeriesFocus | null {
  const next = series.watch.nextEpisode ?? null;
  if (!next) return null;
  const entry = next.workId ? resume?.find((state) => state.workId === next.workId) : undefined;
  return { ...next, lastReleaseId: entry?.lastReleaseId };
}

/** Start: deep link (?season=&episode=), else the series focus, else the first regular season. */
export function initialSelection(
  series: Pick<SeriesDetail, 'seasons' | 'watch'>,
  params: { season?: number; episode?: number },
  focus: NextEpisode | null | undefined = series.watch.nextEpisode
): Selection | undefined {
  const seasons = orderedSeasons(series.seasons);
  if (params.season !== undefined && seasons.some((s) => s.seasonNumber === params.season))
    return { season: params.season, episode: params.episode ?? null };
  const next = focus;
  if (next) return { season: next.seasonNumber, episode: next.episodeNumber };
  return seasons[0] ? { season: seasons[0].seasonNumber, episode: null } : undefined;
}

/** A season's entry episode: the next one if it is in this season, else the first unwatched aired, else the first. */
export function seasonEntry(
  episodes: readonly Episode[],
  nextWorkId?: string | null
): Episode | undefined {
  return (
    episodes.find((episode) => !!nextWorkId && episode.workId === nextWorkId) ??
    episodes.find((episode) => !episode.watch.played && episode.aired !== false) ??
    episodes[0]
  );
}

/** The selected episode of a loaded season. */
export function selectedEpisode(
  episodes: readonly Episode[],
  selection: Selection,
  nextWorkId?: string | null
): Episode | undefined {
  return (
    (selection.episode !== null
      ? episodes.find((episode) => episode.episodeNumber === selection.episode)
      : undefined) ?? seasonEntry(episodes, nextWorkId)
  );
}

/** Runs a task after `delay` ms of rest; a newer task replaces a pending one. */
export function createDebouncer(delay = PREVIEW_DELAY_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule: (task: () => void) => {
      clearTimeout(timer);
      timer = setTimeout(task, delay);
    },
    cancel: () => clearTimeout(timer),
  };
}

/** createDebouncer for a component; a pending task is dropped on unmount. */
export function useDebounced(delay = PREVIEW_DELAY_MS) {
  const [debouncer] = useState(() => createDebouncer(delay));
  useEffect(() => debouncer.cancel, [debouncer]);
  return debouncer;
}
