import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { useAccountsApi } from '@/accounts/accounts-provider';
import { flushAllProgress, pendingProgress } from '@/player/progress-queue';

import { useConnectivity } from './provider';

/** Queued watch progress waits at most this long while the app runs. */
export const PROGRESS_SYNC_MS = 60_000;

/** Sends queued watch progress (real `occurredAt`) at launch, reconnect, sign-in, foreground and every minute. */
export function ProgressSync() {
  const api = useAccountsApi();
  const { offline } = useConnectivity();
  const running = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const sync = () => {
      if (offline || !pendingProgress()) return;
      running.current ??= flushAllProgress(api.store.getSnapshot().accounts, api.clientFor).finally(
        () => (running.current = null)
      );
    };
    sync();
    let signedIn = api.store.getSnapshot().accounts.filter((account) => account.signedIn).length;
    const accounts = api.store.subscribe(() => {
      const next = api.store.getSnapshot().accounts.filter((account) => account.signedIn).length;
      if (next > signedIn) sync();
      signedIn = next;
    });
    const timer = setInterval(sync, PROGRESS_SYNC_MS);
    const appState = AppState.addEventListener('change', (status) => {
      if (status === 'active') sync();
    });
    return () => {
      accounts();
      clearInterval(timer);
      appState.remove();
    };
  }, [api, offline]);

  return null;
}
