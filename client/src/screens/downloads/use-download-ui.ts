import { QueryClientContext } from '@tanstack/react-query';
import { use, useCallback, useMemo, useSyncExternalStore } from 'react';

import { useOptionalActiveAccount } from '@/accounts/accounts-provider';
import {
  downloadAccountKey,
  downloadProgress,
  isActiveDownload,
  normalizeSeasonId,
  resolveLocalPlayTarget,
  useOptionalDownloadsContext,
  type LocalPlayTarget,
  type OfflineDownload,
} from '@/downloads';
import { platformSupportsDownloads } from '@/downloads/engine';
import { queryKeys } from '@/query/keys';

const NO_DOWNLOADS: OfflineDownload[] = [];
const noSubscription = () => () => undefined;
const noDownloads = () => NO_DOWNLOADS;

/** The download core where downloads exist (iPhone, iPad, Android, Android TV with the engine); null elsewhere. */
export function useDownloadsUi() {
  const context = useOptionalDownloadsContext();
  return context && platformSupportsDownloads() && context.engine.isSupported ? context : null;
}

/** The active profile's downloads; empty where downloads do not exist or outside the providers (previews, tests). */
function useProfileDownloads() {
  const context = useDownloadsUi();
  const store = context?.manager.store;
  const all = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.all ?? noDownloads,
    store?.all ?? noDownloads
  );
  const account = useOptionalActiveAccount();
  const accountKey = account ? downloadAccountKey(account) : null;
  const mine = useMemo(
    () => (accountKey ? all.filter((item) => item.accountKey === accountKey) : NO_DOWNLOADS),
    [all, accountKey]
  );
  return { context, mine, accountKey };
}

type Profile = { permissions?: { allowDownloads?: boolean } | null };

/** The admin turned downloads off for this profile (the profile sync's cached answer; unknown = allowed, the default). */
export function useDownloadsBlocked(): boolean {
  const client = use(QueryClientContext);
  const account = useOptionalActiveAccount();
  const cache = client?.getQueryCache();
  const subscribe = useCallback(
    (listener: () => void) => cache?.subscribe(listener) ?? (() => undefined),
    [cache]
  );
  const blocked = () =>
    !!client &&
    !!account &&
    client.getQueryData<Profile>(queryKeys.me(account.id))?.permissions?.allowDownloads === false;
  return useSyncExternalStore(subscribe, blocked, blocked);
}

export type WorkDownloadUi = {
  /** Downloads exist on this device (the entry points show). */
  available: boolean;
  /** The admin allows this profile to download (entries show a lock otherwise and explain it in the sheet). */
  allowed: boolean;
  download: OfflineDownload | null;
  /** 0–1 while transferring, 1 once done; null before the size is known. */
  progress: number | null;
  bytesPerSecond: number;
  /** A finished file: Play/Resume starts it, also online. */
  local: LocalPlayTarget | null;
};

/** The profile's download of a movie or episode, for detail pages, rows and the version sheet. */
export function useWorkDownloadUi(workId: string | null | undefined): WorkDownloadUi {
  const { context, mine, accountKey } = useProfileDownloads();
  const blocked = useDownloadsBlocked();
  return useMemo(() => {
    const download = (workId && mine.find((item) => item.workId === workId)) || null;
    const local =
      context && accountKey && workId && download?.state === 'done'
        ? resolveLocalPlayTarget(workId, accountKey, context.manager, context.engine)
        : null;
    return {
      available: !!context,
      allowed: !blocked,
      download,
      progress: download ? downloadProgress(download) : null,
      bytesPerSecond: download
        ? (context?.manager.store.liveOf(download.id)?.bytesPerSecond ?? 0)
        : 0,
      local,
    };
  }, [context, mine, accountKey, workId, blocked]);
}

export type SeasonDownloadsUi = { downloaded: number; inProgress: number; failed: number };

/** "5/10" of a season chip: finished episodes (the total comes from the catalog). */
export function useSeasonDownloadsUi(seasonId: string | null | undefined): SeasonDownloadsUi {
  const { mine } = useProfileDownloads();
  return useMemo(() => {
    const season = seasonId ? normalizeSeasonId(seasonId) : null;
    const items = season ? mine.filter((item) => item.seasonId === season) : NO_DOWNLOADS;
    return {
      downloaded: items.filter((item) => item.state === 'done').length,
      inProgress: items.filter(isActiveDownload).length,
      failed: items.filter((item) => item.state === 'failed').length,
    };
  }, [mine, seasonId]);
}

/** Finished downloads per season id of a series (season chips). */
export function useSeriesDownloadCounts(
  seriesId: string | null | undefined
): ReadonlyMap<string, number> {
  const { mine } = useProfileDownloads();
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of mine)
      if (item.seriesId === seriesId && item.seasonId && item.state === 'done')
        counts.set(item.seasonId, (counts.get(item.seasonId) ?? 0) + 1);
    return counts;
  }, [mine, seriesId]);
}

/** Navigation entry: whether Downloads exists here and how many downloads are still running (badge). */
export function useDownloadsTab(): { visible: boolean; count: number } {
  const { context, mine } = useProfileDownloads();
  const count = useMemo(() => mine.filter((item) => isActiveDownload(item)).length, [mine]);
  return { visible: !!context, count };
}

/** At press time: whether Play would start a finished download of `workId` (cards resolve their version on press). */
export function useLocalCheck(): (workId: string) => boolean {
  const context = useDownloadsUi();
  const account = useOptionalActiveAccount();
  return (workId) =>
    !!context &&
    !!account &&
    !!resolveLocalPlayTarget(workId, downloadAccountKey(account), context.manager, context.engine);
}
