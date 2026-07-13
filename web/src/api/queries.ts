import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  ApiKeyResponse,
  ChangePasswordRequest,
  CreateApiKeyRequest,
  CreatedApiKeyResponse,
  DebugSearchRequest,
  DebugSearchResponse,
  GeneralConfigResponse,
  GeneralConfigWrite,
  HealthResponse,
  IndexerResponse,
  IndexerTestResult,
  IndexerWrite,
  ProviderResponse,
  ProviderTestResult,
  ProviderWrite,
  QualityProfile,
} from "./types";

// One place for every query key so cache invalidation stays consistent (BRIEF §9.2).
export const queryKeys = {
  health: ["health"] as const,
  generalConfig: ["config", "general"] as const,
  apiKeys: ["config", "apikeys"] as const,
  indexers: ["config", "indexers"] as const,
  providers: ["config", "providers"] as const,
  profiles: ["config", "profiles"] as const,
};

export function useHealth(enabled = true) {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => apiFetch<HealthResponse>("/health", { query: { deep: false }, signal }),
    enabled,
    refetchInterval: 15_000,
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
