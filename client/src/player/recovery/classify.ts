import { categoryOf, categoryOfStatus, type ErrorCategory } from '@/api/error-categories';
import { isAppError, toAppError } from '@/api/errors';
import type { EngineKind } from '@/player/engines/types';

export type { ErrorCategory } from '@/api/error-categories';

/** Health verdicts of the watchdog (state-matrix § 2 a). */
export type WatchdogVerdict =
  | 'starting'
  | 'buffering'
  | 'clock-frozen'
  | 'picture-black'
  | 'picture-frozen'
  | 'audio-silent'
  | 'slideshow';

/** Why the OS or the browser paused or took over playback (T10). */
export type SystemCause =
  | 'call'
  | 'otherAudio'
  | 'headphones'
  | 'locked'
  | 'pipClosed'
  | 'airplayLost'
  | 'airplay'
  | 'autoplayMuted'
  | 'autoplayBlocked';

export type FailureSource =
  /** An answer of the Streamarr API (error envelope code, HTTP status; 0 = no answer). */
  | { kind: 'api'; code: string; status?: number }
  /** An engine `error` event; `status` is the HTTP status of the failed media request when the engine knows it. */
  | { kind: 'engine'; engine: EngineKind; reason: string; status?: number }
  | { kind: 'watchdog'; verdict: WatchdogVerdict }
  | { kind: 'system'; cause: SystemCause }
  | { kind: 'exception'; error: unknown };

export type Classified = { category: ErrorCategory; code: string; detail?: string };

/** Engine codes for media failures that have no server code (shown as "Code: …" under the category text). */
const MEDIA_STATUS_CODES: Record<number, string> = {
  404: 'unknown_transcode',
  410: 'session_closed',
  503: 'segment_unavailable',
  504: 'segment_timeout',
};

/** A failed media request: 404/410 mean the session is gone, 503 a transient server failure (not "busy"). */
function mediaStatus(status: number, detail: string): Classified {
  const code = MEDIA_STATUS_CODES[status] ?? (status >= 500 ? 'server_error' : `http_${status}`);
  const category: ErrorCategory =
    status === 503 ? 'T6' : status === 0 ? 'T1' : (categoryOfStatus(status) ?? 'T11');
  return { category, code: status === 0 ? 'network_unreachable' : code, detail };
}

const TLS = /ssl|tls|certificate|certpath|trust anchor|handshake|x509|pkix|secure connection/i;
const TIMEOUT = /timed? ?out|NSURLErrorDomain error -1001\b|\(-1001\)/i;
const OFFLINE =
  /offline|not connected to the internet|network connection was lost|unable to connect|could not connect|failed to connect|unknownhost|unable to resolve host|connectexception|ERROR_CODE_IO_NETWORK|NSURLErrorDomain|error -10(0[0-9])\b|net::ERR_|network ?error|networkError|MEDIA_ERR_NETWORK|media_error_2\b/i;
const DECODER =
  /decod|codec|AUDIO_TRACK|AudioSink|audio track init|-12927|-11821|-12909|-11828|unsupported|not supported|SRC_NOT_SUPPORTED|media_error_[34]\b|FORMAT_|PIPELINE_ERROR|DEMUXER_ERROR|format error/i;
const PARSER = /ParserException|PARSING_|-12642|-11850|unexpected format|content type/i;
const ENCRYPTED = /keySystem|KEY_SYSTEM|DrmSession|DRM|-42\d{3}|encrypted|keyLoad/i;
const RECLAIMED = /reclaim/i;

/** hls.js reasons are `<ErrorType>:<ErrorDetails>` (web engine), e.g. `networkError:fragLoadError`. */
function hlsReason(reason: string, status?: number): Classified | undefined {
  const match = /^(networkError|mediaError|muxError|keySystemError|otherError):(\w+)$/.exec(reason);
  if (!match) return undefined;
  const [, type, details] = match;
  if (type === 'networkError') {
    if (status !== undefined && status > 0) return mediaStatus(status, reason);
    return {
      category: 'T1',
      code: /TimeOut/.test(details!) ? 'timeout' : 'network_unreachable',
      detail: reason,
    };
  }
  if (type === 'keySystemError') return { category: 'T8', code: 'encrypted_media', detail: reason };
  return { category: 'T7', code: 'decode_error', detail: reason };
}

function engineFailure(source: Extract<FailureSource, { kind: 'engine' }>): Classified {
  const { reason, status } = source;
  if (reason === 'hlsjs:load')
    return { category: 'T11', code: 'player_load_failed', detail: reason };
  const hls = hlsReason(reason, status);
  if (hls) return hls;
  if (reason === 'vlc_video_stalled')
    return { category: 'T7', code: 'video_stalled', detail: reason };
  const responseCode = /Response code: (\d{3})|HTTP (?:status )?(\d{3})|status code (\d{3})/i.exec(
    reason
  );
  const httpStatus =
    status ?? (responseCode ? Number(responseCode.slice(1).find(Boolean)) : undefined);
  if (httpStatus !== undefined && httpStatus >= 400) return mediaStatus(httpStatus, reason);
  if (TLS.test(reason)) return { category: 'T1', code: 'tls_error', detail: reason };
  if (ENCRYPTED.test(reason)) return { category: 'T8', code: 'encrypted_media', detail: reason };
  if (RECLAIMED.test(reason)) return { category: 'T6', code: 'decoder_reclaimed', detail: reason };
  if (DECODER.test(reason)) return { category: 'T7', code: 'decode_error', detail: reason };
  if (PARSER.test(reason)) return { category: 'T6', code: 'unexpected_format', detail: reason };
  if (TIMEOUT.test(reason)) return { category: 'T1', code: 'timeout', detail: reason };
  if (OFFLINE.test(reason)) return { category: 'T1', code: 'network_unreachable', detail: reason };
  // An engine failure nothing else explains stays "this method does not play here".
  return { category: 'T7', code: 'engine_error', detail: reason };
}

const VERDICT_CATEGORY: Record<WatchdogVerdict, ErrorCategory> = {
  starting: 'T7',
  buffering: 'T5',
  'clock-frozen': 'T5',
  'picture-black': 'T7',
  'picture-frozen': 'T7',
  'audio-silent': 'T7',
  slideshow: 'T5',
};

/** One category for every failure: API answers, engine errors, watchdog verdicts, OS events and exceptions. */
export function classify(source: FailureSource): Classified {
  switch (source.kind) {
    case 'api':
      return { category: categoryOf(source.code, source.status), code: source.code };
    case 'engine':
      return engineFailure(source);
    case 'watchdog':
      return { category: VERDICT_CATEGORY[source.verdict], code: source.verdict };
    case 'system':
      return { category: 'T10', code: source.cause };
    case 'exception': {
      if (isAppError(source.error))
        return {
          category: categoryOf(source.error.code, source.error.status || undefined),
          code: source.error.code,
          detail: source.error.detail,
        };
      const error = toAppError(source.error);
      const detail = source.error instanceof Error ? source.error.message : String(source.error);
      return { category: categoryOf(error.code), code: error.code, detail };
    }
  }
}
