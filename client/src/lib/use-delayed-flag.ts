import { useEffect, useState } from 'react';

/** `on`, but only once it has stayed on for `ms` (a short-lived state shows no flicker). */
export function useDelayedFlag(on: boolean, ms: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setShown(true), ms);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [on, ms]);
  return on && shown;
}
