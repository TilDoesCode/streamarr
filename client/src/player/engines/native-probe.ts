import type { EngineHealth } from '../health/types';
import type { EngineStats, SystemCause } from './types';

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
  /** The request that failed (Exo: the data spec or the last load error; AVPlayer: the error-log URI). */
  uri?: string | null;
};

/** A media request that failed while the player goes on or retries (patched `loadError` event). */
export type NativeLoadError = {
  uri?: string | null;
  /** `audio` · `video` · `text` · `other`, when the player knows the track type. */
  trackType?: string | null;
  status?: number | null;
  /** AVPlayer's error-log entry (domain, code, comment); segment entries carry no URI, playlist entries do. */
  domain?: string | null;
  code?: number | null;
  comment?: string | null;
};

/** A load error the player actually had: from AVPlayer's error log only network errors and HTTP 4xx/5xx (S4p R3). */
export function isFailedLoad(error: NativeLoadError): boolean {
  // Exo names no domain: its load errors are failed requests.
  if (!error.domain) return true;
  if ((error.status ?? 0) >= 400) return true;
  // Status-less CoreMedia entries (-12318 bandwidth, -12889 late segment, -12971 stale live playlist …) are notes.
  return error.domain === 'NSURLErrorDomain';
}

/** Which part of a Streamarr HLS session a URL addresses (docs/api.md § HLS); `other` = a playlist or a direct file. */
export function mediaPart(uri: string | null | undefined): 'audio' | 'text' | 'segment' | 'other' {
  if (!uri) return 'other';
  const path = uri.split('?')[0]!;
  if (/\/audio\/\d+\//.test(path)) return 'audio';
  if (/\/subtitles\/\d+\//.test(path) || /\.vtt$/.test(path)) return 'text';
  if (/\/(?:\d+\.m4s|init\.mp4)$/.test(path)) return 'segment';
  return 'other';
}

/** The part a load error belongs to: the player's track type first, the URL otherwise. */
export function loadErrorPart(error: NativeLoadError): 'audio' | 'text' | 'segment' | 'other' {
  if (error.trackType === 'audio' || error.trackType === 'text') return error.trackType;
  return mediaPart(error.uri);
}

/** The subtitle code the controller's subtitle path knows (same as the web engine's). */
export function subtitleCode(status: number | null | undefined): string {
  return status === 404 ? 'unknown_subtitle_stream' : 'subtitle_unavailable';
}

/** Container data that does not parse: a damaged segment, not a device that cannot decode (D41). */
const DAMAGED = /PARSING_CONTAINER_(?:MALFORMED|UNSUPPORTED)|ParserException/;
const CONTAINER = /PARSING_CONTAINER_/;

/** The engine reason for a failed item: an audio rendition or a damaged segment get their own prefix (D36, D41). */
export function failureReason(
  error: NativeError | undefined,
  playing: boolean,
  hls = false
): string {
  const reason = errorReason(error);
  if (!error) return reason;
  const part = mediaPart(error.uri);
  // Exo names no URI for a parser error (S6t): on HLS only a container error is a segment; a manifest error never is (S4p B2).
  const segment = part === 'segment' || (hls && !error.uri && CONTAINER.test(reason));
  if (segment && DAMAGED.test(reason)) return `damagedSegment:${reason}`;
  // A dead audio rendition while the picture plays is the audio path, any status but 404/410 (S9c D36).
  const lost = error.httpStatus === 404 || error.httpStatus === 410;
  if (part === 'audio' && playing && !lost) return `audioRendition:${reason}`;
  return reason;
}

type RawHealth = Record<string, number | boolean | string | null | undefined>;

/** The patched player: `readHealthAsync`, `setSubtitleLift` and the `systemPlayback` event. */
export type NativeProbe = {
  /** `withFrames`: count new frames with an AVPlayerItemVideoOutput (Apple; ignored on Android). */
  readHealthAsync?: (withFrames?: boolean) => Promise<RawHealth | null>;
  /** The bottom share of the view the subtitle cues stay above (F13n); 0 = their own place. */
  setSubtitleLift?: (lift: number, ceiling?: number) => void;
  addListener(
    name: 'systemPlayback',
    listener: (event: { paused: boolean; cause: string }) => void
  ): { remove(): void };
  addListener(name: 'loadError', listener: (event: NativeLoadError) => void): { remove(): void };
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
  background: 'background',
  pipClosed: 'pipClosed',
  airplayLost: 'airplayLost',
};

/** A native pause cause; `remote` (media keys) is the viewer's own; a TV's "headphones" is an HDMI/soundbar output change. */
export function systemCause(cause: string, tv = false): SystemCause | null {
  if (tv && cause === 'headphones') return 'audioOutput';
  // A TV has no lock screen: an intent or another app paused the activity (A12 on Google TV).
  if (tv && cause === 'locked') return 'background';
  return CAUSES[cause] ?? null;
}

/** CoreMedia/URL errors that are an HTTP or transport failure; only these may carry an error-log status. */
const TRANSPORT_CODES = new Set([-12938, -12660, -12645, -1100, -1102, -1011, -1009, -1001]);

/** Drops an AVPlayer error-log status and entry that belong to an older, recovered request (a decoder failure is no 404). */
export function ownFailure(error: NativeError | undefined): NativeError | undefined {
  if (!error?.domain || error.errorCodeName) return error;
  const transport =
    error.domain === 'NSURLErrorDomain' ||
    error.underlyingDomain === 'NSURLErrorDomain' ||
    TRANSPORT_CODES.has(error.code ?? 0) ||
    TRANSPORT_CODES.has(error.underlyingCode ?? 0);
  return transport ? error : { ...error, httpStatus: null, errorLog: null };
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

/** The Info panel's numbers: real decoder counters only (Exo); AVPlayer's sampled frame count is no total. */
export function toStats(raw: RawHealth | null | undefined): EngineStats {
  const stats: EngineStats = {};
  if (!raw) return stats;
  const { framesDropped, framesPresented, bandwidthBps, decoderName } = raw;
  if (typeof framesDropped === 'number' && Number.isFinite(framesDropped)) {
    stats.droppedFrames = framesDropped;
    if (typeof framesPresented === 'number') stats.totalFrames = framesPresented;
  }
  if (typeof bandwidthBps === 'number' && bandwidthBps > 0) stats.bandwidth = bandwidthBps;
  // A build that names the decoder sends an empty name once it is gone: the old one must not stay in the merged stats (R9).
  if (typeof decoderName === 'string' && decoderName) stats.decoder = decoderName;
  else if ('decoderName' in raw) stats.decoder = undefined;
  return stats;
}
