import { startTransition, useEffect, useState } from 'react';

/** Calls `then` once the next frame has been painted (two animation frames); returns a cancel. */
export function afterPaint(then: () => void): () => void {
  let second: number | undefined;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(then);
  });
  return () => {
    cancelAnimationFrame(first);
    if (second !== undefined) cancelAnimationFrame(second);
  };
}

/**
 * Progressive mount: 0 on the first render, then one stage more after each painted frame up to `last`.
 * A screen shows its light first frame at once and mounts heavy sections at later stages (as a transition,
 * so remote keys still get through in between).
 */
export function useMountStage(last: number): number {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (stage >= last) return;
    return afterPaint(() => startTransition(() => setStage((now) => Math.min(last, now + 1))));
  }, [stage, last]);
  return Math.min(stage, last);
}
