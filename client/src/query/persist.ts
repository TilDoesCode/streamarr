import { experimental_createQueryPersister } from '@tanstack/query-persist-client-core';
import Constants from 'expo-constants';
import { createMMKV, deleteMMKV } from 'react-native-mmkv';

type QueryPersister = ReturnType<typeof experimental_createQueryPersister>;

const DAY = 24 * 60 * 60_000;
// Bump when the shape of persisted data changes; old entries are then discarded.
const CACHE_VERSION = 1;

const persisters = new Map<string, QueryPersister>();

const storageId = (accountId: string) => `streamarr.cache.${accountId}`;

/** Per-account MMKV persister for queries that should survive a restart (home rows). */
export function accountPersister(accountId: string): QueryPersister {
  let persister = persisters.get(accountId);
  if (!persister) {
    const storage = createMMKV({ id: storageId(accountId) });
    persister = experimental_createQueryPersister<string>({
      storage: {
        getItem: (key) => storage.getString(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => void storage.remove(key),
      },
      maxAge: 7 * DAY,
      buster: `${Constants.expoConfig?.version ?? '0'}-${CACHE_VERSION}`,
      prefix: 'q',
    });
    persisters.set(accountId, persister);
  }
  return persister;
}

/** Drops everything persisted for an account (on remove). */
export function deleteAccountCache(accountId: string): void {
  persisters.delete(accountId);
  deleteMMKV(storageId(accountId));
}
