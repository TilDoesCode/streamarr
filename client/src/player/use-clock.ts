import { useEffect, useState } from 'react';

import type { PlayerEngine } from '@/player/engines';

export type Clock = { position: number; duration: number; buffered: number };

/** Smallest clock movement that re-renders the player; engines report time every 100 ms. */
const CLOCK_STEP_SECONDS = 0.25;

/** Whether `next` differs enough from `shown` to re-render (seeks, a new duration, a visible step). */
export function clockMoved(shown: Clock, next: Clock): boolean {
  return (
    next.duration !== shown.duration ||
    Math.abs(next.position - shown.position) >= CLOCK_STEP_SECONDS ||
    Math.abs(next.buffered - shown.buffered) >= 1
  );
}

/** Position, duration and buffered end of the engine, updated from its time events. */
export function useClock(engine: PlayerEngine | null | undefined): Clock {
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
      setClock((shown) => (always || clockMoved(shown, next) ? next : shown));
    };
    read(true);
    return engine.subscribe((event) => {
      if (event.type === 'time' || event.type === 'state') read(event.type === 'state');
    });
  }, [engine]);
  return clock;
}
