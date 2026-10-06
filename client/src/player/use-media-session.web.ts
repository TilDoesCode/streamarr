import { useEffect } from 'react';

import type { PlaybackController } from '@/player/controller';

type Handler = (details: { seekTime?: number; seekOffset?: number }) => void;
type Session = { setActionHandler(action: string, handler: Handler | null): void };

const STEP_SECONDS = 10;

/** The browser's media controls and keys go through the player, never straight to the <video> element (V2 E07). */
export function useMediaSession(controller: PlaybackController | null): void {
  useEffect(() => {
    const session = (globalThis.navigator as { mediaSession?: Session } | undefined)?.mediaSession;
    if (!controller || !session) return;
    const handlers: Record<string, Handler> = {
      play: () => controller.setPaused(false),
      pause: () => controller.setPaused(true),
      seekto: ({ seekTime }) => seekTime !== undefined && controller.seekTo(seekTime),
      seekbackward: ({ seekOffset }) =>
        controller.seekTo(controller.position - (seekOffset ?? STEP_SECONDS)),
      seekforward: ({ seekOffset }) =>
        controller.seekTo(controller.position + (seekOffset ?? STEP_SECONDS)),
    };
    const set = (handler: (action: string) => Handler | null) => {
      for (const action of Object.keys(handlers)) {
        try {
          session.setActionHandler(action, handler(action));
        } catch {
          // An action this browser does not support.
        }
      }
    };
    set((action) => handlers[action]!);
    return () => set(() => null);
  }, [controller]);
}
