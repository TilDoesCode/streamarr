import { categoryOf, categoryOfStatus, type ErrorCategory } from '@/api/error-categories';
import type { EngineKind } from '@/player/engines/types';

export type { ErrorCategory } from '@/api/error-categories';

/** Health verdicts of the watchdog (state-matrix § 2 a). */
export type WatchdogVerdict =
  'clock-frozen' | 'picture-black' | 'picture-frozen' | 'audio-silent' | 'slideshow';

export type FailureSource =
  /** An answer of the Streamarr API (error envelope code, HTTP status; 0 = no answer). */
  | { kind: 'api'; code: string; status?: number }
  /** An engine `error` event; `status` is the HTTP status of the failed media request when the engine knows it. */
  | { kind: 'engine'; engine: EngineKind; reason: string; status?: number }
  | { kind: 'watchdog'; verdict: WatchdogVerdict };

export type Classified = { category: ErrorCategory; code: string; detail?: string };

/** Engine codes for media failures that have no server code (shown as "Code: …" under the category text). */
const MEDIA_STATUS_CODES: Record<number, string> = {
  404: 'unknown_transcode',
  410: 'session_closed',
  503: 'segment_unavailable',
  504: 'segment_timeout',
};

/** Statuses of a media request that say what happened; any other (405, 400 …) says nothing and the reason decides. */
const telling = (status: number) => [401, 403, 404, 410, 416].includes(status) || status >= 500;

/** A failed media request: 401/403/404/410 mean the capability or session is gone, 503 a transient server failure. */
function mediaStatus(status: number, detail: string): Classified {
  if (status === 401 || status === 403) return { category: 'T2', code: 'unknown_stream', detail };
  // A range past the end of a direct-play file: the file is shorter than announced (C02).
  if (status === 416) return { category: 'T8', code: 'end_of_stream', detail };
  const code = MEDIA_STATUS_CODES[status] ?? (status >= 500 ? 'server_error' : `http_${status}`);
  const category: ErrorCategory = status === 503 ? 'T6' : (categoryOfStatus(status) ?? 'T11');
  return { category, code, detail };
}

const TLS =
  /ssl|tls|certificate|certpath|trust anchor|handshake|x509|pkix|secure connection|NSURLErrorDomain -12\d\d\b/i;
const TIMEOUT = /timed? ?out|NSURLErrorDomain (?:error )?-1001\b|\(-1001\)/i;
const OFFLINE =
  /offline|not connected to the internet|network connection was lost|unable to connect|could not connect|failed to connect|unknownhost|unable to resolve host|connectexception|ERROR_CODE_IO_NETWORK|NSURLErrorDomain|error -10(0[0-9])\b|net::ERR_|network ?error|networkError|MEDIA_ERR_NETWORK|media_error_2\b/i;
const DECODER =
  /decod|codec|AUDIO_TRACK|AudioSink|audio track init|-12927|-11821|-12909|-11828|unsupported|not supported|SRC_NOT_SUPPORTED|media_error_[34]\b|FORMAT_|PIPELINE_ERROR|DEMUXER_ERROR|format error/i;
