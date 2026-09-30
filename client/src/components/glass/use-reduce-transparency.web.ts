import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-transparency: reduce)';

export function useReduceTransparency(): boolean {
  const [enabled, setEnabled] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(QUERY).matches
  );
  useEffect(() => {
    const media = typeof window !== 'undefined' ? window.matchMedia?.(QUERY) : undefined;
    if (!media) return;
    const onChange = (event: MediaQueryListEvent) => setEnabled(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return enabled;
}
