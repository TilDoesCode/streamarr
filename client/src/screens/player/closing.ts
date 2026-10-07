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
  /** `ready`: what must finish before the navigation (the phone turned back to portrait, Q2-07). */
  const closeAfterFrame = useCallback(
    (leave: () => void, ready?: () => Promise<unknown> | undefined) => {
      if (pending.current) return;
      pending.current = true;
      setClosing(true);
      const before = ready?.();
      nextFrame(() => {
        void Promise.resolve(before).then(() => {
          if (mounted.current) leave();
        });
      });
    },
    [nextFrame]
  );
  return { closing, closeAfterFrame };
}
