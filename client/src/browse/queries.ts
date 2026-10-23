import {
  focusManager,
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import type { components } from '@/api/schema';
import { rememberedAudioLanguage } from '@/player/audio-preference';
import { preferredEngine, subscribeCapabilityOverrides } from '@/player/capability-overrides';
import { loadDeviceCaps, useDeviceProfile, versionHints } from '@/player/device-profile';
import { rankingLanguage } from '@/player/version-languages';
import type { DeviceProfile } from '@modules/media-caps';

import { genreName, localizeDetail } from './catalog-labels';
import { fetchLibraryPage, type LibraryKind, type LibrarySort } from './library';
import { seriesFocus } from './series-selection';

import { accountKey, queryKeys } from '@/query/keys';
import { accountPersister, readPersisted } from '@/query/persist';
import { STALE } from '@/query/query-client';

/** Catalog texts come in the app language (Accept-Language): it is part of every metadata key, so a switch refetches. */
function useMetadataLanguage(): string {
  const { i18n } = useTranslation();
  return i18n.language === 'de' ? 'de' : 'en';
}

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
  const language = useMetadataLanguage();
  return useInfiniteQuery({
    queryKey: accountKey(account.id, 'catalog', 'browse', kind, genre, sort, language),
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
  const language = useMetadataLanguage();
  const { t } = useTranslation();
  return useQuery({
    queryKey: accountKey(account.id, 'catalog', 'genres', kind, language),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/catalog/genres', { params: { query: { type: kind } }, signal })
      ).then((response) =>
        (response.genres ?? []).map((genre) => ({
          ...genre,
          name: genre.name ? genreName(genre.name, t) : genre.name,
        }))
      ),
    staleTime: STALE.homeRows,
  });
}

// Server maximum (ViewerCatalogService.MaxSearchResults); more is rejected as invalid_query.
const SEARCH_LIMIT = 20;
const HOME_LIST_LIMIT = 20;

/**
 * Persisted per account in MMKV and restored synchronously as initial data: a cold start renders the last
 * known answer in its first frame (with its real age, so a stale one refetches in the background).
 */
function persisted<T extends { queryKey: QueryKey }>(accountId: string, options: T, on = true): T {
  if (!on) return options;
  return {
    ...options,
    persister: accountPersister(accountId).persisterFn,
    initialData: () => readPersisted(accountId, options.queryKey)?.data,
    initialDataUpdatedAt: () => readPersisted(accountId, options.queryKey)?.updatedAt,
  };
}

/** Discover rows of the active account; persisted per account in MMKV so they show instantly. */
export function useHomeRows() {
  const { account, client } = useActiveAccount();
  const language = useMetadataLanguage();
  return useQuery(
    persisted(
      account.id,
      queryOptions({
        queryKey: queryKeys.discover(account.id, language),
        queryFn: ({ signal }) =>
          unwrap(client.GET('/api/v1/viewer/catalog/discover', { signal })).then(
            (response) => response.rows ?? []
          ),
        staleTime: STALE.homeRows,
      })
    )
  );
}

/** Persisted like the rows: Home's first frame already has its Continue watching row. */
export function useContinueWatching() {
  const { account, client } = useActiveAccount();
  const language = useMetadataLanguage();
  return useQuery(
    persisted(
      account.id,
      queryOptions({
        queryKey: accountKey(account.id, 'watch', 'resume', language),
        queryFn: ({ signal }) =>
          unwrap(
            client.GET('/api/v1/viewer/watch/resume', {
              params: { query: { limit: HOME_LIST_LIMIT } },
              signal,
            })
          ),
      })
    )
  );
}

/** The series' current episode; continue watching (when loaded) adds its last played version, never another episode. */
export function useSeriesFocus(series: SeriesDetail | undefined) {
  const resume = useContinueWatching();
  return series ? seriesFocus(series, resume.data) : null;
}

/** Persisted like the rows: Home's first frame already has its Next up row. */
export function useNextUp() {
  const { account, client } = useActiveAccount();
  const language = useMetadataLanguage();
  return useQuery(
    persisted(
      account.id,
      queryOptions({
        queryKey: accountKey(account.id, 'watch', 'next-up', language),
        queryFn: ({ signal }) =>
          unwrap(
            client.GET('/api/v1/viewer/watch/next-up', {
              params: { query: { limit: HOME_LIST_LIMIT } },
              signal,
            })
          ).then((response) => response.items ?? []),
      })
    )
  );
}

type DetailClient = ReturnType<typeof useActiveAccount>['client'];

/** What a detail query needs besides its ids (account, client, metadata language, translator). */
export type DetailQueryContext = {
  accountId: string;
  client: DetailClient;
  language: string;
  t: TFunction;
};

/** The detail query context of the active account (for prefetching outside the screens' hooks). */
export function useDetailQueryContext(): DetailQueryContext {
  const { account, client } = useActiveAccount();
  const language = useMetadataLanguage();
  const { t } = useTranslation();
  return { accountId: account.id, client, language, t };
}

/** Movie detail query (shared by the screen, the hero and prefetching). */
export function movieDetailQuery(context: DetailQueryContext, tmdbId: number | undefined) {
  const { accountId, client, language, t } = context;
  return queryOptions({
    queryKey: accountKey(accountId, 'catalog', 'movie', tmdbId, language),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/catalog/movies/{tmdbId}', {
          params: { path: { tmdbId: tmdbId ?? 0 } },
          signal,
        })
      ).then((detail) => localizeDetail(detail, t)),
  });
}

