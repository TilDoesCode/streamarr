import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';

import { isAppError } from '@/api/errors';

export const MINUTE = 60_000;

/** Stale times per kind of data; rows and details change slowly, the viewer's own state often. */
export const STALE = {
  default: MINUTE,
  profile: 5 * MINUTE,
  homeRows: 30 * MINUTE,
  serverOptions: MINUTE,
} as const;

const MAX_RETRIES = 2;

/** Retries transport failures, 5xx and 429 twice; never 4xx answers (they will not change) or timeouts (the budget is spent). */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  return (
    failureCount < MAX_RETRIES && isAppError(error) && error.isTransient && error.code !== 'timeout'
  );
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE.default,
        gcTime: 30 * MINUTE,
        retry: shouldRetry,
        retryDelay: (attempt, error) =>
          isAppError(error) && error.retryAfter !== undefined
            ? error.retryAfter * 1000
            : Math.min(1000 * 2 ** attempt, 8000),
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: { retry: false },
    },
  });
}

let managersReady = false;

/** App foreground → focus, NetInfo connectivity → online (web keeps the browser's own events). */
export function setupQueryManagers(): void {
  if (managersReady || Platform.OS === 'web') return;
  managersReady = true;
  focusManager.setEventListener((setFocused) => {
    const subscription = AppState.addEventListener('change', (status) =>
      setFocused(status === 'active')
    );
    return () => subscription.remove();
  });
  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => setOnline(state.isConnected !== false))
  );
}
