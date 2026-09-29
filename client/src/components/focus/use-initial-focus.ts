import { useEffect, useEffectEvent, type RefObject } from 'react';
import { Platform, type View } from 'react-native';

// Web: an entering overlay stays `visibility: hidden` for a frame or two, which rejects focus().
const WEB_ATTEMPTS = 10;

// Web: centre `element` in its nearest vertical scroller (only vertically, the overlay may still be sliding in).
function centreInScroller(element: HTMLElement) {
  let scroller = element.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
    scroller = scroller.parentElement;
  }
  if (!scroller) return;
  const item = element.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  scroller.scrollTop += item.top + item.height / 2 - (view.top + view.height / 2);
}

/** Moves remote/keyboard focus to `ref` after mount when `enabled` (overlays' initial focus on TV and web). */
export function useInitialFocus(ref: RefObject<View | null>, enabled: boolean): void {
  // Returns true once focus has landed (TV: fire-and-forget).
  const focus = useEffectEvent((): boolean => {
    if (Platform.OS !== 'web') {
      // hasTVPreferredFocus fires before layout and misses items below a scroll view's viewport.
      ref.current?.requestTVFocus?.();
      return true;
    }
    const element = ref.current as unknown as HTMLElement | null;
    if (!element) return true;
    element.focus({ preventScroll: true });
    if (document.activeElement !== element) return false;
    centreInScroller(element);
    return true;
  });
  useEffect(() => {
    if (!enabled || (Platform.OS !== 'web' && !Platform.isTV)) return;
    let attempts = 0;
    // From the next frame: react-native-web's modal focus trap must first record the trigger to restore.
    const attempt = () => {
      if (!focus() && ++attempts < WEB_ATTEMPTS) frame = requestAnimationFrame(attempt);
    };
    let frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [enabled]);
}
