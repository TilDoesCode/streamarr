import { QueryClientContext } from '@tanstack/react-query';
import { use, useCallback, useMemo, useSyncExternalStore } from 'react';

import { useOptionalActiveAccount } from '@/accounts/accounts-provider';
import {
  downloadAccountKey,
  downloadProgress,
  isActiveDownload,
  isRemovingDownload,
  normalizeSeasonId,
  resolveLocalPlayTarget,
  useOptionalDownloadsContext,
  type LocalPlayTarget,
  type OfflineDownload,
} from '@/downloads';
import { REMOVING_LABEL_DELAY_MS } from '@/components/downloads/removing-row';
import { platformSupportsDownloads } from '@/downloads/engine';
import { lockOf } from '@/downloads/library';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { queryKeys } from '@/query/keys';

const NO_DOWNLOADS: OfflineDownload[] = [];
const noSubscription = () => () => undefined;

/** The download core where downloads exist (iPhone, iPad, Android, Android TV with the engine); null elsewhere. */
export function useDownloadsUi() {
  const context = useOptionalDownloadsContext();
  return context && platformSupportsDownloads() && context.engine.isSupported ? context : null;
}

type Store = NonNullable<ReturnType<typeof useDownloadsUi>>['manager']['store'];
type Snapshot = string | number | boolean | null;

/** The download core and the active profile's owner key (both null where downloads do not exist, previews, tests). */
function useProfileStore() {
  const context = useDownloadsUi();
  const account = useOptionalActiveAccount();
  return {
    context,
    store: context?.manager.store ?? null,
    accountKey: account ? downloadAccountKey(account) : null,
  };
}

/** A primitive derived from the profile's downloads: re-renders only when it changes, not on every progress tick. */
function useProfileSelect<T extends Snapshot>(
  select: (mine: readonly OfflineDownload[], store: Store, accountKey: string) => T,
  fallback: T
): T {
  const { store, accountKey } = useProfileStore();
  const snapshot = () =>
    store && accountKey
      ? select(
          store.all().filter((item) => item.accountKey === accountKey),
          store,
          accountKey
        )
      : fallback;
  return useSyncExternalStore(store?.subscribe ?? noSubscription, snapshot, snapshot);
}

const versions = new WeakMap<object, number>();
let nextVersion = 0;
/** A number per record object: the store replaces a record on every change. */
function versionOf(record: object): number {
  let version = versions.get(record);
  if (version === undefined) versions.set(record, (version = nextVersion += 1));
  return version;
}

type Profile = { permissions?: { allowDownloads?: boolean } | null };

/** The admin turned downloads off for this profile (the profile sync's cached answer; unknown = allowed, the default). */
export function useDownloadsBlocked(): boolean {
  const client = use(QueryClientContext);
  const account = useOptionalActiveAccount();
  const cache = client?.getQueryCache();
  const accountId = account?.id;
  // Only the profile's own updates: other queries register while components render (no store change then).
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!cache || !accountId) return () => undefined;
      const key = JSON.stringify(queryKeys.me(accountId));
      return cache.subscribe((event) => {
        if (event.type === 'updated' && JSON.stringify(event.query.queryKey) === key) listener();
      });
    },
    [cache, accountId]
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
  /** The age gate now blocks this finished download for the profile (it stays on the device, unplayable). */
  locked: boolean;
  /** Being cancelled or removed: no actions, no new download of the work until it is gone. */
  removing: boolean;
  /** `removing` for long enough to say so ("Removing…"); before that the entry is only greyed. */
  removingLabelled: boolean;
};

/** The finished, playable file of a movie or episode (Play starts it, also online); null otherwise. */
export function useLocalDownload(workId: string | null | undefined): LocalPlayTarget | null {
  const { context, accountKey } = useProfileStore();
  // The record, its lock and the saved position: what the play target is made of.
  const key = useProfileSelect((mine, store, owner) => {
    const done = workId && mine.find((item) => item.workId === workId && item.state === 'done');
    if (!done) return null;
    const position = store.position(owner, done.workId);
    return [
      versionOf(done),
      lockOf(done, store.policy(owner)),
      position?.seconds,
      position?.at,
    ].join('|');
  }, null);
  return useMemo(
    () =>
      key && context && accountKey && workId
        ? resolveLocalPlayTarget(workId, accountKey, context.manager, context.engine)
        : null,
    [key, context, accountKey, workId]
  );
}

