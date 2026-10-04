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

/** The episode a series is "at": the server's next episode, or the last played version on a resume point. */
export type SeriesFocus = NextEpisode & { lastReleaseId?: string | null };

/** One rule for Home, stage and phone detail: an episode with a resume point first (a replay too), then next up. */
export function seriesFocus(
  series: Pick<SeriesDetail, 'workId' | 'watch'>,
  resume?: readonly WatchState[] | null
): SeriesFocus | null {
  const next = series.watch.nextEpisode ?? null;
  const active = series.workId
    ? resume?.find(
        (state) =>
          state.seriesWorkId === series.workId &&
          !!state.workId &&
          (state.positionTicks ?? 0) > 0 &&
          state.seasonNumber != null &&
          state.episodeNumber != null
      )
    : undefined;
  if (!active || active.workId === next?.workId)
    return next && { ...next, lastReleaseId: active?.lastReleaseId };
  return {
    workId: active.workId,
    seasonNumber: active.seasonNumber!,
    episodeNumber: active.episodeNumber!,
    title: active.title,
    positionTicks: active.positionTicks,
    durationTicks: active.durationTicks,
    reason: 'resume',
    lastReleaseId: active.lastReleaseId,
  };
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
