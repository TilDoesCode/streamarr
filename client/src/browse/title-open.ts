import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';

import { useActiveAccount } from '@/accounts/accounts-provider';
import type { ArtworkSizes } from '@/lib/artwork';
import { accountKey } from '@/query/keys';

import {
  movieDetailQuery,
  seasonDetailQuery,
  seriesDetailQuery,
  useDetailQueryContext,
  type CatalogItem,
  type DetailQueryContext,
} from './queries';
import { createDebouncer, initialSelection } from './series-selection';

/** A title a card or the hero leads to; a series may name the episode its page opens on. */
export type TitleTarget = {
  kind: 'movie' | 'series';
  tmdbId: number;
  season?: number;
  episode?: number;
};

/** What a list already knows about a title: the detail's first frame paints it before its own query answers. */
export type TitlePreview = {
  title?: string | null;
  backdropUrl?: string | null;
  backdropSizes?: ArtworkSizes | null;
  logoUrl?: string | null;
  tint?: string | null;
  tint2?: string | null;
  highlight?: string | null;
  year?: number | null;
  overview?: string | null;
};

// Focus has to rest this long on a card before its detail loads: a D-pad sweep fetches nothing.
export const PREFETCH_DELAY_MS = 300;

export function titleKind(mediaType: string | null | undefined): TitleTarget['kind'] {
  return mediaType === 'series' || mediaType === 'tv' ? 'series' : 'movie';
}

/** Detail route of a target (a series with its season/episode deep link). */
export function titleTargetHref(target: TitleTarget): Href {
  const id = String(target.tmdbId);
  if (target.kind === 'movie') return { pathname: '/movie/[id]', params: { id } };
  const { season, episode } = target;
  return {
    pathname: '/series/[id]',
    params: {
      id,
      ...(season !== undefined ? { season: String(season) } : null),
      ...(season !== undefined && episode !== undefined ? { episode: String(episode) } : null),
    },
  };
}

/** Target and preview of a catalog card (Home, Movies, Series, Search). */
export function catalogTitle(item: CatalogItem): { target: TitleTarget; preview: TitlePreview } {
  return {
    target: { kind: titleKind(item.mediaType), tmdbId: item.tmdbId },
    preview: {
      title: item.title,
      backdropUrl: item.backdropUrl,
      backdropSizes: item.backdropSizes,
      tint: item.tint,
      tint2: item.tint2,
      highlight: item.highlight,
      year: item.year,
      overview: item.overview,
    },
  };
}

export const previewKey = (accountId: string, kind: TitleTarget['kind'], tmdbId: number) =>
  accountKey(accountId, 'catalog', 'preview', kind, tmdbId);

export function seedTitlePreview(
  queryClient: QueryClient,
  accountId: string,
  target: TitleTarget,
  preview: TitlePreview
) {
  queryClient.setQueryData(previewKey(accountId, target.kind, target.tmdbId), preview);
}

/** The preview seeded for this title (read once: the page's own data replaces it). */
export function useTitlePreview(
  kind: TitleTarget['kind'],
  tmdbId: number | undefined
): TitlePreview | undefined {
  const queryClient = useQueryClient();
  const { account } = useActiveAccount();
  const [preview] = useState(() =>
    tmdbId === undefined
      ? undefined
      : queryClient.getQueryData<TitlePreview>(previewKey(account.id, kind, tmdbId))
  );
  return preview;
}

/** Loads a title's detail (a series also the season its page opens on) into the cache; never throws. */
export async function prefetchTitle(
  queryClient: QueryClient,
  context: DetailQueryContext,
  target: TitleTarget
): Promise<void> {
  // Fresh cache entries (the client's default stale time) are not fetched again.
  if (target.kind === 'movie') {
    await queryClient.prefetchQuery(movieDetailQuery(context, target.tmdbId));
    return;
  }
  const season = (number: number) =>
    queryClient.prefetchQuery(seasonDetailQuery(context, target.tmdbId, number));
  // A deep-linked season loads alongside the series instead of after it.
  const early = target.season !== undefined ? season(target.season) : undefined;
  const series = seriesDetailQuery(context, target.tmdbId);
  await queryClient.prefetchQuery(series);
  const data = queryClient.getQueryData(series.queryKey);
  const selection = data
    ? initialSelection(data, { season: target.season, episode: target.episode })
    : undefined;
  if (selection && selection.season !== target.season) await season(selection.season);
  await early;
}

/** Prefetch on focus: `schedule` after the focus rested (debounced), `cancel` on blur; cancelled on unmount. */
export function usePrefetchTitle() {
  const queryClient = useQueryClient();
  const context = useDetailQueryContext();
  const [debouncer] = useState(() => createDebouncer(PREFETCH_DELAY_MS));
  useEffect(() => () => debouncer.cancel(), [debouncer]);
  return {
    schedule: (target: TitleTarget) =>
      debouncer.schedule(() => void prefetchTitle(queryClient, context, target)),
    cancel: debouncer.cancel,
  };
}

/**
 * Opens a title's detail at once: seeds what the list knows (the page's first frame), starts its queries
 * and pushes the route in the same press. Nothing is awaited before the navigation.
 */
export function useOpenTitle() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const context = useDetailQueryContext();
  return (target: TitleTarget, preview?: TitlePreview) => {
    if (preview) seedTitlePreview(queryClient, context.accountId, target, preview);
    void prefetchTitle(queryClient, context, target);
    router.push(titleTargetHref(target));
  };
}
