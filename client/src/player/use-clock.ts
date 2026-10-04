import { useEffect, useState } from 'react';

import type { PlayerEngine } from '@/player/engines';

export type Clock = { position: number; duration: number; buffered: number };

/** Smallest clock movement that re-renders the player: the labels show whole seconds. */
const CLOCK_STEP_SECONDS = 1;
/** The buffer bar needs no finer steps; each re-render redraws the whole player. */
const BUFFER_STEP_SECONDS = 5;

/** Hidden overlay: nothing shows the clock, only up-next near the end needs whole seconds. */
const HIDDEN_STEP_SECONDS = 10;
const END_ZONE_SECONDS = 60;

/** Whether `next` differs enough from `shown` to re-render (seeks, a new duration, a visible step). */
export function clockMoved(shown: Clock, next: Clock, hidden = false): boolean {
  const nearEnd = next.duration > 0 && next.duration - next.position <= END_ZONE_SECONDS;
  const step = hidden && !nearEnd ? HIDDEN_STEP_SECONDS : CLOCK_STEP_SECONDS;
  const moved = next.position - shown.position;
  return (
    next.duration !== shown.duration ||
    moved >= step ||
    -moved >= CLOCK_STEP_SECONDS ||
    (!hidden && Math.abs(next.buffered - shown.buffered) >= BUFFER_STEP_SECONDS)
  );
}

/** Position, duration and buffered end of the engine, updated from its time events; coarse while `hidden`. */
export function useClock(engine: PlayerEngine | null | undefined, hidden = false): Clock {
  const [clock, setClock] = useState<Clock>({ position: 0, duration: 0, buffered: 0 });
  useEffect(() => {
    if (!engine) return;
    const read = (always: boolean) => {
      const snapshot = engine.getSnapshot();
      const next = {
        position: snapshot.position,
        duration: snapshot.duration,
        buffered: snapshot.buffered,
      };
      setClock((shown) => (always || clockMoved(shown, next, hidden) ? next : shown));
    };
    read(true);
    return engine.subscribe((event) => {
      if (event.type === 'time' || event.type === 'state') read(event.type === 'state');
    });
  }, [engine, hidden]);
  return clock;
}

/** The player's clock: coarse while the overlay is hidden and no panel is open (Q1-25); `onVisibleChange` from the overlay. */
export function usePlayerClock(
  engine: PlayerEngine | null | undefined,
  panelOpen: boolean
): { clock: Clock; onVisibleChange: (visible: boolean) => void } {
  const [overlayShown, setOverlayShown] = useState(true);
  const clock = useClock(engine, !overlayShown && !panelOpen);
  return { clock, onVisibleChange: setOverlayShown };
}
