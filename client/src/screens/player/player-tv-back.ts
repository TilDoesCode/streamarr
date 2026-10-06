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

/** A second Back within this time after one that only dismissed a recovery hint leaves the player. */
export const BACK_CONFIRM_MS = 4_000;

/** While a recovery shows its spinner and hint, the first Back only dismisses the hint; the next one leaves (S6u). */
export function recoveryBack(
  recovering: boolean,
  dismissedAt: number,
  now: number
): 'dismiss' | 'leave' {
  return recovering && now - dismissedAt > BACK_CONFIRM_MS ? 'dismiss' : 'leave';
}
