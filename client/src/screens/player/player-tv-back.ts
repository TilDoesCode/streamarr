import { useEffect } from 'react';

import { useBackHandler, useMenuClaim } from '@/components/focus';
import { expireReturnFocus, requestReturnFocus } from '@/navigation/screen-focus';

type PlayerRouter = { canGoBack(): boolean; back(): void; replace(href: '/'): void };

/** Leaves the player; on Apple TV the screen underneath takes its focus back (JS pops skip UIKit's restore). */
export function leavePlayer(router: PlayerRouter): void {
  requestReturnFocus();
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/** The player's Back/Menu chain; on Apple TV Menu goes straight to it, so no native pop (and its focus restore) starts. */
export function usePlayerBack(onBack: () => boolean): void {
  useBackHandler(onBack);
  useMenuClaim('always');
  useEffect(() => () => expireReturnFocus(), []);
}
