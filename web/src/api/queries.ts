import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  ApiKeyResponse,
  ChangePasswordRequest,
  CachedReleaseResponse,
  CreateApiKeyRequest,
  CreatedApiKeyResponse,
  DebugSearchRequest,
  DebugSearchResponse,
  GeneralConfigResponse,
  GeneralConfigWrite,
  EphemeralFileResponse,
  HealthResponse,
  NotificationConfigResponse,
  NotificationConfigWrite,
  NotificationTestResponse,
  IndexerResponse,
  IndexerTestResult,
  IndexerWrite,
  MetricsResponse,
  ProviderResponse,
  ProviderSpeedTestRequest,
  ProviderSpeedTestResult,
  ProviderTestResult,
  ProviderWrite,
  ProfileImportPreviewRequest,
  ProfileImportPreviewResponse,
  ProfileImportRequest,
  QualityProfile,
  ReorderRequest,
  ResolveRequest,
  ResolveResponse,
  SearchResponse,
  SessionResponse,
  StreamingHistoryResponse,
  TvSeasonDetailsResponse,
  TvSeriesDetailsResponse,
  TvSeriesSearchResponse,
} from "./types";

// One place for every query key so cache invalidation stays consistent (BRIEF §9.2).
export const queryKeys = {
  health: (deep: boolean) => ["health", deep] as const,
  generalConfig: ["config", "general"] as const,
  notificationConfig: ["config", "notifications"] as const,
  apiKeys: ["config", "apikeys"] as const,
  indexers: ["config", "indexers"] as const,
  providers: ["config", "providers"] as const,
  profiles: ["config", "profiles"] as const,
  sessions: ["sessions"] as const,
  metrics: ["metrics"] as const,
  cachedReleases: ["library", "cached-releases"] as const,
  ephemeralFiles: ["ephemeral-files"] as const,
  streamingHistory: ["streaming-history"] as const,
  resolvedRelease: (releaseId: string, workId?: string) =>
    ["resolve", releaseId, workId ?? null] as const,
  tvSeries: (tmdbId: number) => ["tv", tmdbId] as const,
  tvSeason: (tmdbId: number, seasonNumber: number) => ["tv", tmdbId, "season", seasonNumber] as const,
};

/**
 * Service health (BRIEF §9.1 dashboard). `deep` runs the per-indexer/per-provider
 * reachability probes; pass `false` for a cheap liveness ping.
 */
export function useHealth({ deep = true, enabled = true, refetchInterval = 15_000 } = {}) {
  return useQuery({
    queryKey: queryKeys.health(deep),
    queryFn: ({ signal }) => apiFetch<HealthResponse>("/health", { query: { deep }, signal }),
    enabled,
    refetchInterval,
  });
}

// ---- Resolve + sessions (BRIEF §9.1.6/§9.1.7) ----------------------------------------

export interface SemanticSearchRequest {
  q: string;
  type?: "movie" | "tv";
  season?: number;
  episode?: number;
  imdbId?: string;
  tmdbId?: number;
  profileId?: string;
}

/**
 * User-facing discovery through the production /search contract. Unlike /debug/search,
 * this returns only TMDB-identified works with at least one accepted release.
 */
export function useSemanticSearch() {
  return useMutation({
    mutationFn: (query: SemanticSearchRequest) =>
      apiFetch<SearchResponse>("/search", {
        query: {
          q: query.q,
          type: query.type,
          season: query.season,
          episode: query.episode,
          imdbId: query.imdbId,
          tmdbId: query.tmdbId,
          profileId: query.profileId,
        },
      }),
  });
}

/** TMDB-ranked TV works only; Core caps this at three and performs no indexer calls. */
export function useTvSeriesSearch() {
  return useMutation({
    mutationFn: ({ q, limit = 3 }: { q: string; limit?: number }) =>
      apiFetch<TvSeriesSearchResponse>("/tv/search", { query: { q, limit } }),
  });
}

/** Load the season directory only when a series is opened. */
export function useTvSeriesDetails(tmdbId: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.tvSeries(tmdbId),
    queryFn: ({ signal }) => apiFetch<TvSeriesDetailsResponse>(`/tv/${tmdbId}`, { signal }),
    enabled: enabled && tmdbId > 0,
    staleTime: 5 * 60_000,
  });
}

