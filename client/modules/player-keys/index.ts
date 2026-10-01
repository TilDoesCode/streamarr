import { NativeModule, requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export type KeyGroup = 'dpad' | 'media';
export type PlayerKeyEvent = { key: string; repeat: number; time: number };

declare class PlayerKeysModule extends NativeModule<{ onKey(event: PlayerKeyEvent): void }> {
  setCapture(groups: KeyGroup[]): void;
}

// Android and the iPad keyboard; tvOS and the web get their keys from React Native / the DOM.
const native =
  Platform.OS === 'ios' && Platform.isTV
    ? null
    : requireOptionalNativeModule<PlayerKeysModule>('PlayerKeys');

export const playerKeysAvailable = native !== null;

/** Takes the given key groups before the Activity (no MediaSession, no focus search) and reports them as `onKey`. */
export function setKeyCapture(groups: KeyGroup[]): void {
  native?.setCapture(groups);
}

export function addKeyListener(
  listener: (event: PlayerKeyEvent) => void
): { remove(): void } | null {
  return native?.addListener('onKey', listener) ?? null;
}
