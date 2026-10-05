import type { ControllerOptions, NetworkSource, PlaybackController } from '@/player/controller';
import type { Playback } from '@/player/playback-api';

import { harness, newController, reply } from './harness';

export const TICKS = 10_000_000;

/** Connectivity under test control. */
export function fakeNetwork(): NetworkSource & { set(online: boolean): void } {
  const listeners = new Set<(online: boolean) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(online) {
      for (const listener of [...listeners]) listener(online);
    },
  };
}

/** Settles pending promises under fake timers. */
export const settle = () => jest.advanceTimersByTimeAsync(0);

/** A controller that started `playback` (or the server's default) and plays at `at` seconds. */
export async function playing(
  options: Partial<ControllerOptions> = {},
  over: Partial<Playback> = {},
  at = 0
): Promise<PlaybackController> {
  harness.server.answer('start', reply.ok(harness.server.playback(over)));
  const controller = newController(options);
  await controller.start();
  harness.engine.started();
  if (at) harness.engine.time(at);
  return controller;
}

/** Start requests the controller sent, with their start position in seconds. */
export function starts(): {
  releaseId?: unknown;
  position: number;
  body: Record<string, unknown>;
}[] {
  return harness.server.sent('start').map((request) => ({
    releaseId: request.body?.releaseId,
    position: Number(request.body?.startPositionTicks ?? 0) / TICKS,
    body: request.body ?? {},
  }));
}
