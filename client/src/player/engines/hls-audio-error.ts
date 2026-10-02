import type { ErrorData } from 'hls.js';

const AUDIO_PLAYLIST_ERRORS = new Set<string>(['audioTrackLoadError', 'audioTrackLoadTimeOut']);

/** Server code of a failed audio rendition request: 404 unknown rendition, 500 split failure. */
export function audioErrorCode(
  data: Pick<ErrorData, 'details'> & { frag?: { type?: string }; response?: { code?: number } }
): string | null {
  if (!AUDIO_PLAYLIST_ERRORS.has(data.details) && data.frag?.type !== 'audio') return null;
  const status = data.response?.code;
  return status === 404
    ? 'unknown_audio_rendition'
    : status === 500
      ? 'rendition_split_failed'
      : null;
}
