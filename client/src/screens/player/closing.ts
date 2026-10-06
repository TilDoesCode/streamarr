import { useCallback, useEffect, useRef, useState } from 'react';

/** Leaving the player: loaders stop in one render with motion off, the navigation (which unmounts at once) a frame later. */
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
