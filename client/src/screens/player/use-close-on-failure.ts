import { useEffect, useEffectEvent } from 'react';

/** Panels and the version picker close when the playback fails, so the card (and TV focus) is on top (E10). */
export function useCloseOnFailure(failed: boolean, close: () => void): void {
  const onFailed = useEffectEvent(close);
  useEffect(() => {
    if (failed) onFailed();
  }, [failed]);
}