/**
 * Load canonical episodes and run one season-scoped indexer fan-out. The server and client
 * both cache this unit, so expanding individual episode rows never creates another search.
 */
export function useTvSeasonDetails(tmdbId: number, seasonNumber: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.tvSeason(tmdbId, seasonNumber),
    queryFn: ({ signal }) =>
      apiFetch<TvSeasonDetailsResponse>(`/tv/${tmdbId}/seasons/${seasonNumber}`, { signal }),
    enabled: enabled && tmdbId > 0 && seasonNumber >= 0,
    staleTime: 60_000,
    // A season lookup fans out across every configured indexer. Keep focus and network
    // transitions from silently repeating that expensive operation; callers can invalidate
    // the query explicitly when the operator asks for fresh availability.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/**
 * Resolve a release: fetch NZB, health-check, open a session, pre-probe media info, and
 * return a stream URL (BRIEF §6.2 POST /resolve). A mutation — the operator triggers it on
 * demand from the debug playground and the playback-preview canary.
 */
export function useResolve() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ResolveRequest) =>
      apiFetch<ResolveResponse>("/resolve", { method: "POST", body }),
    // A successful resolve opens a session — reflect it in the sessions list.
    onSuccess: (data, variables) => {
      // Reuse the exact session when Search hands off to Playback. Resolving the same release
      // again would create a duplicate session and leave the first one orphaned.
      const sessionLifetimeMs = Math.max(60_000, (data.sessionTtlSeconds ?? 3_600) * 1_000);
      qc.setQueryDefaults(["resolve"], { gcTime: sessionLifetimeMs });
      qc.setQueryData(
        queryKeys.resolvedRelease(variables.releaseId ?? "", variables.workId ?? undefined),
        data,
      );
      qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

/** Live session list (BRIEF §9.1.7), polled so the view stays current without SSE. */
export function useSessions({ enabled = true, refetchInterval = 3_000 } = {}) {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: ({ signal }) => apiFetch<SessionResponse[]>("/sessions", { signal }),
    enabled,
    refetchInterval,
  });
}

/** Global transport pressure used to put a single stream's NNTP usage in context. */
export function useMetrics({ enabled = true, refetchInterval = 3_000 } = {}) {
  return useQuery({
    queryKey: queryKeys.metrics,
    queryFn: ({ signal }) => apiFetch<MetricsResponse>("/metrics", { signal }),
    enabled,
    refetchInterval,
  });
}

/** Force-close a live session (BRIEF §9.1.7). */
export function useCloseSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      apiFetch<void>(`/sessions/${encodeURIComponent(token)}/close`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}

/** Persistent NZB cache library. */
export function useCachedReleases() {
  return useQuery({
    queryKey: queryKeys.cachedReleases,
    queryFn: ({ signal }) => apiFetch<CachedReleaseResponse[]>("/library/releases", { signal }),
  });
}

