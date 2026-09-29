import { addKeyListener, playerKeysAvailable, setKeyCapture } from '@modules/player-keys';
import { useEffect, useEffectEvent } from 'react';
import { useTVEventHandler } from 'react-native';

export type RemoteAction =
  | 'toggle'
  | 'play'
  | 'pause'
  | 'back10'
  | 'forward30'
  | 'rewind'
  | 'fastForward'
  | 'up'
  | 'down'
  | 'stop';

/** Remote / media keys (Android `player-keys` names = react-native-tvos event types) mapped to player actions. */
export const REMOTE_KEYS: Readonly<Record<string, RemoteAction>> = {
  select: 'toggle',
  playPause: 'toggle',
  play: 'play',
  pause: 'pause',
  left: 'back10',
  right: 'forward30',
  rewind: 'rewind',
  fastForward: 'fastForward',
  up: 'up',
  down: 'down',
  stop: 'stop',
};

const DPAD_KEYS = ['select', 'left', 'right', 'up', 'down'];

/**
 * Player keys while `dpad` is true (D-pad + media keys) or only media keys otherwise (a panel owns focus).
 * Android captures them natively; tvOS uses react-native-tvos key events.
 */
export function useRemoteKeys(dpad: boolean, handler: (action: RemoteAction, key: string) => void) {
  const dispatch = (key: string) => {
    const action = REMOTE_KEYS[key];
    if (action && (dpad || !DPAD_KEYS.includes(key))) handler(action, key);
  };
  const onKey = useEffectEvent(dispatch);

  useEffect(() => {
    if (!playerKeysAvailable) return;
    setKeyCapture(dpad ? ['dpad', 'media'] : ['media']);
    const subscription = addKeyListener((event) => onKey(event.key));
    return () => {
      subscription?.remove();
      setKeyCapture([]);
    };
  }, [dpad]);

  useTVEventHandler((event) => {
    if (playerKeysAvailable) return;
    const keyAction = (event as { eventKeyAction?: number }).eventKeyAction;
    if (keyAction === undefined || keyAction === 0 || keyAction === -1) dispatch(event.eventType);
  });
}
