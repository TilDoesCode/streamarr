import { CLIENT_ERROR_CODES, VIEWER_ERROR_CODES } from '@/api/error-codes';
import { classify, type FailureSource } from '@/player/recovery/classify';

const engine = (reason: string, status?: number, kind: 'web' | 'expo-video' | 'vlc' = 'web') =>
  ({ kind: 'engine', engine: kind, reason, status }) as FailureSource;

describe('classify (state-matrix § 2 b.1)', () => {
  it.each([
    ['networkError:fragLoadTimeOut', undefined, 'T1', 'timeout'],
    ['networkError:manifestLoadError', 0, 'T1', 'network_unreachable'],
    ['networkError:levelLoadError', 404, 'T2', 'unknown_transcode'],
    ['networkError:fragLoadError', 410, 'T2', 'session_closed'],
    ['networkError:fragLoadError', 500, 'T6', 'server_error'],
    ['networkError:fragLoadError', 503, 'T6', 'segment_unavailable'],
    ['networkError:fragLoadError', 504, 'T5', 'segment_timeout'],
    ['mediaError:bufferAddCodecError', undefined, 'T7', 'decode_error'],
    ['muxError:fragParsingError', undefined, 'T7', 'decode_error'],
    ['keySystemError:keySystemNoKeys', undefined, 'T8', 'encrypted_media'],
    ['hlsjs:load', undefined, 'T11', 'player_load_failed'],
    ['media_error_2', undefined, 'T1', 'network_unreachable'],
    ['media_error_3', undefined, 'T7', 'decode_error'],
    ['MEDIA_ELEMENT_ERROR: Format error', undefined, 'T7', 'decode_error'],
  ])('web %s (status %s) → %s %s', (reason, status, category, code) => {
    expect(classify(engine(reason, status))).toMatchObject({ category, code, detail: reason });
  });

  it.each([
    [
      'A playback exception has occurred: Source error … Response code: 404',
      'T2',
      'unknown_transcode',
    ],
    ['Source error: ERROR_CODE_IO_NETWORK_CONNECTION_FAILED', 'T1', 'network_unreachable'],
    ['Source error: ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT', 'T1', 'timeout'],
    ['Decoder init failed: OMX.qcom.video.decoder.hevc', 'T7', 'decode_error'],
    ['AudioSink.InitializationException: AudioTrack init failed', 'T7', 'audio_decode_error'],
    ['ParserException: Input does not start with the #EXTM3U header.', 'T6', 'unexpected_format'],
    ['MediaCodec reclaimed by the system', 'T6', 'decoder_reclaimed'],
    ['DrmSessionException: no key', 'T8', 'encrypted_media'],
    ['The Internet connection appears to be offline.', 'T1', 'network_unreachable'],
    ['The request timed out.', 'T1', 'timeout'],
    [
      'An SSL error has occurred and a secure connection to the server cannot be made.',
      'T1',
      'tls_error',
    ],
    [
      'The operation couldn’t be completed. (CoreMediaErrorDomain error -12927.)',
      'T7',
      'decode_error',
    ],
    [
      'The operation couldn’t be completed. (CoreMediaErrorDomain error -12642.)',
      'T6',
      'unexpected_format',
    ],
    ['Something nobody has seen before', 'T7', 'engine_error'],
  ])('expo-video "%s" → %s %s', (reason, category, code) => {
    expect(classify(engine(reason, undefined, 'expo-video'))).toMatchObject({ category, code });
  });

  it('VLC errors and the stall watchdog are format failures', () => {
    expect(classify(engine('vlc_video_stalled', undefined, 'vlc'))).toMatchObject({
      category: 'T7',
      code: 'video_stalled',
    });
    expect(classify(engine('VLC is unable to open the MRL', undefined, 'vlc')).category).toBe('T7');
  });

  it('classifies API answers by code, then status, then name', () => {
    expect(classify({ kind: 'api', code: 'too_many_playbacks', status: 429 }).category).toBe('T4');
    expect(classify({ kind: 'api', code: 'playback_not_found', status: 404 }).category).toBe('T2');
    expect(classify({ kind: 'api', code: 'segment_timeout' }).category).toBe('T5');
    expect(classify({ kind: 'api', code: 'brand_new', status: 502 }).category).toBe('T6');
    expect(classify({ kind: 'api', code: 'refresh_something_new' }).category).toBe('T3');
  });

  it('classifies watchdog verdicts with their own card codes', () => {
    expect(classify({ kind: 'watchdog', verdict: 'picture-black' })).toEqual({
      category: 'T7',
      code: 'picture_black',
    });
    expect(classify({ kind: 'watchdog', verdict: 'clock-frozen' })).toEqual({
      category: 'T5',
      code: 'playback_stalled',
    });
    expect(classify({ kind: 'watchdog', verdict: 'slideshow' }).category).toBe('T5');
  });

  it('a media request answered with a status that tells nothing (405) is judged by the reason (review B6)', () => {
    expect(classify(engine('media_error_4', 405))).toMatchObject({
      category: 'T7',
      code: 'decode_error',
    });
    expect(classify(engine('media_error_2', 405))).toMatchObject({ category: 'T1' });
  });

  it('every known code has a category', () => {
    for (const code of [...CLIENT_ERROR_CODES, ...VIEWER_ERROR_CODES])
      expect(classify({ kind: 'api', code }).category).toMatch(/^T(1[01]?|[2-9])$/);
  });
});
