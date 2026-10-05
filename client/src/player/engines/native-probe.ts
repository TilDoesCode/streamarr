import type { EngineHealth } from '../health/types';
import type { SystemCause } from './types';

/** What patches/expo-video adds to a failed item: ExoPlayer's code name, AVFoundation's NSError and error log. */
export type NativeError = {
  message?: string | null;
  errorCodeName?: string | null;
  httpStatus?: number | null;
  mimeType?: string | null;
  domain?: string | null;
  code?: number | null;
  underlyingDomain?: string | null;
  underlyingCode?: number | null;
  errorLog?: string | null;
};

type RawHealth = Record<string, number | boolean | string | null | undefined>;

/** The patched player: `readHealthAsync` and the `systemPlayback` event. */
export type NativeProbe = {
  /** `withFrames`: count new frames with an AVPlayerItemVideoOutput (Apple; ignored on Android). */
  readHealthAsync?: (withFrames?: boolean) => Promise<RawHealth | null>;
  addListener(
    name: 'systemPlayback',
    listener: (event: { paused: boolean; cause: string }) => void
  ): { remove(): void };
};

/** `CODE (UNDERLYING) [mime]: message`, the shape `classify` reads; the message alone without the patch. */
export function errorReason(error: NativeError | undefined): string {
  if (!error) return 'expo_video_error';
  const message = error.message ?? '';
  const code =
    error.errorCodeName ?? (error.domain ? `${error.domain} ${error.code ?? ''}`.trim() : null);
  if (!code) return message || 'expo_video_error';
  const underlying = error.underlyingDomain
    ? ` (${error.underlyingDomain} ${error.underlyingCode ?? ''})`.replace(' )', ')')
    : '';
  const format = error.mimeType ? ` [${error.mimeType}]` : '';
  const log = error.errorLog ? ` {${error.errorLog}}` : '';
  return `${code}${underlying}${format}${log}: ${message}`;
}

const CAUSES: Record<string, SystemCause> = {
  call: 'call',
  otherAudio: 'otherAudio',
  headphones: 'headphones',
  locked: 'locked',
  pipClosed: 'pipClosed',
  airplayLost: 'airplayLost',
};

/** A native pause cause; `remote` (media keys, notification) is the viewer's own pause, not a system one. */
export function systemCause(cause: string): SystemCause | null {
  return CAUSES[cause] ?? null;
}

const NUMBERS = [
  'framesPresented',
  'framesDropped',
  'framesDecoded',
  'audioProgress',
  'bandwidthBps',
  'nativePosition',
] as const;
const FLAGS = ['readyForDisplay', 'hasVideoTrack', 'hasAudioTrack', 'external'] as const;

/** The native map in the one EngineHealth shape; missing or null = the platform cannot tell. */
export function toHealth(raw: RawHealth | null | undefined): EngineHealth {
  const health: EngineHealth = {};
  if (!raw) return health;
  for (const key of NUMBERS) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) health[key] = value;
  }
  for (const key of FLAGS) {
    const value = raw[key];
    if (typeof value === 'boolean') health[key] = value;
  }
  return health;
}
