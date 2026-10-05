import { ExpoVideoEngine } from '@/player/engines/expo-video-engine';
import type { EngineEvent } from '@/player/engines/types';

import { harness } from './harness';
import { FakeExpoPlayer } from './library-fakes';

/**
 * The real native engines on their library fakes (S6/S7). Test files mock the libraries:
 * `jest.mock('expo-video', () => jest.requireActual('@/../jest/player/library-fakes').expoVideoModule())`.
 */
export type Recorded = {
  events: EngineEvent[];
  of<T extends EngineEvent['type']>(type: T): Extract<EngineEvent, { type: T }>[];
  /** Hands the recorded events to the controller's scripted engine (real engine → real controller). */
  replay(): void;
};

export function record(engine: {
  subscribe(listener: (event: EngineEvent) => void): () => void;
}): Recorded {
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  return {
    events,
    of: <T extends EngineEvent['type']>(type: T) =>
      events.filter((event): event is Extract<EngineEvent, { type: T }> => event.type === type),
    replay() {
      for (const event of events.splice(0)) harness.engine.emit(event);
    },
  };
}

/** ExpoVideoEngine on a FakeExpoPlayer: loaded, ready and playing; recording starts after that. */
export async function expoPlaying(kind: 'hls' | 'progressive' = 'hls') {
  const engine = new ExpoVideoEngine();
  engine.load({ uri: `http://server/media.${kind === 'hls' ? 'm3u8' : 'mkv'}`, kind });
  const player = FakeExpoPlayer.last;
  player.loaded();
  await Promise.resolve();
  player.ready();
  player.setPlaying(true);
  return { engine, player, ...record(engine) };
}
