import type { Recovery } from '@/player/recovery/runner';
import { runningHint } from '@/player/recovery/status';

import {
  failureReason,
  mediaPart,
  ownFailure,
  systemCause,
  toHealth,
  toStats,
} from '../engines/native-probe';
import { VlcEngine } from '../engines/vlc-engine';

jest.mock('expo-libvlc-player', () => ({ LibVlcPlayerView: () => null }));

describe('native probe (S6r review gaps)', () => {
  it('drops NaN and Infinity from a native health map', () => {
    expect(
      toHealth({ framesPresented: Number.NaN, nativePosition: Infinity, audioProgress: 3 })
    ).toEqual({ audioProgress: 3 });
  });

  it('keeps an error-log status only for a transport failure', () => {
    const log = { errorLog: 'CoreMediaErrorDomain 404 HTTP 404', httpStatus: 404 };
    expect(ownFailure({ domain: 'AVFoundationErrorDomain', code: -11821, ...log })).toMatchObject({
      httpStatus: null,
      errorLog: null,
    });
    expect(ownFailure({ domain: 'NSURLErrorDomain', code: -1100, ...log })).toMatchObject(log);
    expect(
      ownFailure({
        domain: 'AVFoundationErrorDomain',
        code: -11800,
        underlyingCode: -12660,
        ...log,
      })
    ).toMatchObject(log);
    // ExoPlayer's status comes from the failing request itself.
    expect(ownFailure({ errorCodeName: 'ERROR_CODE_IO_BAD_HTTP_STATUS', ...log })).toMatchObject(
      log
    );
  });

  it('maps native causes: remote is the viewer, a TV output change is no headphones', () => {
    expect(systemCause('remote')).toBeNull();
    expect(systemCause('background')).toBe('background');
    expect(systemCause('headphones', true)).toBe('audioOutput');
  });

  it('names the refused audio format when an audio decoder failure steps down (review 18)', () => {
    const recovery = {
      decision: { step: 'S', delayMs: 0 },
      failure: {
        category: 'T7',
        code: 'audio_decode_error',
        detail: 'ERROR_CODE_DECODING_FAILED [audio/eac3]: x',
      },
      position: 42,
    } as unknown as Recovery;
    expect(runningHint(recovery)).toMatchObject({ key: 'decoder', params: { format: 'E-AC-3' } });
  });

  it('VLC says nothing about the picture before its clock started (review 15)', async () => {
    const engine = new VlcEngine();
    const view = { getStats: jest.fn(async () => ({ displayedPictures: 0, decodedVideo: 0 })) };
    (engine as unknown as { view: { current: unknown } }).view.current = view;
    engine.load({ uri: 'http://server/a.mkv', kind: 'progressive', startPosition: 30 });
    const health = await engine.readHealth();
    expect(health.framesPresented).toBe(0);
    expect(health.readyForDisplay).toBeUndefined();
    engine.release();
  });

  it('tells the parts of a Streamarr HLS session apart by URL (S9b)', () => {
    const base = 'http://server/api/v1/transcode/tok';
    expect(mediaPart(`${base}/audio/1/12.m4s`)).toBe('audio');
    expect(mediaPart(`${base}/audio/1/main.m3u8`)).toBe('audio');
    expect(mediaPart(`${base}/subtitles/5/11.vtt`)).toBe('text');
    expect(mediaPart(`${base}/12.m4s?t=1`)).toBe('segment');
    expect(mediaPart(`${base}/init.mp4`)).toBe('segment');
    expect(mediaPart(`${base}/main.m3u8`)).toBe('other');
    expect(mediaPart('http://server/api/v1/stream/abc')).toBe('other');
    expect(mediaPart(undefined)).toBe('other');
  });

  it('names the audio path only while the picture plays and without a server status (S9b)', () => {
    const audio = {
      errorCodeName: 'ERROR_CODE_IO_NETWORK_CONNECTION_FAILED',
      message: 'x',
      uri: 'http://s/t/audio/1/3.m4s',
    };
    expect(failureReason(audio, true)).toMatch(/^audioRendition:/);
    expect(failureReason(audio, false)).not.toMatch(/^audioRendition:/);
    expect(failureReason({ ...audio, httpStatus: 404 }, true)).not.toMatch(/^audioRendition:/);
    expect(
      failureReason(
        {
          errorCodeName: 'ERROR_CODE_PARSING_CONTAINER_MALFORMED',
          message: 'x',
          uri: 'http://s/t/7.m4s',
        },
        true
      )
    ).toMatch(/^damagedSegment:/);
    // Live on Google TV (S6t): Exo's parser error carries no URI; an HLS source makes it a damaged segment, a file not.
    const parser = {
      errorCodeName: 'ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED',
      message: 'Source error Skipping atom with length > 2147483647 (unsupported).',
    };
    expect(failureReason(parser, true, true)).toMatch(/^damagedSegment:/);
    expect(failureReason(parser, true, false)).not.toMatch(/^damagedSegment:/);
  });
});

describe('Info panel numbers from the native probe (S6v)', () => {
  it('Exo: dropped and presented frames, bandwidth and the decoder name', () => {
    expect(
      toStats({
        framesPresented: 541,
        framesDropped: 3,
        bandwidthBps: 1_800_000,
        decoderName: 'c2.goldfish.h264.decoder',
      })
    ).toEqual({
      droppedFrames: 3,
      totalFrames: 541,
      bandwidth: 1_800_000,
      decoder: 'c2.goldfish.h264.decoder',
    });
  });

  it("AVPlayer: the sampled frame count is no total, so no dropped/total; an old build's map stays empty", () => {
    expect(toStats({ framesPresented: 12, bandwidthBps: 4e8, readyForDisplay: true })).toEqual({
      bandwidth: 4e8,
    });
    expect(toStats({ framesDropped: null, decoderName: null })).toEqual({});
    expect(toStats(null)).toEqual({});
  });
});
