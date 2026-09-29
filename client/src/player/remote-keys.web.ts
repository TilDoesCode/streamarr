import { useEffect, useEffectEvent } from 'react';

import type { RemoteAction } from './remote-keys';

export type { RemoteAction } from './remote-keys';

const KEYBOARD: Readonly<Record<string, RemoteAction>> = {
  ' ': 'toggle',
  k: 'toggle',
  ArrowLeft: 'back10',
  ArrowRight: 'forward30',
  j: 'rewind',
  l: 'fastForward',
  ArrowUp: 'up',
  ArrowDown: 'down',
  MediaPlayPause: 'toggle',
  MediaPlay: 'play',
  MediaPause: 'pause',
  MediaStop: 'stop',
  MediaRewind: 'rewind',
  MediaFastForward: 'fastForward',
};

/** Keyboard and media keys in the browser, same actions as the TV remote. */
export function useRemoteKeys(dpad: boolean, handler: (action: RemoteAction, key: string) => void) {
  const onKey = useEffectEvent(handler);
  useEffect(() => {
    if (!dpad) return;
    const listener = (event: KeyboardEvent) => {
      const action = KEYBOARD[event.key];
      if (!action) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      event.preventDefault();
      onKey(action, event.key);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [dpad]);
}
