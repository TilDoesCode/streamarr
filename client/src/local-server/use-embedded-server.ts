import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

import {
  embeddedServer,
  type EmbeddedServerApi,
  type EmbeddedServerCredentials,
  type EmbeddedServerStatus,
} from '@modules/embedded-server';
import { AppError } from '@/api/errors';
import { PROBE_TIMEOUT_MS, xhrTransport, type ProbeTransport } from '@/api/http';
import { probeServer } from '@/api/probe';

import { localBaseUrl, loopbackUrl, toLocalServerError } from './model';

export const localServerKeys = {
  status: ['localServer', 'status'] as const,
  credentials: ['localServer', 'credentials'] as const,
  logs: ['localServer', 'logs'] as const,
  health: (baseUrl: string) => ['localServer', 'health', baseUrl] as const,
  viewer: (baseUrl: string) => ['localServer', 'viewer', baseUrl] as const,
};

/** Lines the log view asks for. */
export const LOG_LINES = 200;
/** Readiness probes repeat this often while the screen is visible and the server runs. */
export const READINESS_INTERVAL_MS = 3000;

const wrap =
  <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    try {
      return await call(...args);
    } catch (error) {
      throw toLocalServerError(error);
    }
  };

/** Status of the server on this device (live via the native listener) and its actions with pending states. */
export function useEmbeddedServer(api: EmbeddedServerApi = embeddedServer) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: localServerKeys.status,
    queryFn: wrap(() => api.getStatus()),
    enabled: api.supported,
    staleTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (!api.supported) return;
    const subscription = api.addStatusListener((next) =>
      queryClient.setQueryData(localServerKeys.status, next)
    );
    return () => subscription.remove();
  }, [api, queryClient]);

  const { refetch } = status;
  const refresh = useCallback(() => void refetch(), [refetch]);
  const onStatus = (next: EmbeddedServerStatus) =>
    queryClient.setQueryData(localServerKeys.status, next);
  const start = useMutation({ mutationFn: wrap(() => api.start()), onSuccess: onStatus });
  const stop = useMutation({ mutationFn: wrap(() => api.stop()), onSuccess: onStatus });
  const setAutostart = useMutation({
    mutationFn: wrap((enabled: boolean) => api.setAutostart(enabled)),
    onSuccess: onStatus,
  });
  const setPort = useMutation({
    mutationFn: wrap((port: number) => api.setPort(port)),
    onSuccess: onStatus,
  });
  const resetPassword = useMutation({
    mutationFn: wrap(() => api.resetAdminPassword()),
    onSuccess: (credentials: EmbeddedServerCredentials) =>
      queryClient.setQueryData(localServerKeys.credentials, credentials),
  });
  return {
    supported: api.supported,
    status: status.data ?? null,
    error: status.error,
    loading: api.supported && status.isPending,
    refresh,
    start,
    stop,
    setAutostart,
    setPort,
    resetPassword,
  };
}

/** Admin sign-in for the web UI; only read while the screen shows it. */
export function useServerCredentials(enabled: boolean, api: EmbeddedServerApi = embeddedServer) {
  return useQuery({
    queryKey: localServerKeys.credentials,
    queryFn: wrap(() => api.getCredentials()),
    enabled: api.supported && enabled,
    retry: false,
  });
}

export function useServerLogs(enabled: boolean, api: EmbeddedServerApi = embeddedServer) {
  return useQuery({
    queryKey: localServerKeys.logs,
    queryFn: wrap(() => api.getLogs(LOG_LINES)),
    enabled: api.supported && enabled,
    staleTime: 0,
    retry: false,
  });
}

/** Anonymous health endpoint of the local server; resolves with its version. */
export async function checkHealth(
  baseUrl: string,
  transport: ProbeTransport = xhrTransport
): Promise<{ version: string | null }> {
  const response = await transport(`${baseUrl}/api/v1/health`, PROBE_TIMEOUT_MS);
  if (response.status !== 200)
    throw new AppError(response.status >= 500 ? 'server_error' : 'not_streamarr', {
      status: response.status,
    });
  try {
    const body = JSON.parse(response.body) as { version?: string | null };
    return { version: body.version ?? null };
  } catch {
    throw new AppError('not_streamarr', { status: response.status });
  }
}

/** Live checks against the loopback address while `active` (screen visible) and the server runs. */
export function useReadinessProbes(status: EmbeddedServerStatus | null, active: boolean) {
  const running = status?.state === 'running';
  const baseUrl = status ? localBaseUrl(status) : loopbackUrl(0);
  const interval = active && running ? READINESS_INTERVAL_MS : false;
  const queryClient = useQueryClient();
  // A stopped server forgets its last results, so the next start checks from scratch.
  useEffect(() => {
    if (running) return;
    queryClient.removeQueries({ queryKey: localServerKeys.health(baseUrl) });
    queryClient.removeQueries({ queryKey: localServerKeys.viewer(baseUrl) });
  }, [running, baseUrl, queryClient]);
  const health = useQuery({
    queryKey: localServerKeys.health(baseUrl),
    queryFn: () => checkHealth(baseUrl),
    enabled: active && running,
    refetchInterval: interval,
    staleTime: 0,
    retry: false,
  });
  const viewer = useQuery({
    queryKey: localServerKeys.viewer(baseUrl),
    queryFn: () => probeServer(baseUrl),
    enabled: active && running && health.isSuccess,
    refetchInterval: interval,
    staleTime: 0,
    retry: false,
  });
  return { baseUrl, health, viewer };
}
