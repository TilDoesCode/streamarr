import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';

/** Re-checked this often, so a "3 min ago" label is never more than half a minute behind. */
export const RELATIVE_NOW_MS = 30_000;

/** The current time, refreshed while the screen is focused: relative labels ("3 min ago") keep counting. */
export function useRelativeNow(): number {
  const focused = useIsFocused();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!focused) return;
    const tick = () => setNow(Date.now());
    // Catches up at once when the screen comes back to the front.
    const catchUp = setTimeout(tick, 0);
    const timer = setInterval(tick, RELATIVE_NOW_MS);
    return () => {
      clearTimeout(catchUp);
      clearInterval(timer);
    };
  }, [focused]);
  return now;
}