/** Audio-only decoder or output failures: converting the audio (ladder step A) may fix them (D13, C27). */
const AUDIO_DECODER =
  /AUDIO_TRACK|AudioSink|audio track init|MediaCodecAudioRenderer|AUDIO_RENDERER|audio decod|audio codec|AudioToolbox|AudioQueue|:audio$|DECOD\w*(?: \(.*\))? \[audio\//i;
const PARSER = /ParserException|PARSING_|-12642|-11850|unexpected format|content type/i;
const ENCRYPTED = /keySystem|KEY_SYSTEM|DrmSession|DRM|-42\d{3}|encrypted|keyLoad/i;
const RECLAIMED = /reclaim|-11819\b/i;
const CLEARTEXT = /CLEARTEXT/i;
/** Browser network messages: Chrome's demuxer read error, Firefox's NS_ERROR_NET_*, Chromium net errors. */
const WEB_NETWORK = /PIPELINE_ERROR_READ|NS_ERROR_NET_|NS_ERROR_CONNECTION|net::ERR_/;
/** libVLC's input dialog "VLC is unable to open the MRL 'http…'": the source itself did not open (S9c). */
const VLC_CANNOT_OPEN = /unable to open the MRL '?https?:/i;
const INTERCEPTED_MANIFEST = /PARSING_MANIFEST_\w*.*(?:does not start with the #EXTM3U|<html)/i;

/** AVFoundation's codes for an HTTP refusal: -12938 / NSURL -1100 = 404, -12660 / NSURL -1102 = 403. */
function avFoundationStatus(reason: string): number | undefined {
  if (/-12938\b|NSURLErrorDomain -1100\b/.test(reason)) return 404;
  if (/-12660\b|NSURLErrorDomain -1102\b/.test(reason)) return 403;
  return undefined;
}

/** hls.js reasons are `<ErrorType>:<ErrorDetails>` (web engine), e.g. `networkError:fragLoadError`. */
function hlsReason(reason: string, status?: number): Classified | undefined {
  const match =
    /^(networkError|mediaError|muxError|keySystemError|otherError):(\w+)(?::\w+)?$/.exec(reason);
  if (!match) return undefined;
  const [, type, details] = match;
  if (type === 'networkError') {
    if (status !== undefined && telling(status)) return mediaStatus(status, reason);
    return {
      category: 'T1',
      code: /TimeOut/.test(details!) ? 'timeout' : 'network_unreachable',
      detail: reason,
    };
  }
  if (type === 'keySystemError') return { category: 'T8', code: 'encrypted_media', detail: reason };
  return undefined;
}

/** A browser media error of the network: MEDIA_ERR_NETWORK, an unreachable HEAD probe or a network message (D09). */
function webNetwork(reason: string, status: number | undefined): boolean {
  if (/^media_error_[34]\b/.test(reason)) return false;
  return status === 0 || /^media_error_2\b/.test(reason) || WEB_NETWORK.test(reason);
}

function engineFailure(source: Extract<FailureSource, { kind: 'engine' }>): Classified {
  const { reason, status } = source;
  if (reason === 'hlsjs:load')
    return { category: 'T11', code: 'player_load_failed', detail: reason };
  if (reason.startsWith('audioRendition:'))
    return { category: 'T7', code: 'audio_rendition_failed', detail: reason };
  // A segment whose container data does not parse: the content is damaged there, the device is fine (D41).
  if (reason.startsWith('damagedSegment:'))
    return { category: 'T7', code: 'media_damaged', detail: reason };
  const hls = hlsReason(reason, status);
  if (hls) return hls;
  // libVLC names no HTTP status; the engine asks the server (S6x): a telling one decides before any dialog wording.
  if (source.engine === 'vlc' && status !== undefined && telling(status))
    return mediaStatus(status, reason);
  // libVLC cannot open the http(s) source and nobody knows why: the server lost it (T2, S9c VLC 404).
  if (VLC_CANNOT_OPEN.test(reason) && !TLS.test(reason))
    return mediaStatus(Number(/\b(40[134]|410|5\d\d)\b/.exec(reason)?.[1] ?? 404), reason);
  // libVLC asked a question nobody answers: a certificate one is TLS, the rest "VLC cannot play this" (D27).
  if (reason.startsWith('vlc_dialog'))
    return TLS.test(reason)
      ? { category: 'T1', code: 'tls_error', detail: reason }
      : { category: 'T7', code: 'vlc_dialog', detail: reason };
  const responseCode = /Response code: (\d{3})|HTTP (?:status )?(\d{3})|status code (\d{3})/i.exec(
    reason
  );
  const httpStatus =
    status ??
    (responseCode ? Number(responseCode.slice(1).find(Boolean)) : undefined) ??
    avFoundationStatus(reason);
  if (httpStatus !== undefined && telling(httpStatus)) return mediaStatus(httpStatus, reason);
  if (TLS.test(reason)) return { category: 'T1', code: 'tls_error', detail: reason };
  // Exo names a missing file or an unspecified I/O failure: the stream is gone (T2) or broke off (T1), not the device (D11).
  if (/ERROR_CODE_IO_FILE_NOT_FOUND/.test(reason)) return mediaStatus(404, reason);
  if (/ERROR_CODE_IO_UNSPECIFIED/.test(reason))
    return { category: 'T1', code: 'stream_interrupted', detail: reason };
  if (source.engine === 'web' && webNetwork(reason, status))
    return { category: 'T1', code: 'network_unreachable', detail: reason };
  if (ENCRYPTED.test(reason)) return { category: 'T8', code: 'encrypted_media', detail: reason };
  if (RECLAIMED.test(reason)) return { category: 'T6', code: 'decoder_reclaimed', detail: reason };
  if (CLEARTEXT.test(reason))
    return { category: 'T11', code: 'cleartext_not_permitted', detail: reason };
  // A VOD source never has a live window: the engine lost its place, a reload at the position helps (D14).
  if (/BEHIND_LIVE_WINDOW/.test(reason))
    return { category: 'T1', code: 'stream_interrupted', detail: reason };
  // A playlist that is a web page (hotel or captive portal answering HTML): the network, not the file (A26, S4p B2).
  if (INTERCEPTED_MANIFEST.test(reason))
    return { category: 'T1', code: 'network_intercepted', detail: reason };
  // Any other playlist error is the stream's format, never this device's decoder (S4p B2).
  if (/PARSING_MANIFEST_/.test(reason))
    return { category: 'T6', code: 'unexpected_format', detail: reason };
  if (AUDIO_DECODER.test(reason))
    return { category: 'T7', code: 'audio_decode_error', detail: reason };
  if (DECODER.test(reason) || /^(mediaError|muxError|otherError):/.test(reason))
    return { category: 'T7', code: 'decode_error', detail: reason };
  if (PARSER.test(reason)) return { category: 'T6', code: 'unexpected_format', detail: reason };
  if (TIMEOUT.test(reason)) return { category: 'T1', code: 'timeout', detail: reason };
  if (OFFLINE.test(reason)) return { category: 'T1', code: 'network_unreachable', detail: reason };
  // An engine failure nothing else explains stays "this method does not play here".
  return {
    category: 'T7',
    code: source.engine === 'vlc' ? 'vlc_error' : 'engine_error',
    detail: reason,
  };
}

const FORMATS: [RegExp, string][] = [
  [/-12927\b/, 'HDR'],
  [/video\/(?:hevc|hev1|hvc1)/i, 'HEVC'],
  [/video\/dolby-vision/i, 'Dolby Vision'],
  [/video\/av01/i, 'AV1'],
  [/video\/avc/i, 'H.264'],
  [/video\/x-vnd\.on2\.vp9/i, 'VP9'],
  [/audio\/eac3/i, 'E-AC-3'],
  [/audio\/ac3/i, 'AC-3'],
  [/audio\/(?:vnd\.dts|dts)/i, 'DTS'],
  [/audio\/true-?hd/i, 'TrueHD'],
];

/** The format a decoder refused, named for the `decoder` hint ("This device can't play HEVC"); null = unknown. */
export function decoderFormat(detail: string | undefined): string | null {
  if (!detail) return null;
  return FORMATS.find(([pattern]) => pattern.test(detail))?.[1] ?? null;
}

const VERDICT_CATEGORY: Record<WatchdogVerdict, ErrorCategory> = {
  'clock-frozen': 'T5',
  'picture-black': 'T7',
  'picture-frozen': 'T7',
  'audio-silent': 'T7',
  slideshow: 'T5',
};

/** Codes with their own card text for each verdict. */
const VERDICT_CODE: Record<WatchdogVerdict, string> = {
  'clock-frozen': 'playback_stalled',
  'picture-black': 'picture_black',
  'picture-frozen': 'picture_frozen',
  'audio-silent': 'audio_silent',
  slideshow: 'playback_slideshow',
};

/** One category for every failure: API answers, engine errors and watchdog verdicts. */
export function classify(source: FailureSource): Classified {
  switch (source.kind) {
    case 'api':
      return { category: categoryOf(source.code, source.status), code: source.code };
    case 'engine':
      return engineFailure(source);
    case 'watchdog':
      return { category: VERDICT_CATEGORY[source.verdict], code: VERDICT_CODE[source.verdict] };
  }
}
