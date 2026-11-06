import { createContext, use, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { createMMKV } from 'react-native-mmkv';

import { useAccountsApi, type AccountsApi } from '@/accounts/accounts-provider';
import { deviceName } from '@/api/device';
import { useConnectivity } from '@/connectivity/provider';
import { downloadEngine, platformSupportsDownloads, type DownloadEngine } from '@/downloads/engine';
import i18n from '@/i18n';
import { profileOrFallback } from '@/player/caps-fallback';
import { loadDeviceCaps } from '@/player/device-profile';

import { createArtworkFetcher, type ArtworkFetcher } from './artwork';
import { downloadAccountKey } from './keys';
import { DownloadManager } from './manager';
import { createDownloadsServerApi, policyOf, type DownloadsServerApi } from './server';
import { createMemoryDownloadsStorage, DOWNLOADS_STORAGE_ID, DownloadStore } from './store';
import type { OfflineDownload } from './types';

type Permissions = Parameters<typeof policyOf>[0];

export type DownloadsContextValue = { manager: DownloadManager; engine: DownloadEngine };

const DownloadsContext = createContext<DownloadsContextValue | null>(null);
/** Hooks' context without the provider's side effects (`DownloadsTestProvider`). */
export const DownloadsContextForTests = DownloadsContext;

type DownloadsOverride = {
  engine?: DownloadEngine;
  store?: DownloadStore;
  artwork?: ArtworkFetcher;
};
let override: DownloadsOverride | null = null;

/** App-level tests: the next DownloadsProvider uses this engine/store/artwork (`installTestDownloads`). */
export function setDownloadsOverride(value: DownloadsOverride | null): void {
  override = value;
}

let defaultStore: DownloadStore | undefined;

/** The device's download store (MMKV `streamarr.downloads`; memory where downloads do not exist). */
export function getDefaultDownloadStore(): DownloadStore {
  defaultStore ??= new DownloadStore({
    storage: platformSupportsDownloads()
      ? createMMKV({ id: DOWNLOADS_STORAGE_ID })
      : createMemoryDownloadsStorage(),
  });
  return defaultStore;
}

let current: DownloadsContextValue | null = null;

/** The running manager for non-React callers (player controller); null before the provider mounted. */
export function getDownloadManager(): DownloadManager | null {
  return current?.manager ?? null;
}

export function getDownloadEngine(): DownloadEngine {
  return current?.engine ?? downloadEngine;
}

/** "Sherlock · S2 E3" / movie title for the Android notification. */
export function notificationTitle(download: OfflineDownload): string {
  const title = download.meta.title || download.meta.seriesTitle || '';
  if (download.kind === 'movie') return title;
  return i18n.t('downloads.notification.episode', {
    series: download.meta.seriesTitle || title,
    season: download.seasonNumber ?? 0,
    episode: download.episodeNumber ?? 0,
  });
}

/** Server access per owner key through the accounts' clients (only signed-in profiles). */
export function serverResolver(api: Pick<AccountsApi, 'store' | 'clientFor'>) {
  const cache = new Map<string, DownloadsServerApi>();
  return (accountKey: string): DownloadsServerApi | null => {
    const account = api.store
      .getSnapshot()
      .accounts.find((item) => item.signedIn && downloadAccountKey(item) === accountKey);
    if (!account) return null;
    const key = `${account.id}|${account.serverUrl}`;
    let server = cache.get(key);
    if (!server) {
      server = createDownloadsServerApi(api.clientFor(account.id), account.serverUrl);
      cache.set(key, server);
    }
    return server;
  };
}

export function createAppDownloadManager(
  api: Pick<AccountsApi, 'store' | 'clientFor'>,
  engine: DownloadEngine = downloadEngine,
  store: DownloadStore = getDefaultDownloadStore(),
  artwork: ArtworkFetcher = createArtworkFetcher(engine)
): DownloadManager {
  return new DownloadManager({
    engine,
    store,
    serverFor: serverResolver(api),
    deviceProfile: () => profileOrFallback(loadDeviceCaps),
    deviceName,
    artwork,
    notificationTitle,
  });
}

export type DownloadsProviderProps = {
  children: ReactNode;
  /** Tests and previews: a manager over a fake engine (`createTestDownloads`). */
  manager?: DownloadManager;
  engine?: DownloadEngine;
};

/** Runs the download queue for the app's lifetime (inside AccountsProvider and ConnectivityProvider). */
export function DownloadsProvider({
  children,
  manager: injected,
  engine: injectedEngine,
}: DownloadsProviderProps) {
  const api = useAccountsApi();
  const [value] = useState<DownloadsContextValue>(() => {
    const engine = injectedEngine ?? override?.engine ?? downloadEngine;
    return {
      manager:
        injected ??
        createAppDownloadManager(
          api,
          engine,
          override?.store ?? getDefaultDownloadStore(),
          override?.artwork ?? createArtworkFetcher(engine)
        ),
      engine,
    };
  });
  const { manager } = value;
  const connectivity = useConnectivity();
  const wasOffline = useRef(connectivity.offline);

  useEffect(() => {
    current = value;
    const detach = manager.attach();
    return () => {
      detach();
      if (current === value) current = null;
    };
  }, [manager, value]);

  // Each /viewer/me answer keeps the profile's age rules for offline use (downloads lock by them).
  useEffect(
    () =>
      api.queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'success') return;
        const [scope, accountId, kind] = event.query.queryKey as unknown[];
        if (scope !== 'account' || kind !== 'me' || event.query.queryKey.length !== 3) return;
        const account = api.store.getSnapshot().accounts.find((item) => item.id === accountId);
        const data = event.action.data as { permissions?: Permissions | null } | undefined;
        if (account && data)
          manager.store.setPolicy(
            downloadAccountKey(account),
            policyOf(data.permissions ?? null, Date.now())
          );
      }),
    [api, manager]
  );

  useEffect(() => {
    const owners = () =>
      api.store
        .getSnapshot()
        .accounts.filter((account) => account.signedIn)
        .map(downloadAccountKey);
    let known = owners().join('\n');
    manager.setKnownOwners(owners());
    return api.store.subscribe(() => {
      const next = owners().join('\n');
      if (next === known) return;
      const before = new Set(known.split('\n'));
      known = next;
      manager.setKnownOwners(owners());
      manager.resumeSignedOut(owners().filter((owner) => !before.has(owner)));
    });
  }, [api, manager]);

  useEffect(() => {
    if (wasOffline.current && !connectivity.offline) {
      manager.wake();
      void manager.reconcileServers();
    }
    wasOffline.current = connectivity.offline;
  }, [connectivity.offline, manager]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') manager.wake();
      else manager.store.flush();
    });
    return () => subscription.remove();
  }, [manager]);

  // Dev builds: Argent's debugger-evaluate starts and inspects downloads (device checks).
  useEffect(() => {
    if (__DEV__) Object.assign(globalThis, { __streamarrDownloadManager: value.manager });
  }, [value]);

  return <DownloadsContext value={value}>{children}</DownloadsContext>;
}

export function useDownloadsContext(): DownloadsContextValue {
  const context = use(DownloadsContext);
  if (!context)
    throw new Error('downloads hooks need <DownloadsProvider> (tests: DownloadsTestProvider)');
  return context;
}

/** The context if mounted (components that also render outside the provider). */
export function useOptionalDownloadsContext(): DownloadsContextValue | null {
  return use(DownloadsContext);
}
