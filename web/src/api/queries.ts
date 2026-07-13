import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  ApiKeyResponse,
  ChangePasswordRequest,
  CreateApiKeyRequest,
  CreatedApiKeyResponse,
  GeneralConfigResponse,
  GeneralConfigWrite,
  HealthResponse,
} from "./types";

// One place for every query key so cache invalidation stays consistent (BRIEF §9.2).
export const queryKeys = {
  health: ["health"] as const,
  generalConfig: ["config", "general"] as const,
  apiKeys: ["config", "apikeys"] as const,
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
