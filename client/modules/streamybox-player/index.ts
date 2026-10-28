import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType, Ref } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';

type StreamyboxPlayerModule = { isAvailable?: () => boolean; probeAsync?: () => Promise<boolean> };

/** One contract event (`dev.streamybox.player.render`), still as the player's JSON text. */
export type StreamyboxNativeEvent = { nativeEvent: { json: string } };

export type StreamyboxViewRef = { stop(): Promise<void> };

/** Commands as props: the native view applies what changed once its render session is attached. */
export type StreamyboxViewProps = {
  style?: StyleProp<ViewStyle>;
  source: string | null;
  /** JSON options of the contract's `load` (title, startPositionMs, headers, externalSubtitles). */
  loadOptions: string;
  /** A new value loads `source` again. */
  loadNonce: number;
  paused: boolean;
  muted: boolean;
  /** mpv `aid`; omitted = the player's own pick. */
  audioTrack?: number;
  /** mpv `sid`; -1 = off. */
  subtitleTrack: number;
  seekMs: number;
  /** A new value seeks to `seekMs`. */
  seekNonce: number;
  onPlayerEvent?: (event: StreamyboxNativeEvent) => void;
  ref?: Ref<StreamyboxViewRef>;
};

// Android only: the render service lives in dev.streamybox.player (Streamybox boxes).
const native =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<StreamyboxPlayerModule>('StreamyboxPlayer')
    : null;

/** The native view; null where the module is missing (other platforms, builds without it). */
export const StreamyboxPlayerView: ComponentType<StreamyboxViewProps> | null = native
  ? requireNativeView<StreamyboxViewProps>('StreamyboxPlayer')
  : null;

let cached: boolean | null = null;

/** Whether the Streamybox player's embedded render service is installed (synchronous, cached). */
export function streamyboxInstalled(): boolean {
  if (cached === null) cached = !!StreamyboxPlayerView && (native?.isAvailable?.() ?? false);
  return cached;
}

/** Binds the render service once and checks its contract version; `streamyboxInstalled()` returns this afterwards. */
export async function probeStreamyboxInstalled(): Promise<boolean> {
  const installed = !!StreamyboxPlayerView && (native?.isAvailable?.() ?? false);
  cached = installed && ((await native?.probeAsync?.().catch(() => false)) ?? false);
  return cached;
}
