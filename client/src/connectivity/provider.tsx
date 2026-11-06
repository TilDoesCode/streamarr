import NetInfo from '@react-native-community/netinfo';
import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { useAccountsApi, useActiveServerUrl } from '@/accounts/accounts-provider';
import { platformSupportsDownloads } from '@/downloads/engine';

import {
  ConnectivityMonitor,
  createHealthProbe,
  isOfflineState,
  type ConnectivitySnapshot,
  type NetworkSource,
} from './monitor';

const netInfoSource: NetworkSource = {
  subscribe: (listener) =>
    NetInfo.addEventListener((state) =>
      listener({ isConnected: state.isConnected, type: state.type })
    ),
  fetch: () =>
    NetInfo.fetch().then((state) => ({ isConnected: state.isConnected, type: state.type })),
};

const ConnectivityContext = createContext<ConnectivityMonitor | null>(null);

export type ConnectivityProviderProps = {
  children: ReactNode;
  monitor?: ConnectivityMonitor;
  /** Default: only where downloads exist (web and Apple TV keep today's behaviour). */
  enabled?: boolean;
};

export function ConnectivityProvider({
  children,
  monitor: injected,
  enabled = platformSupportsDownloads(),
}: ConnectivityProviderProps) {
  const api = useAccountsApi();
  const serverUrl = useActiveServerUrl();
  const [monitor] = useState(
    () =>
      injected ?? new ConnectivityMonitor({ probe: createHealthProbe(), network: netInfoSource })
  );

  useEffect(() => {
    if (!enabled) return;
    monitor.start();
    return () => monitor.stop();
  }, [monitor, enabled]);

  useEffect(
    () => monitor.setServer(enabled ? (serverUrl ?? null) : null),
    [monitor, serverUrl, enabled]
  );

  useEffect(() => {
    if (!enabled) return;
    const queries = api.queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      if (event.action.type === 'error') monitor.reportFailure(event.action.error);
    });
    const mutations = api.queryClient.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error')
        monitor.reportFailure(event.action.error);
    });
    const appState = AppState.addEventListener('change', (status) => {
      if (status === 'active') monitor.resume();
    });
    return () => {
      queries();
      mutations();
      appState.remove();
    };
  }, [api, monitor, enabled]);

  return <ConnectivityContext value={monitor}>{children}</ConnectivityContext>;
}

const ONLINE: ConnectivitySnapshot = {
  state: 'online',
  serverUrl: null,
  networkConnected: null,
  since: 0,
  lastOnlineAt: null,
  nextProbeAt: null,
};
const NO_SUBSCRIPTION = () => () => undefined;
const ONLINE_SNAPSHOT = () => ONLINE;

export type Connectivity = ConnectivitySnapshot & {
  offline: boolean;
  /** Probes the server now ("Try again"). */
  retry(): Promise<void>;
};

/** Reachability of the active profile's server; always online outside the provider and where downloads do not exist. */
export function useConnectivity(): Connectivity {
  const monitor = use(ConnectivityContext);
  const snapshot = useSyncExternalStore(
    monitor?.subscribe ?? NO_SUBSCRIPTION,
    monitor?.getSnapshot ?? ONLINE_SNAPSHOT,
    monitor?.getSnapshot ?? ONLINE_SNAPSHOT
  );
  return useMemo(
    () => ({
      ...snapshot,
      offline: isOfflineState(snapshot.state),
      retry: () => monitor?.retry() ?? Promise.resolve(),
    }),
    [snapshot, monitor]
  );
}

/** The monitor itself (non-React callers such as the progress sync). */
export function useConnectivityMonitor(): ConnectivityMonitor | null {
  return use(ConnectivityContext);
}
