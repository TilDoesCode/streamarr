import type { Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { useBackHandler, useMenuClaim } from '@/components/focus';
import { useWebBackKeys } from '@/navigation/back-control';
import { isFullscreen, toggleFullscreen } from '@/player/fullscreen';
import type { RouteLeaf } from '@/navigation/routes';
import { expireReturnFocus, requestReturnFocus } from '@/navigation/screen-focus';

type PlayerRouter = { canGoBack(): boolean; back(): void; replace(href: Href): void };

/** Leaves the player; on Apple TV the screen underneath takes its focus back (JS pops skip UIKit's restore). */
export function leavePlayer(
  router: PlayerRouter,
  { detail, opener }: { detail?: Href; opener?: RouteLeaf } = { opener: { name: '' } }
): void {
  requestReturnFocus();
  // Opened by a deep link, nothing below to go back to: the title's detail (S9b2 end card).
  if (opener && router.canGoBack()) router.back();
  else if (detail) router.replace(detail);
  else if (router.canGoBack()) router.back();
  else router.replace('/');
}

/** The player's Back/Menu chain; on Apple TV Menu goes straight to it, so no native pop (and its focus restore) starts. */
export function usePlayerBack(onBack: () => boolean): void {
  useBackHandler(onBack);
  // Web: Escape leaves the browser's full screen first, then acts like Back (an open sheet closes itself, Q2-05).
  useWebBackKeys(true, () => (isFullscreen() ? toggleFullscreen() : void onBack()));
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

/** Back during a running recovery hides its hint once; the hint going away or a new cause ends that (S4p B1). */
export function useHintDismiss(hintKey: string | null) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const at = useRef(0);
  // The picture ran again (no hint) or another cause took its place: the next hint shows.
  if (dismissed !== null && hintKey !== dismissed) setDismissed(null);
  const hidden = dismissed !== null && hintKey === dismissed;
  return {
    hidden,
    /** 'dismiss' hides the running hint; 'leave' when nothing runs, it is already hidden, or Back came twice in 4 s. */
    back(recovering: boolean, now = Date.now()): 'dismiss' | 'leave' {
      if (hidden || !hintKey || recoveryBack(recovering, at.current, now) === 'leave')
        return 'leave';
      at.current = now;
      setDismissed(hintKey);
      return 'dismiss';
    },
  };
}
