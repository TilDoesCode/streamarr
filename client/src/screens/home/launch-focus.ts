import { useEffect } from 'react';
import { Platform, type View } from 'react-native';

/** The hero's main button may replace "More info" as the target shortly after landing (its details load late). */
const RETARGET_MS = 3000;

let landedAt: number | null = null;

/** Apple TV: the native tab bar holds focus at launch; the first Home of an app run moves it to the hero. */
export function useLaunchFocus(target: View | null, enabled: boolean, now = Date.now): void {
  useEffect(() => {
    if (!target || !enabled || Platform.OS !== 'ios' || !Platform.isTV) return;
    if (landedAt !== null && now() - landedAt > RETARGET_MS) return;
    const frame = requestAnimationFrame(() => {
      landedAt ??= now();
      target.requestTVFocus?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [target, enabled, now]);
}

/** Tests: a new app run. */
export function resetLaunchFocus(): void {
  landedAt = null;
}
