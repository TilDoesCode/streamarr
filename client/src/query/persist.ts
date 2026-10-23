import { experimental_createQueryPersister } from '@tanstack/query-persist-client-core';
import { hashKey, type QueryKey } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { createMMKV, deleteMMKV, type MMKV } from 'react-native-mmkv';

import { deleteRecentSearches } from '@/lib/recent-searches';

type QueryPersister = ReturnType<typeof experimental_createQueryPersister>;

const DAY = 24 * 60 * 60_000;
const MAX_AGE = 7 * DAY;
// Bump when the shape of persisted data changes; old entries are then discarded.
const CACHE_VERSION = 1;
const BUSTER = `${Constants.expoConfig?.version ?? '0'}-${CACHE_VERSION}`;
const PREFIX = 'q';

const caches = new Map<string, { storage: MMKV; persister: QueryPersister }>();

const storageId = (accountId: string) => `streamarr.cache.${accountId}`;

function accountCache(accountId: string) {
  let cache = caches.get(accountId);
  if (!cache) {
    const storage = createMMKV({ id: storageId(accountId) });
    const persister = experimental_createQueryPersister<string>({
      storage: {
        getItem: (key) => storage.getString(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => void storage.remove(key),
      },
      maxAge: MAX_AGE,
      buster: BUSTER,
      prefix: PREFIX,
    });
    cache = { storage, persister };
    caches.set(accountId, cache);
  }
  return cache;
}

/** Per-account MMKV persister for queries that should survive a restart (Home). */
export function accountPersister(accountId: string): QueryPersister {
  return accountCache(accountId).persister;
}

/** The persisted data of a query, read synchronously (MMKV), so a cold start can render it in its first frame. */
export function readPersisted<T>(
  accountId: string,
  queryKey: QueryKey
): { data: T; updatedAt: number } | undefined {
  try {
    const raw = accountCache(accountId).storage.getString(`${PREFIX}-${hashKey(queryKey)}`);
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as {
      buster?: string;
      state?: { data?: T; dataUpdatedAt?: number };
    };
    const updatedAt = entry.state?.dataUpdatedAt;
    if (entry.buster !== BUSTER || !updatedAt || Date.now() - updatedAt > MAX_AGE) return undefined;
    if (entry.state?.data === undefined) return undefined;
    return { data: entry.state.data, updatedAt };
  } catch {
    return undefined;
  }
}

/** Drops everything persisted for an account (on remove). */
export function deleteAccountCache(accountId: string): void {
  deleteRecentSearches(accountId);
  caches.delete(accountId);
  deleteMMKV(storageId(accountId));
}
