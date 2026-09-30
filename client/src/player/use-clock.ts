import { useEffect, useState } from 'react';

import type { PlayerEngine } from '@/player/engines';

export type Clock = { position: number; duration: number; buffered: number };

/** Position, duration and buffered end of the engine, updated from its time events. */
export function useClock(engine: PlayerEngine | null | undefined): Clock {
  const [clock, setClock] = useState<Clock>({ position: 0, duration: 0, buffered: 0 });
  useEffect(() => {
    if (!engine) return;
    const read = () => {
      const snapshot = engine.getSnapshot();
      setClock({
        position: snapshot.position,
        duration: snapshot.duration,
        buffered: snapshot.buffered,
      });
    };
    read();
    return engine.subscribe((event) => {
      if (event.type === 'time' || event.type === 'state') read();
    });
  }, [engine]);
  return clock;
}
