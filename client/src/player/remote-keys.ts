import { addKeyListener, playerKeysAvailable, setKeyCapture } from '@modules/player-keys';
import { useEffect, useEffectEvent } from 'react';
import { Platform, useTVEventHandler } from 'react-native';

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
  | 'stop'
  | 'fullscreen'
  | 'mute';

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
  escape: 'stop',
  mute: 'mute',
};

const DPAD_KEYS = ['select', 'left', 'right', 'up', 'down'];
const TVOS_LONG: Readonly<Record<string, string>> = { longLeft: 'left', longRight: 'right' };
/** A held ◀/▶ on the Siri Remote jumps like a held key on Android (60 s steps). */
export const TVOS_LONG_REPEAT = 20;

/**
 * Player keys while `dpad` is true (D-pad + media keys) or only media keys otherwise (a panel owns focus).
 * Android and the iPad keyboard capture them natively; tvOS uses react-native-tvos key events.
 */
export function useRemoteKeys(
  dpad: boolean,
  handler: (action: RemoteAction, key: string, repeat: number) => void | 'release'
) {
  const dispatch = (key: string, repeat = 0) => {
    const action = REMOTE_KEYS[key];
    if (!action || (!dpad && DPAD_KEYS.includes(key))) return;
    // Hand the D-pad back to native focus now, not after the next render, so a quick next key moves focus.
    const release = handler(action, key, repeat) === 'release';
    if (release && playerKeysAvailable && Platform.OS === 'android') setKeyCapture(['media']);
  };
  const onKey = useEffectEvent(dispatch);

  useEffect(() => {
    if (!playerKeysAvailable) return;
    setKeyCapture(dpad ? ['dpad', 'media'] : ['media']);
    const subscription = addKeyListener((event) => onKey(event.key, event.repeat));
    return () => {
      subscription?.remove();
      setKeyCapture([]);
    };
  }, [dpad]);

  useTVEventHandler((event) => {
    if (playerKeysAvailable) return;
    const keyAction = (event as { eventKeyAction?: number }).eventKeyAction;
    if (Platform.OS === 'ios') {
      // tvOS taps only end (key up); a long press reports its start (key down).
      const long = TVOS_LONG[event.eventType];
      if (long && keyAction === 0) dispatch(long, TVOS_LONG_REPEAT);
      else if (keyAction === undefined || keyAction === 1) dispatch(event.eventType);
      return;
    }
    if (keyAction === undefined || keyAction === 0 || keyAction === -1) dispatch(event.eventType);
  });
}
