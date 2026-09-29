import { ACCOUNTS_STORAGE_ID, type AccountStore, type KeyValueStorage } from './account-store';
import { WEB_VAULT_STORAGE_ID } from './types';

// MMKV's web backend stores key `k` of instance `id` as the localStorage key `id\k`.
const LIST_PREFIX = `${ACCOUNTS_STORAGE_ID}\\`;
const VAULT_PREFIX = `${WEB_VAULT_STORAGE_ID}\\`;

type StorageEventLike = { key: string | null };

export type StorageEventTarget = {
  addEventListener(type: 'storage', listener: (event: StorageEventLike) => void): void;
  removeEventListener(type: 'storage', listener: (event: StorageEventLike) => void): void;
};

/** Web: follows other tabs' localStorage writes (profile list, tokens); returns the unsubscribe. */
export function followOtherTabs(store: AccountStore, target: StorageEventTarget): () => void {
  const onStorage = ({ key }: StorageEventLike) => {
    // A null key means another tab cleared localStorage.
    if (key === null || key.startsWith(VAULT_PREFIX))
      store.forgetCachedTokens(key === null ? undefined : key.slice(VAULT_PREFIX.length));
    if (key === null || key.startsWith(LIST_PREFIX)) store.reload();
  };
  target.addEventListener('storage', onStorage);
  return () => target.removeEventListener('storage', onStorage);
}

/** Web: sessionStorage (one tab, kept across its reloads) as a KeyValueStorage. */
export function tabSessionStorage(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  prefix = 'streamarr.tab.'
): KeyValueStorage {
  return {
    getString: (key) => storage.getItem(prefix + key) ?? undefined,
    set: (key, value) => storage.setItem(prefix + key, value),
    remove: (key) => storage.removeItem(prefix + key),
  };
}
