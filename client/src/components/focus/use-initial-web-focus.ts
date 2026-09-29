import { useEffect, useEffectEvent, type RefObject } from 'react';
import { Platform, type View } from 'react-native';

/** Web: moves keyboard focus to `ref` after mount when `enabled` (TV uses hasTVPreferredFocus). */
export function useInitialWebFocus(ref: RefObject<View | null>, enabled: boolean): void {
  const focus = useEffectEvent(() => {
    (ref.current as unknown as HTMLElement | null)?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web') return;
    // Next frame: react-native-web's modal focus trap must first record the trigger to restore on close.
    const frame = requestAnimationFrame(() => focus());
    return () => cancelAnimationFrame(frame);
  }, [enabled]);
}
