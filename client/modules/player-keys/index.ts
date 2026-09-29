import { NativeModule, requireOptionalNativeModule } from 'expo';

export type KeyGroup = 'dpad' | 'media';
export type PlayerKeyEvent = { key: string; repeat: number; time: number };

declare class PlayerKeysModule extends NativeModule<{ onKey(event: PlayerKeyEvent): void }> {
  setCapture(groups: KeyGroup[]): void;
}

// Android only; tvOS and the web get their keys from React Native / the DOM.
const native = requireOptionalNativeModule<PlayerKeysModule>('PlayerKeys');

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
