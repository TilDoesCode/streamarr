import { useEffect, useState } from 'react';

/** True once `visible` has been false for `ms`: the fade-out finished and the views may leave the screen. */
export function useFadedOut(visible: boolean, ms: number, enabled = true): boolean {
  const [faded, setFaded] = useState(false);
  const [shown, setShown] = useState(visible);
  // A new show/hide starts over (state adjusted while rendering, not in an effect).
  if (shown !== visible) {
    setShown(visible);
    setFaded(false);
  }
  useEffect(() => {
    if (visible || !enabled) return;
    const timer = setTimeout(() => setFaded(true), ms);
    return () => clearTimeout(timer);
  }, [visible, ms, enabled]);
  return enabled && !visible && faded;
}