export function useRemoveCachedRelease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (releaseId: string) =>
      apiFetch<void>(`/library/releases/${encodeURIComponent(releaseId)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cachedReleases }),
  });
}

/** Live ephemeral media files, including chunk progress and active cache footprint. */
export function useEphemeralFiles({ refetchInterval = 3_000 } = {}) {
  return useQuery({
    queryKey: queryKeys.ephemeralFiles,
    queryFn: ({ signal }) => apiFetch<EphemeralFileResponse[]>("/ephemeral-files", { signal }),
    refetchInterval,
  });
}

/** Playback events with the external Jellyfin account attached. */
export function useStreamingHistory(limit = 200) {
  return useQuery({
    queryKey: [...queryKeys.streamingHistory, limit],
    queryFn: ({ signal }) =>
      apiFetch<StreamingHistoryResponse[]>("/events", { query: { limit }, signal }),
  });
}

export function useGeneralConfig() {
  return useQuery({
    queryKey: queryKeys.generalConfig,
    queryFn: ({ signal }) => apiFetch<GeneralConfigResponse>("/config/general", { signal }),
  });
}

export function useUpdateGeneralConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (write: GeneralConfigWrite) =>
      apiFetch<GeneralConfigResponse>("/config/general", { method: "PUT", body: write }),
    onSuccess: (data) => {
      qc.setQueryData(queryKeys.generalConfig, data);
    },
  });
}

export function useNotificationConfig() {
  return useQuery({
    queryKey: queryKeys.notificationConfig,
    queryFn: ({ signal }) =>
      apiFetch<NotificationConfigResponse>("/config/notifications", { signal }),
  });
}

export function useUpdateNotificationConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (write: NotificationConfigWrite) =>
      apiFetch<NotificationConfigResponse>("/config/notifications", { method: "PUT", body: write }),
    onSuccess: (data) => qc.setQueryData(queryKeys.notificationConfig, data),
  });
}

export function useTestNotification() {
  return useMutation({
    mutationFn: () =>
      apiFetch<NotificationTestResponse>("/config/notifications/test", { method: "POST" }),
  });
}

export function useApiKeys() {
  return useQuery({
    queryKey: queryKeys.apiKeys,
    queryFn: ({ signal }) => apiFetch<ApiKeyResponse[]>("/config/apikeys", { signal }),
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateApiKeyRequest) =>
      apiFetch<CreatedApiKeyResponse>("/config/apikeys", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/config/apikeys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: ChangePasswordRequest) =>
      apiFetch<void>("/auth/password", { method: "POST", body }),
  });
}

// ---- Indexers (BRIEF §9.1.2) ---------------------------------------------------------

export function useIndexers() {
  return useQuery({
    queryKey: queryKeys.indexers,
    queryFn: ({ signal }) => apiFetch<IndexerResponse[]>("/config/indexers", { signal }),
  });
}

export function useCreateIndexer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: IndexerWrite) =>
      apiFetch<IndexerResponse>("/config/indexers", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.indexers }),
  });
}

export function useUpdateIndexer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: IndexerWrite }) =>
      apiFetch<IndexerResponse>(`/config/indexers/${id}`, { method: "PUT", body }),
    // Optimistic update (BRIEF §9.2): reflect the edit immediately, roll back on error.
    onMutate: async ({ id, body }) => {
      await qc.cancelQueries({ queryKey: queryKeys.indexers });
      const previous = qc.getQueryData<IndexerResponse[]>(queryKeys.indexers);
      qc.setQueryData<IndexerResponse[]>(queryKeys.indexers, (old) =>
        old?.map((ix): IndexerResponse => (ix.id === id ? ({ ...ix, ...body, id } as IndexerResponse) : ix)),
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(queryKeys.indexers, ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.indexers }),
  });
}

/** Atomically replace indexer priority order. The server validates the complete id set. */
export function useReorderIndexers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<void>("/config/indexers/order", {
        method: "PUT",
        body: { ids } satisfies ReorderRequest,
      }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: queryKeys.indexers });
      const previous = qc.getQueryData<IndexerResponse[]>(queryKeys.indexers);
      const priority = new Map(ids.map((id, index) => [id, index]));
      qc.setQueryData<IndexerResponse[]>(queryKeys.indexers, (old) =>
        old?.map((item) => ({ ...item, priority: priority.get(item.id ?? "") ?? item.priority })),
      );
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) qc.setQueryData(queryKeys.indexers, context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.indexers }),
  });
}

export function useDeleteIndexer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/config/indexers/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.indexers }),
  });
}

export function useTestIndexer() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<IndexerTestResult>(`/config/indexers/${id}/test`, { method: "POST" }),
  });
}

/**
 * Add a download host to an indexer's allow-list. Used by the resolve failure UI when the
 * server rejects an NZB download whose host isn't the indexer's BaseUrl origin (BRIEF §6.3):
 * fetch the current indexer, append the host (api key omitted → server keeps it), and PUT.
 */
export function useAllowIndexerDownloadHost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ indexerId, host }: { indexerId: string; host: string }) => {
      const indexer = await apiFetch<IndexerResponse>(`/config/indexers/${indexerId}`);
      const hosts = indexer.allowedDownloadHosts ?? [];
      if (hosts.some((h) => h.toLowerCase() === host.toLowerCase())) return indexer;
      const body: IndexerWrite = {
        name: indexer.name,
        baseUrl: indexer.baseUrl,
        categories: indexer.categories,
        allowedDownloadHosts: [...hosts, host],
        enabled: indexer.enabled,
        priority: indexer.priority,
      };
      return apiFetch<IndexerResponse>(`/config/indexers/${indexerId}`, { method: "PUT", body });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.indexers }),
  });
}

// ---- Usenet providers (BRIEF §9.1.3) -------------------------------------------------

export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers,
    queryFn: ({ signal }) => apiFetch<ProviderResponse[]>("/config/providers", { signal }),
  });
}

export function useCreateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProviderWrite) =>
      apiFetch<ProviderResponse>("/config/providers", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.providers }),
  });
}

export function useUpdateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ProviderWrite }) =>
      apiFetch<ProviderResponse>(`/config/providers/${id}`, { method: "PUT", body }),
    onMutate: async ({ id, body }) => {
      await qc.cancelQueries({ queryKey: queryKeys.providers });
      const previous = qc.getQueryData<ProviderResponse[]>(queryKeys.providers);
      qc.setQueryData<ProviderResponse[]>(queryKeys.providers, (old) =>
        old?.map((p): ProviderResponse => (p.id === id ? ({ ...p, ...body, id } as ProviderResponse) : p)),
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(queryKeys.providers, ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.providers }),
  });
}

/** Atomically replace provider priority order. The server validates the complete id set. */
export function useReorderProviders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<void>("/config/providers/order", {
        method: "PUT",
        body: { ids } satisfies ReorderRequest,
      }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: queryKeys.providers });
      const previous = qc.getQueryData<ProviderResponse[]>(queryKeys.providers);
      const priority = new Map(ids.map((id, index) => [id, index]));
      qc.setQueryData<ProviderResponse[]>(queryKeys.providers, (old) =>
        old?.map((item) => ({ ...item, priority: priority.get(item.id ?? "") ?? item.priority })),
      );
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) qc.setQueryData(queryKeys.providers, context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.providers }),
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/config/providers/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.providers }),
  });
}

export function useTestProvider() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ProviderTestResult>(`/config/providers/${id}/test`, { method: "POST" }),
  });
}

/** Download a bounded real NNTP payload sample and rate its video-streaming headroom. */
export function useSpeedTestProvider() {
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ProviderSpeedTestRequest }) =>
      apiFetch<ProviderSpeedTestResult>(`/config/providers/${id}/speedtest`, {
        method: "POST",
        body,
      }),
  });
}

// ---- Quality profiles (BRIEF §9.1.4) -------------------------------------------------

export function useProfiles() {
  return useQuery({
    queryKey: queryKeys.profiles,
    queryFn: ({ signal }) => apiFetch<QualityProfile[]>("/config/profiles", { signal }),
  });
}

export function useCreateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: QualityProfile) =>
      apiFetch<QualityProfile>("/config/profiles", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.profiles }),
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: QualityProfile }) =>
      apiFetch<QualityProfile>(`/config/profiles/${id}`, { method: "PUT", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.profiles }),
  });
}

export function useDeleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/config/profiles/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.profiles }),
  });
}

export function usePreviewProfileImport() {
  return useMutation({
    mutationFn: (body: ProfileImportPreviewRequest) =>
      apiFetch<ProfileImportPreviewResponse>("/config/profiles/import/preview", {
        method: "POST",
        body,
      }),
  });
}

export function useImportProfiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileImportRequest) =>
      apiFetch<QualityProfile[]>("/config/profiles/import", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.profiles }),
  });
}

/**
 * Live-preview ranking (BRIEF §9.1.4): run a sample query through /debug/search with the
 * unsaved draft profile in the body, so the editor shows how it reorders results before
 * anything is saved. It is a mutation (not a query) — the operator runs it on demand.
 */
export function useDebugSearch() {
  return useMutation({
    mutationFn: (body: DebugSearchRequest) =>
      apiFetch<DebugSearchResponse>("/debug/search", { method: "POST", body }),
  });
}
