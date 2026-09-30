import { useFonts } from 'expo-font';
import { useEffect, useState } from 'react';

import { FONT_ASSETS } from './font-assets';

/** Brand fonts gate the first render for at most FONT_GATE_MS; the browser swaps them in when they arrive. */
export const FONT_GATE_MS = 3000;

export function useAppFonts(): boolean {
  const [loaded, error] = useFonts(FONT_ASSETS);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), FONT_GATE_MS);
    return () => clearTimeout(timer);
  }, []);
  return loaded || error != null || expired;
}
