import { usePathname, useRootNavigationState, useRouter } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';

import { platformSupportsDownloads } from '@/downloads/engine';

import { isStreamPlaybackActive, subscribeStreamPlayback } from './stream-playback';
import { useConnectivity } from './provider';

export const OFFLINE_PATH = '/offline';

/** Pages that keep running offline: the shell and a player that is starting or plays a downloaded file. */
export const keepsOffline = (pathname: string, streaming: boolean) =>
  pathname === OFFLINE_PATH || (!streaming && pathname.startsWith('/play/'));

/** Offline the signed-in app switches to the offline shell and back to Home once the server answers (not web/tvOS). */
export function useOfflineRedirect(enabled = platformSupportsDownloads()): void {
  const { offline, state } = useConnectivity();
  const pathname = usePathname();
  const router = useRouter();
  // Navigating before the root navigator mounted throws (a cold start that is offline at once).
  const ready = !!useRootNavigationState()?.key;
  const streaming = useSyncExternalStore(
    subscribeStreamPlayback,
    isStreamPlaybackActive,
    isStreamPlaybackActive
  );
  useEffect(() => {
    if (!enabled || !ready) return;
    if (offline && !keepsOffline(pathname, streaming)) router.replace(OFFLINE_PATH);
    else if (!offline && state === 'online' && pathname === OFFLINE_PATH) router.replace('/');
  }, [enabled, ready, offline, state, pathname, router, streaming]);
}
