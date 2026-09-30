import { useCallback, useSyncExternalStore } from 'react';
import { createMMKV, deleteMMKV, type MMKV } from 'react-native-mmkv';

export const MAX_RECENT = 8;
const KEY = 'recent';
const stores = new Map<string, MMKV>();
const listeners = new Set<() => void>();
const snapshots = new Map<string, readonly string[]>();

const storageId = (accountId: string) => `streamarr.recent.${accountId}`;

function store(accountId: string): MMKV {
  let mmkv = stores.get(accountId);
  if (!mmkv) {
    mmkv = createMMKV({ id: storageId(accountId) });
    stores.set(accountId, mmkv);
  }
  return mmkv;
}

function parse(raw: string | undefined): string[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function readRecentSearches(accountId: string): readonly string[] {
  let snapshot = snapshots.get(accountId);
  if (!snapshot) {
    snapshot = parse(store(accountId).getString(KEY));
    snapshots.set(accountId, snapshot);
  }
  return snapshot;
}

function write(accountId: string, items: readonly string[]): void {
  store(accountId).set(KEY, JSON.stringify(items));
  snapshots.set(accountId, items);
  for (const listener of listeners) listener();
}

/** Most recent first, case-insensitive duplicates removed, at most MAX_RECENT. */
export function addRecentSearch(accountId: string, query: string): void {
  const text = query.trim();
  if (text.length < 2) return;
  const rest = readRecentSearches(accountId).filter(
    (item) => item.toLocaleLowerCase() !== text.toLocaleLowerCase()
  );
  write(accountId, [text, ...rest].slice(0, MAX_RECENT));
}

export function removeRecentSearch(accountId: string, query: string): void {
  write(
    accountId,
    readRecentSearches(accountId).filter((item) => item !== query)
  );
}

export function clearRecentSearches(accountId: string): void {
  write(accountId, []);
}

/** Forgets an account's searches (profile removed from this device). */
export function deleteRecentSearches(accountId: string): void {
  stores.delete(accountId);
  snapshots.delete(accountId);
  deleteMMKV(storageId(accountId));
  for (const listener of listeners) listener();
}

export function useRecentSearches(accountId: string): readonly string[] {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  return useSyncExternalStore(subscribe, () => readRecentSearches(accountId));
}
