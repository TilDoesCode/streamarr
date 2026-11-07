import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';

import { isAppError } from '@/api/errors';
import { platformSupportsDownloads } from '@/downloads/engine';

const MINUTE = 60_000;

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

/** `offlineShell`: the active server's queries pause offline, as the offline shell replaces their screens. */
export function createQueryClient(offlineShell = platformSupportsDownloads()): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE.default,
        gcTime: 30 * MINUTE,
        // Web/tvOS offline: fail into the screens' error state (retry, refetch on reconnect), not a paused skeleton (Q1-24).
        networkMode: 'always',
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
  // Only account keys pause: device, local-server, other-server and app-update queries keep running offline (C1-24).
  if (offlineShell) client.setQueryDefaults(['account'], { networkMode: 'online' });
  return client;
}

let managersReady = false;
let networkUp = true;
let serverReachable = true;
let applyOnline: ((online: boolean) => void) | null = null;

/** Where downloads exist, "online" also needs the server (paused mutations resume once it answers again). */
export function setServerReachable(reachable: boolean): void {
  serverReachable = reachable;
  applyOnline?.(networkUp && serverReachable);
}

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
  onlineManager.setEventListener((setOnline) => {
    applyOnline = setOnline;
    const unsubscribe = NetInfo.addEventListener((state) => {
      networkUp = state.isConnected !== false;
      setOnline(networkUp && serverReachable);
    });
    return () => {
      applyOnline = null;
      unsubscribe();
    };
  });
}