/** Series detail query (shared by the screen, the hero and prefetching). */
export function seriesDetailQuery(context: DetailQueryContext, tmdbId: number | undefined) {
  const { accountId, client, language, t } = context;
  return queryOptions({
    queryKey: accountKey(accountId, 'catalog', 'series', tmdbId, language),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/catalog/series/{tmdbId}', {
          params: { path: { tmdbId: tmdbId ?? 0 } },
          signal,
        })
      ).then((detail) => localizeDetail(detail, t)),
  });
}

/** One season; `availability` adds per-episode version counts (a cached indexer search on the server). */
export function seasonDetailQuery(
  context: DetailQueryContext,
  tmdbId: number | undefined,
  season: number | undefined,
  availability = false
) {
  const { accountId, client, language } = context;
  return queryOptions({
    queryKey: accountKey(
      accountId,
      'catalog',
      'series',
      tmdbId,
      'season',
      season,
      ...(availability ? ['availability'] : []),
      language
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
  });
}

/** `persist`: kept in MMKV like Home's rows (only Home's lead title asks, so the cache stays small). */
type DetailOptions = { persist?: boolean };

export function useMovieDetail(
  tmdbId: number | undefined,
  enabled = true,
  { persist = false }: DetailOptions = {}
) {
  const context = useDetailQueryContext();
  const known = tmdbId !== undefined;
  return useQuery(
    persisted(
      context.accountId,
      { ...movieDetailQuery(context, tmdbId), enabled: enabled && known },
      persist && known
    )
  );
}

export function useSeriesDetail(
  tmdbId: number | undefined,
  enabled = true,
  { persist = false }: DetailOptions = {}
) {
  const context = useDetailQueryContext();
  const known = tmdbId !== undefined;
  return useQuery(
    persisted(
      context.accountId,
      { ...seriesDetailQuery(context, tmdbId), enabled: enabled && known },
      persist && known
    )
  );
}

/** `availability` adds per-episode version counts (a cached indexer search on the server). */
export function useSeasonDetail(
  tmdbId: number | undefined,
  season: number | undefined,
  availability = false,
  { persist = false }: DetailOptions = {}
) {
  const context = useDetailQueryContext();
  const known = tmdbId !== undefined && season !== undefined;
  return useQuery(
    persisted(
      context.accountId,
      {
        ...seasonDetailQuery(context, tmdbId, season, availability),
        enabled: known,
        placeholderData: keepPreviousData,
      },
      persist && known
    )
  );
}

/** Season for a detail screen: shows the fast listing first, then the one with version counts. */
export function useSeasonWithVersions(tmdbId: number | undefined, season: number | undefined) {
  const base = useSeasonDetail(tmdbId, season);
  const counted = useSeasonDetail(tmdbId, season, true);
  return counted.data && !counted.isPlaceholderData ? counted : base;
}

export function useSearch(query: string, type: SearchType, enabled: boolean) {
  const { account, client } = useActiveAccount();
  const language = useMetadataLanguage();
  return useQuery({
    queryKey: accountKey(account.id, 'catalog', 'search', type, query, language),
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

/** The audio language the server ranks versions by: the one last picked in the player, else the app's (as a plain Play ranks). */
export function useAudioLanguages(): string {
  const { account } = useActiveAccount();
  const app = useMetadataLanguage();
  return rankingLanguage(rememberedAudioLanguage(account.id)) ?? app;
}

/** The engine preference new playbacks start with (capabilities settings), so the list ranks like Play. */
function usePreferredEngine(): 'native' | 'vlc' | undefined {
  return useSyncExternalStore(subscribeCapabilityOverrides, () => preferredEngine()?.engine);
}

/** Ranked versions with the predicted method for this device (once its profile is known). */
function useVersionsOptions() {
  const { account, client } = useActiveAccount();
  const language = useMetadataLanguage();
  const audioLanguages = useAudioLanguages();
  const engine = usePreferredEngine();
  const profile = useDeviceProfile();
  // A failed capability probe still lists the versions, just without predictions.
  const ready = profile.data !== undefined || profile.isError;
  const options = (
    workId: string | null | undefined,
    device: DeviceProfile | undefined,
    cachedOnly = false
  ) => {
    const hints = device ? versionHints(device) : undefined;
    return {
      queryKey: accountKey(
        account.id,
        'catalog',
        'versions',
        workId,
        hints ?? null,
        language,
        audioLanguages,
        engine ?? null,
        ...(cachedOnly ? ['cachedOnly'] : [])
      ),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        unwrap(
          client.GET('/api/v1/viewer/catalog/works/{workId}/versions', {
            params: {
              path: { workId: workId ?? '' },
              query: {
                ...hints,
                audioLanguages,
                ...(engine ? { engine } : null),
                ...(cachedOnly ? { cachedOnly } : null),
              },
            },
            signal,
          })
        ),
      staleTime: 5 * 60_000,
    };
  };
  return { options, ready, device: profile.data };
}

export function useVersions(workId: string | null | undefined, enabled = true) {
  const { options, ready, device } = useVersionsOptions();
  return useQuery({ ...options(workId, device), enabled: enabled && !!workId && ready });
}

/**
 * Versions for a screen that must not wait for an indexer search (the home hero): the loaded list,
 * else the server's cached one; undefined while neither is known. A cached answer also fills the
 * full list, so the detail page opens with it.
 */
export function useCachedVersions(workId: string | null | undefined): Version[] | undefined {
  const queryClient = useQueryClient();
  const { options, ready, device } = useVersionsOptions();
  const full = options(workId, device);
  const peek = options(workId, device, true);
  const loaded = useQuery({ ...full, enabled: false });
  const cached = useQuery({
    ...peek,
    queryFn: async (context: { signal: AbortSignal }) => {
      const response = await peek.queryFn(context);
      if (!response.cacheMiss && !queryClient.getQueryData(full.queryKey))
        queryClient.setQueryData(full.queryKey, response);
      return response;
    },
    enabled: !!workId && ready && !loaded.data,
    staleTime: 60_000,
  });
  const list = loaded.data ?? (cached.data?.cacheMiss ? undefined : cached.data);
  return list?.versions ?? undefined;
}

/** Loads a work's versions on demand (same cache key as useVersions: it waits for the device profile first). */
export function useFetchVersions() {
  const queryClient = useQueryClient();
  const { options } = useVersionsOptions();
  return async (workId: string) => {
    const device = await queryClient
      .ensureQueryData({
        // Same query as useDeviceProfile.
        queryKey: ['device', 'profile'],
        queryFn: () => loadDeviceCaps().then((caps) => caps.profile),
        staleTime: Infinity,
        gcTime: Infinity,
      })
      .catch(() => undefined);
    const response = await queryClient.fetchQuery(options(workId, device));
    return response.versions ?? [];
  };
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