/** The profile's download of a movie or episode; `live` follows each progress tick (cards, marks), else once a second. */
export function useWorkDownloadUi(
  workId: string | null | undefined,
  { live = false }: { live?: boolean } = {}
): WorkDownloadUi {
  const { context, store } = useProfileStore();
  const blocked = useDownloadsBlocked();
  const id = useProfileSelect(
    (mine) => (workId && mine.find((item) => item.workId === workId)?.id) || null,
    null
  );
  // Re-renders only when this record changes; `live` adds its own progress and speed ticks.
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!store || !id) return () => undefined;
      const list = store.subscribe(listener);
      const record = live ? store.subscribeTo(id, listener) : undefined;
      return () => {
        list();
        record?.();
      };
    },
    [store, id, live]
  );
  const read = () => (id && store?.get(id)) || null;
  const download = useSyncExternalStore(subscribe, read, read);
  const speed = () => (id && store?.liveOf(id)?.bytesPerSecond) || 0;
  const bytesPerSecond = useSyncExternalStore(subscribe, speed, speed);
  const locked = useProfileSelect(
    (_, owner, key) => !!download && !!lockOf(download, owner.policy(key)),
    false
  );
  const local = useLocalDownload(workId);
  const removing = !!download && isRemovingDownload(download);
  const removingLabelled = useDelayedFlag(removing, REMOVING_LABEL_DELAY_MS);
  return useMemo(
    () => ({
      available: !!context,
      allowed: !blocked,
      locked,
      download,
      progress: download ? downloadProgress(download) : null,
      bytesPerSecond,
      local,
      removing,
      removingLabelled,
    }),
    [context, blocked, locked, download, bytesPerSecond, local, removing, removingLabelled]
  );
}

export type SeasonDownloadsUi = { downloaded: number; inProgress: number; failed: number };

/** "5/10" of a season chip: finished episodes (the total comes from the catalog). */
export function useSeasonDownloadsUi(seasonId: string | null | undefined): SeasonDownloadsUi {
  const counts = useProfileSelect((mine) => {
    const season = seasonId ? normalizeSeasonId(seasonId) : null;
    const items = season ? mine.filter((item) => item.seasonId === season) : NO_DOWNLOADS;
    return [
      items.filter((item) => item.state === 'done').length,
      items.filter(isActiveDownload).length,
      items.filter((item) => item.state === 'failed').length,
    ].join('/');
  }, '0/0/0');
  return useMemo(() => {
    const [downloaded = 0, inProgress = 0, failed = 0] = counts.split('/').map(Number);
    return { downloaded, inProgress, failed };
  }, [counts]);
}

/** Finished downloads per season id of a series (season chips). */
export function useSeriesDownloadCounts(
  seriesId: string | null | undefined
): ReadonlyMap<string, number> {
  const encoded = useProfileSelect((mine) => {
    const counts = new Map<string, number>();
    for (const item of mine)
      if (item.seriesId === seriesId && item.seasonId && item.state === 'done')
        counts.set(item.seasonId, (counts.get(item.seasonId) ?? 0) + 1);
    return JSON.stringify([...counts]);
  }, '[]');
  return useMemo(() => new Map(JSON.parse(encoded) as [string, number][]), [encoded]);
}

/** Navigation entry: whether Downloads exists here and how many downloads are still running (badge). */
export function useDownloadsTab(): { visible: boolean; count: number } {
  const { context } = useProfileStore();
  const count = useProfileSelect((mine) => mine.filter((item) => isActiveDownload(item)).length, 0);
  return useMemo(() => ({ visible: !!context, count }), [context, count]);
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
