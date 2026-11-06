import { usePathname, useRootNavigationState, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { platformSupportsDownloads } from '@/downloads/engine';

import { useConnectivity } from './provider';

export const OFFLINE_PATH = '/offline';

/** Pages that keep running while offline: the shell itself and a playback (a local file plays on undisturbed). */
export const keepsOffline = (pathname: string) =>
  pathname === OFFLINE_PATH || pathname.startsWith('/play/');

/**
 * Offline (where downloads exist) the signed-in app switches to the offline shell; once the server answers again the
 * shell gives way to Home. Web and Apple TV keep today's behaviour.
 */
export function useOfflineRedirect(enabled = platformSupportsDownloads()): void {
  const { offline, state } = useConnectivity();
  const pathname = usePathname();
  const router = useRouter();
  // Navigating before the root navigator mounted throws (a cold start that is offline at once).
  const ready = !!useRootNavigationState()?.key;
  useEffect(() => {
    if (!enabled || !ready) return;
    if (offline && !keepsOffline(pathname)) router.replace(OFFLINE_PATH);
    else if (!offline && state === 'online' && pathname === OFFLINE_PATH) router.replace('/');
  }, [enabled, ready, offline, state, pathname, router]);
}
