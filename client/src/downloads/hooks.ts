import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useAccounts, useAccountsApi } from '@/accounts/accounts-provider';
import type { Account } from '@/accounts/types';
import { unwrap } from '@/api/client';
import { platformSupportsDownloads, type StorageInfo } from '@/downloads/engine';
import { queryKeys } from '@/query/keys';
import { STALE } from '@/query/query-client';

import { downloadAccountKey, normalizeSeasonId } from './keys';
import { availableFrom, bytesOnDevice, downloadProgress, groupLibrary } from './library';
import { resolveLocalPlayTarget } from './local-play';
import { isActiveDownload, remainingBytes } from './manager';
import { useDownloadsContext } from './provider';
import type {
  DownloadRequestItem,
  DownloadSettings,
  DownloadStorage,
  DownloadsSupport,
  LocalPlayTarget,
  LocalPosition,
  OfflineArtwork,
  OfflineDownload,
  OfflineDownloadState,
  OfflineLibrary,
} from './types';

/** Every download on the device; a new array on every store change (state, progress, positions, settings). */
export function useDownloadsSnapshot(): readonly OfflineDownload[] {
  const { store } = useDownloadsContext().manager;
  return useSyncExternalStore(store.subscribe, store.all, store.all);
}

/** Owner key of the active profile (null without one). */
export function useActiveDownloadAccountKey(): string | null {
  const { accounts, activeId } = useAccounts();
  const account = accounts.find((item) => item.id === activeId);
  return account ? downloadAccountKey(account) : null;
}

/** The active profile's downloads, grouped (Series → Season → Episode, Movies). */
export function useDownloads(): OfflineLibrary {
  const all = useDownloadsSnapshot();
  const accountKey = useActiveDownloadAccountKey();
  return useMemo(() => groupLibrary(accountKey, all), [accountKey, all]);
}

export type DownloadForWork = {
  download: OfflineDownload | null;
  state: OfflineDownloadState | null;
  /** 0–1; null before the size is known. */
  progress: number | null;
  bytesPerSecond: number;
  /** A finished file: Play/Resume starts it (also online). */
  playable: boolean;
  position: LocalPosition | null;
};

/** The active profile's download of a movie or episode. */
export function useDownloadFor(workId: string | null | undefined): DownloadForWork {
  const { store } = useDownloadsContext().manager;
  const all = useDownloadsSnapshot();
  const accountKey = useActiveDownloadAccountKey();
  return useMemo(() => {
    const download =
      all.find((item) => item.accountKey === accountKey && item.workId === workId) ?? null;
    return {
      download,
      state: download?.state ?? null,
      progress: download ? downloadProgress(download) : null,
      bytesPerSecond: download ? (store.liveOf(download.id)?.bytesPerSecond ?? 0) : 0,
      playable: download?.state === 'done',
      position: accountKey && workId && all ? store.position(accountKey, workId) : null,
    };
  }, [store, all, accountKey, workId]);
}

export type SeasonDownloads = {
  items: OfflineDownload[];
  /** Finished episodes ("5/10": the season's episode count comes from the catalog). */
  downloaded: number;
  /** Queued … verifying. */
  inProgress: number;
  failed: number;
  bytes: number;
};

export function useSeasonDownloads(seasonId: string | null | undefined): SeasonDownloads {
  const all = useDownloadsSnapshot();
  const accountKey = useActiveDownloadAccountKey();
  return useMemo(() => {
    const season = seasonId ? normalizeSeasonId(seasonId) : null;
    const items = season
      ? all.filter((item) => item.accountKey === accountKey && item.seasonId === season)
      : [];
    return {
      items,
      downloaded: items.filter((item) => item.state === 'done').length,
      inProgress: items.filter(isActiveDownload).length,
      failed: items.filter((item) => item.state === 'failed').length,
      bytes: items.reduce((sum, item) => sum + bytesOnDevice(item), 0),
    };
  }, [all, accountKey, seasonId]);
}

/** Unfinished downloads of the active profile (navigation badge). */
export function useActiveDownloadCount(): number {
  const library = useDownloads();
  return library.active.filter((download) => download.state !== 'failed').length;
}

const STORAGE_REFRESH_MS = 10_000;

