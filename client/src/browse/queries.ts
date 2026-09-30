import {
  focusManager,
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import type { components } from '@/api/schema';
import { useDeviceProfile, versionHints } from '@/player/device-profile';

import { fetchLibraryPage, type LibraryKind, type LibrarySort } from './library';
import { accountKey, queryKeys } from '@/query/keys';
import { accountPersister } from '@/query/persist';
import { STALE } from '@/query/query-client';

export type CatalogItem = components['schemas']['CatalogItemDto'];
export type CatalogRow = components['schemas']['CatalogRowDto'];
export type MovieDetail = components['schemas']['CatalogMovieResponse'];
export type SeriesDetail = components['schemas']['CatalogSeriesResponse'];
export type SeasonDetail = components['schemas']['CatalogSeasonResponse'];
export type Episode = components['schemas']['CatalogEpisodeDto'];
export type NextEpisode = components['schemas']['CatalogNextEpisodeDto'];
export type WatchState = components['schemas']['WatchStateResponse'];
export type NextUpItem = components['schemas']['NextUpItemResponse'];
export type Version = components['schemas']['VersionDto'];
export type SearchType = 'any' | 'movie' | 'tv';
export type Genre = components['schemas']['CatalogGenreDto'];
/** Movies/Series page: TMDB discover by genre and sort, paged on `hasMore`. */
export function useLibrary(kind: LibraryKind, genre: number | null, sort: LibrarySort) {
  const { account, client } = useActiveAccount();
  return useInfiniteQuery({
    queryKey: accountKey(account.id, 'catalog', 'browse', kind, genre, sort),
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchLibraryPage(
        (page) =>
          unwrap(
            client.GET('/api/v1/viewer/catalog/browse', {
              params: { query: { type: kind, sort, page, ...(genre ? { genre } : null) } },
              signal,
            })
          ),
        pageParam
      ),
    getNextPageParam: (last) => last.nextPage,
    staleTime: STALE.homeRows,
  });
}

export function useGenres(kind: LibraryKind) {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: accountKey(account.id, 'catalog', 'genres', kind),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/catalog/genres', { params: { query: { type: kind } }, signal })
      ).then((response) => response.genres ?? []),
    staleTime: STALE.homeRows,
  });
}

// Server maximum (ViewerCatalogService.MaxSearchResults); more is rejected as invalid_query.
export const SEARCH_LIMIT = 20;
const HOME_LIST_LIMIT = 20;

/** Discover rows of the active account; persisted per account in MMKV so they show instantly. */
export function useHomeRows() {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: queryKeys.discover(account.id),
    queryFn: ({ signal }) =>
      unwrap(client.GET('/api/v1/viewer/catalog/discover', { signal })).then(
        (response) => response.rows ?? []
      ),
    staleTime: STALE.homeRows,
    persister: accountPersister(account.id).persisterFn,
  });
}

export function useContinueWatching() {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: accountKey(account.id, 'watch', 'resume'),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/watch/resume', {
          params: { query: { limit: HOME_LIST_LIMIT } },
          signal,
        })
      ),
  });
}

export function useNextUp() {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: accountKey(account.id, 'watch', 'next-up'),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/watch/next-up', {
          params: { query: { limit: HOME_LIST_LIMIT } },
          signal,
        })
      ).then((response) => response.items ?? []),
  });
}

export function useMovieDetail(tmdbId: number | undefined, enabled = true) {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: accountKey(account.id, 'catalog', 'movie', tmdbId),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/catalog/movies/{tmdbId}', {
          params: { path: { tmdbId: tmdbId ?? 0 } },
          signal,
        })
      ),
    enabled: enabled && tmdbId !== undefined,
  });
}

export function useSeriesDetail(tmdbId: number | undefined, enabled = true) {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: accountKey(account.id, 'catalog', 'series', tmdbId),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/catalog/series/{tmdbId}', {
          params: { path: { tmdbId: tmdbId ?? 0 } },
          signal,
        })
      ),
    enabled: enabled && tmdbId !== undefined,
  });
}

/** `availability` adds per-episode version counts (a cached indexer search on the server). */
export function useSeasonDetail(
  tmdbId: number | undefined,
  season: number | undefined,
  availability = false
) {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: accountKey(
      account.id,
      'catalog',
      'series',
      tmdbId,
      'season',
      season,
      ...(availability ? ['availability'] : [])
    ),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/catalog/series/{tmdbId}/seasons/{seasonNumber}', {
          params: {
            path: { tmdbId: tmdbId ?? 0, seasonNumber: season ?? 0 },
            query: availability ? { availability: true } : undefined,
          },
          signal,
        })
      ),
    enabled: tmdbId !== undefined && season !== undefined,
    placeholderData: keepPreviousData,
  });
}

/** Season for a detail screen: shows the fast listing first, then the one with version counts. */
export function useSeasonWithVersions(tmdbId: number | undefined, season: number | undefined) {
  const base = useSeasonDetail(tmdbId, season);
  const counted = useSeasonDetail(tmdbId, season, true);
  return counted.data && !counted.isPlaceholderData ? counted : base;
}

export function useSearch(query: string, type: SearchType, enabled: boolean) {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: accountKey(account.id, 'catalog', 'search', type, query),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/catalog/search', {
          params: { query: { q: query, type, limit: SEARCH_LIMIT } },
          signal,
        })
      ).then((response) => response.items ?? []),
    enabled,
    placeholderData: (previous) => previous,
  });
}

/** Ranked versions with the predicted method for this device (once its profile is known). */
export function useVersions(workId: string | null | undefined, enabled = true) {
  const { account, client } = useActiveAccount();
  const profile = useDeviceProfile();
  const hints = profile.data ? versionHints(profile.data) : undefined;
  // A failed capability probe still lists the versions, just without predictions.
  const ready = profile.data !== undefined || profile.isError;
  return useQuery({
    queryKey: accountKey(account.id, 'catalog', 'versions', workId, hints ?? null),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/catalog/works/{workId}/versions', {
          params: { path: { workId: workId ?? '' }, query: hints },
          signal,
        })
      ),
    enabled: enabled && !!workId && ready,
    staleTime: 5 * 60_000,
  });
}

/** Marks works played or unplayed and refreshes every watch-dependent query of the account. */
export function useMarkPlayed() {
  const { account, client } = useActiveAccount();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workIds, played }: { workIds: string[]; played: boolean }) =>
      unwrap(
        client.POST(played ? '/api/v1/viewer/watch/played' : '/api/v1/viewer/watch/unplayed', {
          body: { workIds },
        })
      ),
    onSettled: () => invalidateWatchQueries(queryClient, account.id),
  });
}

/** Refetches everything that shows watch state (after marking or playing). */
export function invalidateWatchQueries(queryClient: QueryClient, accountId: string) {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === 'account' &&
      queryKey[1] === accountId &&
      (queryKey[2] === 'watch' ||
        (queryKey[2] === 'catalog' && (queryKey[3] === 'movie' || queryKey[3] === 'series'))),
  });
}

/** Refetches watch state when the screen regains focus (not on its first focus: the queries just loaded). */
export function useWatchRefreshOnFocus() {
  const { account } = useActiveAccount();
  const queryClient = useQueryClient();
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) first.current = false;
      else void invalidateWatchQueries(queryClient, account.id);
    }, [queryClient, account.id])
  );
}

/** Refetches watch state when the app returns to the foreground (web: the tab becomes visible). */
export function useWatchRefreshOnForeground(accountId: string) {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      focusManager.subscribe((focused) => {
        if (focused) void invalidateWatchQueries(queryClient, accountId);
      }),
    [queryClient, accountId]
  );
}
