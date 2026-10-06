import { useSyncExternalStore } from 'react';

/** Accounts with an open player: a session that ends under it keeps the screen, so the player's card says why (A03–A07). */
const held = new Map<string, number>();
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The player holds its account's screen until it closes; returns the release. */
export function holdForPlayer(accountId: string): () => void {
  held.set(accountId, (held.get(accountId) ?? 0) + 1);
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (held.get(accountId) ?? 1) - 1;
    if (count > 0) held.set(accountId, count);
    else held.delete(accountId);
    notify();
  };
}

export const playerHolds = (accountId: string): boolean => held.has(accountId);

export function usePlayerHold(accountId: string | undefined): boolean {
  const read = () => !!accountId && held.has(accountId);
  return useSyncExternalStore(subscribe, read, read);
}
