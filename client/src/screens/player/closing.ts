import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Leaving the player: its loaders stop first (a render with motion off), the navigation runs one frame later.
 * A JS pop unmounts the screen in the same commit, so a blur would come too late for the UI thread (F12-1).
 */
export function useCloseAfterFrame(
  nextFrame: (run: () => void) => unknown = requestAnimationFrame
) {
  const [closing, setClosing] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    []
  );
  const closeAfterFrame = useCallback(
    (leave: () => void) => {
      if (pending.current) return;
      pending.current = true;
      setClosing(true);
      nextFrame(() => {
        if (mounted.current) leave();
      });
    },
    [nextFrame]
  );
  return { closing, closeAfterFrame };
}