/** Free/used space of the device's download volume; refreshed every 10 s and when downloads come or go. */
export function useDownloadStorage(): DownloadStorage | null {
  const { manager } = useDownloadsContext();
  const all = useDownloadsSnapshot();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [tick, setTick] = useState(0);
  const shape = useMemo(() => all.map((item) => `${item.id}:${item.state}`).join(), [all]);

  useEffect(() => {
    if (!manager.supported) return;
    const timer = setInterval(() => setTick((value) => value + 1), STORAGE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [manager]);

  useEffect(() => {
    if (!manager.supported) return;
    let alive = true;
    manager
      .storage()
      .then((next) => alive && setInfo(next))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [manager, shape, tick]);

  return useMemo(() => {
    if (!info) return null;
    const usedBytes = all.reduce((sum, download) => sum + bytesOnDevice(download), 0);
    const committedBytes = all.reduce((sum, download) => sum + remainingBytes(download), 0);
    return {
      freeBytes: info.freeBytes,
      totalBytes: info.totalBytes,
      usedBytes,
      otherBytes: Math.max(0, info.totalBytes - info.freeBytes - usedBytes),
      committedBytes,
      availableBytes: availableFrom(info.freeBytes, committedBytes),
    };
  }, [info, all]);
}

/** Platform + engine + the viewer's `allowDownloads` permission (default on). */
export function useDownloadsSupported(): DownloadsSupport {
  const { engine } = useDownloadsContext();
  const api = useAccountsApi();
  const { accounts, activeId } = useAccounts();
  const account = accounts.find((item) => item.id === activeId);
  const platform = platformSupportsDownloads();
  const me = useQuery({
    queryKey: queryKeys.me(account?.id ?? ''),
    queryFn: ({ signal }) =>
      unwrap(api.clientFor(account!.id).GET('/api/v1/viewer/me', { signal })),
    enabled: platform && engine.isSupported && !!account?.signedIn,
    staleTime: STALE.profile,
  });
  if (!platform) return { supported: false, reason: 'platform' };
  if (!engine.isSupported) return { supported: false, reason: 'engine' };
  if (!account?.signedIn) return { supported: false, reason: 'signed_out' };
  if (me.data?.permissions?.allowDownloads === false)
    return { supported: false, reason: 'permission' };
  return { supported: true, reason: null };
}

export type DownloadActions = {
  start(items: DownloadRequestItem[]): Promise<OfflineDownload[]>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  removeSeason(seasonId: string): Promise<void>;
  removeSeries(seriesId: string): Promise<void>;
  removeAll(): Promise<void>;
  removeWatched(): Promise<void>;
};

const noAccount = () => Promise.reject(new Error('no active profile'));

/** Manager actions bound to the active profile. */
export function useDownloadActions(): DownloadActions {
  const { manager } = useDownloadsContext();
  const accountKey = useActiveDownloadAccountKey();
  return useMemo(
    () => ({
      start: (items) => (accountKey ? manager.start(accountKey, items) : noAccount()),
      pause: (id) => manager.pause(id),
      resume: (id) => manager.resume(id),
      retry: (id) => manager.retry(id),
      remove: (id) => manager.remove(id),
      removeSeason: (seasonId) =>
        accountKey ? manager.removeSeason(accountKey, seasonId) : noAccount(),
      removeSeries: (seriesId) =>
        accountKey ? manager.removeSeries(accountKey, seriesId) : noAccount(),
      removeAll: () => (accountKey ? manager.removeAll(accountKey) : noAccount()),
      removeWatched: () => (accountKey ? manager.removeWatched(accountKey) : noAccount()),
    }),
    [manager, accountKey]
  );
}

export type DownloadSettingsApi = DownloadSettings & {
  setWifiOnly(wifiOnly: boolean): Promise<void>;
  setMaxConcurrent(maxConcurrent: number): Promise<void>;
  setDeleteWatched(deleteWatched: boolean): void;
};

export function useDownloadSettings(): DownloadSettingsApi {
  const { manager } = useDownloadsContext();
  const all = useDownloadsSnapshot();
  return useMemo(
    () => ({
      ...(all && manager.settings()),
      setWifiOnly: (wifiOnly: boolean) => manager.setWifiOnly(wifiOnly),
      setMaxConcurrent: (value: number) => manager.setMaxConcurrent(value),
      setDeleteWatched: (value: boolean) => manager.setDeleteWatched(value),
    }),
    [manager, all]
  );
}

/** What Play/Resume starts for `workId` when a finished download exists (null = stream as usual). */
export function useLocalPlayTarget(workId: string | null | undefined): LocalPlayTarget | null {
  const { manager, engine } = useDownloadsContext();
  const all = useDownloadsSnapshot();
  const accountKey = useActiveDownloadAccountKey();
  return useMemo(
    () =>
      workId && accountKey && all.length
        ? resolveLocalPlayTarget(workId, accountKey, manager, engine)
        : null,
    [manager, engine, accountKey, workId, all]
  );
}

/** `file://` of a snapshot image (resolved now: iOS container paths change), else null. */
export function useArtworkUri(
  download: OfflineDownload | null | undefined,
  kind: keyof OfflineArtwork
): string | null {
  const { engine } = useDownloadsContext();
  const path = download?.artwork[kind];
  const volumeId = download?.volumeId;
  return useMemo(() => {
    if (!path || !engine.isSupported) return null;
    try {
      return engine.uriFor(path, volumeId);
    } catch {
      return null;
    }
  }, [engine, path, volumeId]);
}

export type AccountDownloadsSummary = { count: number; bytes: number };

/** A profile's downloads on this device (sign-out / remove prompts, offline profile picker). */
export function useAccountDownloads(
  account: Pick<Account, 'serverUrl' | 'viewerId'> | null | undefined
): AccountDownloadsSummary {
  const all = useDownloadsSnapshot();
  const key = account ? downloadAccountKey(account) : null;
  return useMemo(() => {
    const items = all.filter((item) => item.accountKey === key);
    return {
      count: items.length,
      bytes: items.reduce((sum, item) => sum + bytesOnDevice(item), 0),
    };
  }, [all, key]);
}
