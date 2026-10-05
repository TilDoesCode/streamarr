import { render } from '@testing-library/react-native';
import { createElement } from 'react';

import { loadHls, WebEngine } from '@/player/engines/web-engine.web';
import { classify } from '@/player/recovery/classify';
import { harness, newController, reply } from '@/../jest/player/harness';
import {
  FakeExpoPlayer,
  FakeHls,
  FakeVideoElement,
  FakeVlcView,
} from '@/../jest/player/library-fakes';
import { pending, row } from '@/../jest/player/matrix';
import type { ControllerOptions, PlaybackController } from '@/player/controller';
import type { Playback } from '@/player/playback-api';
import { fakeNetwork, playFor, playing, settle, TICKS } from '@/../jest/player/play';
import { expoPlaying } from '@/../jest/player/native';
import { vlcPlaying } from '@/../jest/player/native-vlc';
import type { EngineHealth } from '@/player/health/types';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());
jest.mock('hls.js', () => jest.requireActual('@/../jest/player/library-fakes').hlsJsModule());
jest.mock('expo-video', () =>
  jest.requireActual('@/../jest/player/library-fakes').expoVideoModule()
);
jest.mock('expo-libvlc-player', () =>
  jest.requireActual('@/../jest/player/library-fakes').vlcModule()
);

beforeEach(() => harness.reset());
afterEach(() => jest.useRealTimers());

/** A playing controller whose engine has a health probe; the clock and counters run per fake second. */
async function probed(over: Partial<Playback> = {}, options: Partial<ControllerOptions> = {}) {
  jest.useFakeTimers();
  harness.features.probe = true;
  return playing(options, over, 0);
}
const seen = (c: PlaybackController, keys: string[]) => () => {
  const key = c.status.hint?.key;
  if (key && keys.at(-1) !== key) keys.push(key);
};
const engineError = (reason: string, status?: number) =>
  harness.engine.emit({ type: 'error', reason, ...(status === undefined ? null : { status }) });
const hdInfo = {
  durationTicks: 600 * TICKS,
  audioTracks: [] as unknown[],
  subtitleTracks: [],
  video: { height: 1080 },
};
const hd = { mediaInfo: hdInfo } as never;

/** The real expo-video engine's error for a failed item (patched fields), replayed into the controller. */
async function nativeFailure(error: Parameters<FakeExpoPlayer['failWith']>[0]) {
  const expo = await expoPlaying();
  expo.player.failWith(error);
  const [event] = expo.of('error');
  expo.engine.release();
  harness.engine.emit(event!);
  return event!;
}
const classified = (event: { reason: string; status?: number }) =>
  classify({ kind: 'engine', engine: 'expo-video', ...event });

/** What the real expo-video engine reports for a native probe answer. */
async function nativeHealth(raw: FakeExpoPlayer['health']): Promise<EngineHealth> {
  const expo = await expoPlaying();
  expo.player.health = raw;
  const health = await expo.engine.readHealth();
  expo.engine.release();
  return health;
}

/** VLC statistics through the real VlcEngine probe. */
async function vlcHealth(stats: Record<string, number>): Promise<EngineHealth> {
  FakeVlcView.stats = stats;
  const vlc = vlcPlaying();
  const health = await vlc.engine.readHealth();
  vlc.engine.release();
  return health;
}

/** Plays `seconds` with a probe whose answer comes from `health(second)` (real engine mapping). */
async function playWith(
  seconds: number,
  health: (second: number) => Promise<EngineHealth> | EngineHealth,
  from = 0
) {
  for (let second = from + 1; second <= from + seconds; second++) {
    harness.engine.setHealth(await health(second));
    harness.engine.time(second);
    await jest.advanceTimersByTimeAsync(1_000);
  }
}

// State matrix layer D (docs/client/player/state-matrix.md § 1): one test per row id.

describe('matrix D — Engine and decoder', () => {
  row(
    'D01',
    'hls.js load errors classify by HTTP status: 404 new start, 503 reload after a pause, none = transport',
    async () => {
      jest.useFakeTimers();
      const hls = { method: 'remux' } as never;
      let c = await playing({}, hls, 40);
      engineError('networkError:levelLoadError', 404);
      await settle();
      expect(harness.server.sent('start')).toHaveLength(2);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
      harness.reset();
      c = await playing({}, hls, 40);
      engineError('networkError:fragLoadError', 503);
      expect(c.status.hint).toMatchObject({ key: 'serverError' });
      await jest.advanceTimersByTimeAsync(5_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await c.stop();
      harness.reset();
      c = await playing({}, hls, 40);
      engineError('networkError:fragLoadError', 0);
      expect(c.status.hint).toMatchObject({ key: 'reconnecting' });
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );
  row(
    'D02',
    'hls.js media errors: recover, swap the audio codec and recover, then hand on to the ladder',
    async () => {
      const engine = new WebEngine();
      (engine as unknown as { attach(video: unknown): void }).attach(new FakeVideoElement());
      await loadHls();
      const reasons: string[] = [];
      engine.subscribe((event) => void (event.type === 'error' && reasons.push(event.reason)));
      engine.load({ uri: 'http://server.test/master.m3u8', kind: 'hls' });
      const hls = FakeHls.last;
      hls.error('mediaError', 'bufferAppendError');
      expect(hls.recoverMediaError).toHaveBeenCalledTimes(1);
      expect(hls.swapAudioCodec).not.toHaveBeenCalled();
      hls.error('mediaError', 'bufferAppendError');
      expect(hls.swapAudioCodec).toHaveBeenCalledTimes(1);
      expect(hls.recoverMediaError).toHaveBeenCalledTimes(2);
      hls.error('mediaError', 'bufferAppendError');
      expect(hls.recoverMediaError).toHaveBeenCalledTimes(2);
      expect(reasons).toEqual(['mediaError:bufferAppendError']);
      expect(classify({ kind: 'engine', engine: 'web', reason: reasons[0]! }).category).toBe('T7');
      engine.release();
    }
  );
  row(
    'D02',
    'hls.js media errors after the engine budget: a codec error reloads, then steps down',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { method: 'remux' } as never, 40);
      engineError('mediaError:bufferAddCodecError');
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started();
      engineError('mediaError:bufferAddCodecError');
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      await c.stop();
    }
  );
  row(
    'D03',
    'hls.js mux/other errors are format errors (reload, then another way); key errors are content',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { method: 'remux' } as never, 40);
      engineError('muxError:fragParsingError');
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started();
      engineError('otherError:internalException');
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      expect(
        classify({ kind: 'engine', engine: 'web', reason: 'keySystemError:keySystemNoKeys' })
      ).toMatchObject({ category: 'T8', code: 'encrypted_media' });
      await c.stop();
    }
  );
  row(
    'D04',
    'hls.js nudges over a stall without waiting/playing: spinner, and it clears once the clock runs',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { method: 'remux' } as never, 40);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(1_500);
      expect(c.status.spinner).toBe(true);
      harness.engine.time(40.5);
      expect(c.status.spinner).toBe(true);
      harness.engine.time(41.2);
      expect(c.status.spinner).toBe(false);
      await c.stop();
    }
  );
  pending('D05', 'MSE QuotaExceededError (bufferFullError)', 'regression test, S3+');
  row(
    'D06',
    'the hls.js chunk does not load: reload, then a new start, then the card with Retry',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { method: 'remux' } as never, 40);
      engineError('hlsjs:load');
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      engineError('hlsjs:load');
      await settle();
      expect(harness.server.sent('start')).toHaveLength(2);
      engineError('hlsjs:load');
      await settle();
      expect(c.failure).toMatchObject({
        code: 'player_load_failed',
        category: 'T11',
        actions: ['retry'],
      });
    }
  );
  row('D07', 'muted autoplay shows "Sound off — tap to unmute" until unmuted', async () => {
    const video = new FakeVideoElement();
    video.autoplay = 'mutedOnly';
    const engine = new WebEngine();
    Object.defineProperty(engine, 'mode', { value: 'native' });
    (engine as unknown as { attach(video: unknown): void }).attach(video);
    const results: string[] = [];
    engine.subscribe((event) => void (event.type === 'autoplay' && results.push(event.result)));
    engine.load({ uri: 'http://server.test/a.mp4', kind: 'progressive' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(results).toEqual(['muted']);
    engine.release();
    const c = await playing({}, {}, 5);
    harness.engine.emit({ type: 'autoplay', result: 'muted' });
    expect(c.status).toEqual({
      spinner: false,
      hint: { key: 'mutedAutoplay' },
      actions: ['unmute'],
    });
    c.unmute();
    expect(harness.engine.setMuted).toHaveBeenLastCalledWith(false);
    expect(c.status.hint).toBeNull();
    await c.stop();
  });
  row('D08', 'blocked autoplay pauses with a big Play action', async () => {
    const video = new FakeVideoElement();
    video.autoplay = 'blocked';
    const engine = new WebEngine();
    Object.defineProperty(engine, 'mode', { value: 'native' });
    (engine as unknown as { attach(video: unknown): void }).attach(video);
    const results: string[] = [];
    engine.subscribe((event) => void (event.type === 'autoplay' && results.push(event.result)));
    engine.load({ uri: 'http://server.test/a.mp4', kind: 'progressive' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(results).toEqual(['blocked']);
    engine.release();
    const c = await playing();
    harness.engine.emit({ type: 'autoplay', result: 'blocked' });
    expect(c.paused).toBe(true);
    expect(c.status).toEqual({
      spinner: false,
      hint: { key: 'autoplayBlocked' },
      actions: ['play'],
    });
    harness.engine.play.mockClear();
    c.setPaused(false);
    expect(harness.engine.play).toHaveBeenCalled();
    expect(c.status.hint).toBeNull();
    await c.stop();
  });
  row(
    'D09',
    'a <video> network error whose URL answers 404 starts anew; a decode error steps down after a reload',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 40);
      engineError('media_error_2', 404);
      await settle();
      expect(harness.server.sent('start')).toHaveLength(2);
      harness.engine.started();
      engineError('PIPELINE_ERROR_DECODE: video decode failed');
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(3);
      await c.stop();
    }
  );
  row(
    'D10',
    'Safari: waiting shows the stall timeline; a silent stall (stalled/suspend only) is caught by the watchdog',
    async () => {
      const c = await probed({}, { nativeEngine: 'web' });
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(4_000);
      expect(c.status).toMatchObject({ spinner: true, hint: { key: 'buffering' } });
      harness.engine.emit({ type: 'buffering', buffering: false });
      expect(c.status.spinner).toBe(false);
      await playFor(3, (second) => ({
        position: second,
        health: { framesPresented: second * 24 },
      }));
      await playFor(8, () => ({ health: { framesPresented: 72 } }), 3);
      expect(c.status.spinner).toBe(true);
      await c.stop();
    }
  );
  row(
    'D11',
    'Exo source errors carry the code name and HTTP status: 404 new start, network → reconnect, cleartext → client card',
    async () => {
      jest.useFakeTimers();
      let c = await playing({}, {}, 0);
      harness.engine.time(40);
      const gone = await nativeFailure({
        message: 'A playback exception has occurred: Source error',
        errorCodeName: 'ERROR_CODE_IO_BAD_HTTP_STATUS',
        httpStatus: 404,
      });
      expect(gone).toMatchObject({
        status: 404,
        reason: expect.stringMatching(/^ERROR_CODE_IO_BAD_HTTP_STATUS: /),
      });
      expect(classified(gone)).toMatchObject({ category: 'T2', code: 'unknown_transcode' });
      await settle();
      expect(harness.server.sent('start')).toHaveLength(2);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
      harness.reset();
      c = await playing({}, {}, 0);
      harness.engine.time(40);
      const offline = await nativeFailure({
        message: 'A playback exception has occurred: Source error',
        errorCodeName: 'ERROR_CODE_IO_NETWORK_CONNECTION_FAILED',
      });
      expect(classified(offline)).toMatchObject({ category: 'T1', code: 'network_unreachable' });
      expect(c.status.hint?.key).toBe('reconnecting');
      expect(
        classified({ reason: 'ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT: Source error' })
      ).toMatchObject({ category: 'T1', code: 'timeout' });
      expect(
        classified({
          reason: 'ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED: Cleartext HTTP traffic not permitted',
        })
      ).toMatchObject({ category: 'T11', code: 'cleartext_not_permitted' });
      await c.stop();
    }
  );
  row(
    'D12',
    'Exo decoder errors: reload once, then the step-down says which format ("This device can\'t play HEVC")',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(40);
      const failure = {
        message: 'A playback exception has occurred: Decoder init failed',
        errorCodeName: 'ERROR_CODE_DECODER_INIT_FAILED',
        mimeType: 'video/hevc',
      };
      expect(classified(await nativeFailure(failure))).toMatchObject({
        category: 'T7',
        code: 'decode_error',
      });
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started();
      await nativeFailure(failure);
      expect(c.status.hint).toMatchObject({ key: 'decoder', params: { format: 'HEVC' } });
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      for (const name of [
        'ERROR_CODE_DECODING_FAILED',
        'ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES',
        'ERROR_CODE_DECODING_FORMAT_UNSUPPORTED',
        'ERROR_CODE_DECODER_QUERY_FAILED',
      ])
        expect(classified({ reason: `${name} [video/av01]: x` })).toMatchObject({
          category: 'T7',
          code: 'decode_error',
        });
      await c.stop();
    }
  );
  row(
    'D13',
    'Exo audio sink errors are their own code ("can\'t play the sound"), with the audio format',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(40);
      const event = await nativeFailure({
        message: 'A playback exception has occurred: AudioTrack init failed',
        errorCodeName: 'ERROR_CODE_AUDIO_TRACK_INIT_FAILED',
        mimeType: 'audio/eac3',
      });
      expect(classified(event)).toMatchObject({ category: 'T7', code: 'audio_decode_error' });
      expect(classified({ reason: 'ERROR_CODE_DECODING_FAILED [audio/true-hd]: x' })).toMatchObject(
        {
          code: 'audio_decode_error',
        }
      );
      expect(classified({ reason: 'ERROR_CODE_AUDIO_TRACK_WRITE_FAILED: x' }).code).toBe(
        'audio_decode_error'
      );
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await c.stop();
    }
  );
  pending(
    'D13',
    'audio fallback /switch (ladder step A, server flag audioFallback) before the step-down',
    'S4d ladder'
  );
  pending('D14', 'Exo BEHIND_LIVE_WINDOW', 'regression test, S3+');
  row(
    'D15',
    'Exo stuck buffering: the engine reports the stall, spinner after 1 s, hint after 4 s, ladder at 15 s',
    async () => {
      jest.useFakeTimers();
      const expo = await expoPlaying();
      expo.player.setStatus('loading');
      expect(expo.of('buffering')).toEqual([{ type: 'buffering', buffering: true }]);
      expect(expo.engine.getSnapshot().state).toBe('buffering');
      expo.engine.release();
      const c = await playing({}, hd, 0);
      harness.engine.time(40);
      expo.replay();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(true);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(c.status.hint).not.toBeNull();
      await jest.advanceTimersByTimeAsync(11_000);
      await settle();
      expect(harness.server.sent('switch').length).toBeGreaterThan(0);
      await c.stop();
    }
  );
  row(
    'D16',
    'Exo plays audio with the video renderer off (track deselected): zero frames → "No picture", reload',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing({}, hd, 0);
      await playWith(6, (second) =>
        nativeHealth({
          framesPresented: 0,
          hasVideoTrack: false,
          hasAudioTrack: true,
          audioProgress: second * 40,
        })
      );
      expect(c.status.hint?.key).toBe('noPicture');
      await playWith(
        4,
        (second) => ({ framesPresented: 0, hasVideoTrack: false, audioProgress: second * 40 }),
        6
      );
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await c.stop();
    }
  );
  row(
    'D17',
    'Exo decoder reclaimed (code name): reload at the position, no step-down',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(33);
      const event = await nativeFailure({
        message: 'A playback exception has occurred: MediaCodec released',
        errorCodeName: 'ERROR_CODE_DECODING_RESOURCES_RECLAIMED',
      });
      expect(classified(event)).toMatchObject({ category: 'T6', code: 'decoder_reclaimed' });
      await jest.advanceTimersByTimeAsync(5_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(33);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );
  row(
    'D18',
    'AVPlayer failures keep domain, code, underlying error and error log: offline T1, HTTP 404 T2, 5xx T6, -12927 T7',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(40);
      const offline = await nativeFailure({
        message: 'The Internet connection appears to be offline.',
        domain: 'NSURLErrorDomain',
        code: -1009,
      });
      expect(offline.reason).toBe(
        'NSURLErrorDomain -1009: The Internet connection appears to be offline.'
      );
      expect(classified(offline)).toMatchObject({ category: 'T1', code: 'network_unreachable' });
      await c.stop();
      const http = (status: number, log: string) =>
        classified({
          reason: `AVFoundationErrorDomain -11800 (CoreMediaErrorDomain -12938) {${log}}: The operation could not be completed`,
          status,
        });
      expect(http(404, 'CoreMediaErrorDomain -12938 HTTP 404: File Not Found')).toMatchObject({
        category: 'T2',
      });
      expect(http(503, 'CoreMediaErrorDomain -12938 HTTP 503: Service Unavailable')).toMatchObject({
        category: 'T6',
      });
      expect(
        classified({
          reason: 'AVFoundationErrorDomain -11800 (CoreMediaErrorDomain -12927): Cannot Decode',
        })
      ).toMatchObject({ category: 'T7', code: 'decode_error' });
      expect(
        classified({ reason: 'NSURLErrorDomain -1001: The request timed out.' }).category
      ).toBe('T1');
      // Seen live (iPhone simulator, a direct-play URL answering 404): no error log, only the codes.
      expect(
        classified({
          reason:
            'NSURLErrorDomain -1100 (NSOSStatusErrorDomain -12938): Failed to load the player item',
        })
      ).toMatchObject({ category: 'T2', code: 'unknown_transcode' });
      expect(classified({ reason: 'NSURLErrorDomain -1202: x' })).toMatchObject({
        code: 'tls_error',
      });
      expect(
        classified({ reason: 'AVFoundationErrorDomain -11819: Cannot Complete Action' })
      ).toMatchObject({
        code: 'decoder_reclaimed',
      });
    }
  );
  row(
    'D19',
    'AVPlayer waiting to play: stall timeline; the access-log bitrate names a slow connection',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const expo = await expoPlaying();
      expo.player.setStatus('loading');
      expo.player.health = { bandwidthBps: 1_500_000, readyForDisplay: true };
      const health = await expo.engine.readHealth();
      expo.engine.release();
      const c = await playing({}, { mediaInfo: { ...hdInfo, bitrateKbps: 6_000 } } as never, 0);
      harness.engine.time(40);
      harness.engine.setHealth(health);
      expo.replay();
      await jest.advanceTimersByTimeAsync(4_000);
      expect(c.status.hint).toEqual({ key: 'slowNet', params: { measured: 1.5, needed: 6 } });
      await c.stop();
    }
  );
  row(
    'D20',
    'AVPlayer black while the clock runs (not ready for display, no new pixel buffer): "No picture", reload',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing({}, hd, 0);
      await playWith(6, () =>
        nativeHealth({ readyForDisplay: false, framesPresented: 0, hasVideoTrack: true })
      );
      expect(c.status.hint?.key).toBe('noPicture');
      await playWith(4, () => ({ readyForDisplay: false, framesPresented: 0 }), 6);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await c.stop();
    }
  );
  row(
    'D21',
    'AVPlayer picture without any enabled audio track (heuristic): "No sound", reload',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const withAudio = {
        mediaInfo: { ...hdInfo, audioTracks: [{ index: 1 }] },
      } as never;
      const c = await playing({}, withAudio, 0);
      await playWith(6, (second) =>
        nativeHealth({
          framesPresented: second,
          hasVideoTrack: true,
          hasAudioTrack: false,
          audioProgress: 0,
        })
      );
      expect(c.status.hint?.key).toBe('noAudio');
      await playWith(4, (second) => ({ framesPresented: second, audioProgress: 0 }), 6);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      // With an audio track the probe has no audio counter: never guessed.
      await expect(
        nativeHealth({ framesPresented: 3, hasAudioTrack: true })
      ).resolves.not.toHaveProperty('audioProgress');
      await c.stop();
    }
  );
  row(
    'D22',
    'VLC EncounteredError: "VLC could not play this file" (vlc_error), reload, then another way',
    async () => {
      jest.useFakeTimers();
      const vlc = vlcPlaying();
      vlc.internals.view.current = FakeVlcView.ref;
      await render(createElement(vlc.engine.Surface));
      FakeVlcView.call('onEncounteredError', { message: "Your input can't be opened" });
      const [event] = vlc.of('error');
      expect(classify({ kind: 'engine', engine: 'vlc', ...event! })).toMatchObject({
        category: 'T7',
        code: 'vlc_error',
      });
      vlc.engine.release();
      const c = await playing({}, { engine: 'vlc' } as never, 0);
      harness.engine.time(20);
      harness.engine.emit(event!);
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started();
      harness.engine.emit(event!);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      await c.stop();
    }
  );
  row(
    'D23',
    'VLC decodes but never displays (no displayedPictures > 0 gate): "No picture", reload, then another way',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing({}, { mediaInfo: hdInfo, engine: 'vlc' } as never, 0);
      await playWith(6, (second) =>
        vlcHealth({
          displayedPictures: 0,
          decodedVideo: second * 24,
          decodedAudio: 10,
          playedAbuffers: second * 10,
        })
      );
      expect(c.status.hint?.key).toBe('noPicture');
      await playWith(4, (second) => ({ framesPresented: 0, audioProgress: 100 + second }), 6);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await c.stop();
    }
  );
  row(
    'D24',
    'VLC frozen picture with a running clock (Android and Apple stats): "The picture is stuck. Reloading at …"',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing({}, { mediaInfo: hdInfo, engine: 'vlc' } as never, 0);
      const pictures = (second: number) => Math.min(second, 4) * 24;
      await playWith(9, (second) =>
        vlcHealth({
          displayedPictures: pictures(second),
          decodedVideo: second * 24,
          decodedAudio: 10,
          playedAbuffers: second * 10,
        })
      );
      expect(c.status.hint).toMatchObject({ key: 'recovering', params: { time: '0:04' } });
      await playWith(3, (second) => ({ framesPresented: 96, audioProgress: 200 + second }), 9);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(4);
      await c.stop();
    }
  );
  row('D25', 'VLC no audio (audio decoded, no buffer played): "No sound", reload', async () => {
    jest.useFakeTimers();
    harness.features.probe = true;
    const withAudio = {
      engine: 'vlc',
      mediaInfo: { ...hdInfo, audioTracks: [{ index: 1 }] },
    } as never;
    const c = await playing({}, withAudio, 0);
    await playWith(6, (second) =>
      vlcHealth({
        displayedPictures: second * 24,
        decodedVideo: second * 24,
        decodedAudio: second * 40,
        playedAbuffers: 0,
      })
    );
    expect(c.status.hint?.key).toBe('noAudio');
    await playWith(4, (second) => ({ framesPresented: (6 + second) * 24, audioProgress: 0 }), 6);
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    await c.stop();
  });
  row(
    'D26',
    'VLC stopping before the duration reloads once at the position, then explains',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        {
          engine: 'vlc',
          mediaInfo: { durationTicks: 3600 * TICKS, audioTracks: [], subtitleTracks: [] },
        } as never,
        0
      );
      expect(harness.engine.kind).toBe('vlc');
      harness.engine.time(1200, 3600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(harness.engine.source?.startPosition).toBe(1200);
      expect(c.status.hint?.key).toBe('reloading');
      harness.engine.started(3600);
      // A short file ends at the same place again (within 3 s).
      harness.engine.time(1201, 3600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.phase).toBe('failed');
      expect(c.failure).toMatchObject({
        code: 'end_of_stream',
        category: 'T8',
        hint: { key: 'endedEarly', params: { time: '20:01', missing: '39:59' } },
        actions: ['otherVersion'],
      });
      await c.stop();
    }
  );
  row(
    'D27',
    'VLC dialogs are dismissed and classified: certificate → TLS card path, other questions → another way to play',
    async () => {
      const vlc = vlcPlaying();
      await render(createElement(vlc.engine.Surface));
      vlc.internals.view.current = FakeVlcView.ref;
      FakeVlcView.ref.dismiss.mockClear();
      FakeVlcView.call('onDialogDisplay', {
        title: 'Insecure site',
        text: 'This website certificate cannot be verified',
        type: 'question',
        cancelText: 'Cancel',
        action1Text: 'View certificate',
        action2Text: null,
      });
      expect(FakeVlcView.ref.dismiss).toHaveBeenCalledTimes(1);
      const [tls] = vlc.of('error');
      expect(classify({ kind: 'engine', engine: 'vlc', ...tls! })).toMatchObject({
        category: 'T1',
        code: 'tls_error',
      });
      FakeVlcView.call('onDialogDisplay', {
        title: 'Codec not supported',
        text: 'VLC could not decode the format "dts "',
        type: 'error',
        cancelText: null,
        action1Text: null,
        action2Text: null,
      });
      expect(classify({ kind: 'engine', engine: 'vlc', ...vlc.of('error')[1]! })).toMatchObject({
        category: 'T7',
        code: 'vlc_dialog',
      });
      expect(vlc.engine.getSnapshot().state).toBe('error');
      vlc.engine.release();
    }
  );
  pending('D28', 'VLC stop hangs (ANR risk on release)', 'regression test, S3+');
  row(
    'D29',
    'a seek into unbuffered media: spinner at once, hint, then a reload at the target',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 30);
      c.seekTo(300);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status).toMatchObject({ spinner: true, hint: null });
      await jest.advanceTimersByTimeAsync(8_000);
      expect(c.status.hint?.key).toBe('buffering');
      await jest.advanceTimersByTimeAsync(12_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(300);
      await c.stop();
    }
  );
  row('D30', 'a seek past the end is clamped to one second before it', async () => {
    const controller = newController();
    await controller.start();
    harness.engine.started(600);
    controller.seekTo(900);
    expect(harness.engine.seek).toHaveBeenLastCalledWith(599);
    await controller.stop();
  });
  pending('D31', 'Rapid seeks / scrubbing on HLS transcode (each far seek restarts ffmpeg)', 'S8');
  pending('D32', 'In-session audio switch never confirms', 'S4');
  row(
    'D33',
    'black picture with a running clock: "No picture", reload at the position, then another way to play',
    async () => {
      const c = await probed();
      const keys: string[] = [];
      const black = (second: number) => ({
        position: second,
        health: { framesPresented: 0, audioProgress: second * 1000 },
      });
      await playFor(6, black, 0, seen(c, keys));
      expect(c.status).toMatchObject({ spinner: true, hint: { key: 'noPicture' } });
      await playFor(3, black, 6, seen(c, keys));
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(2);
      harness.engine.started();
      await playFor(
        10,
        (second) => ({
          position: second,
          health: { framesPresented: 0, audioProgress: second * 1000 },
        }),
        2
      );
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      expect(keys).toEqual(expect.arrayContaining(['noPicture', 'reloading']));
      await c.stop();
    }
  );
  row(
    'D34',
    'frozen picture with a running clock: hint with the time, reload where the picture stopped',
    async () => {
      const c = await probed();
      const frozen = (second: number) => ({
        position: second,
        health: { framesPresented: Math.min(second, 5) * 24, audioProgress: second * 1000 },
      });
      await playFor(9, frozen);
      expect(c.status).toMatchObject({
        spinner: true,
        hint: { key: 'recovering', params: { time: '0:05' } },
      });
      await playFor(3, frozen, 9);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(5);
      await c.stop();
    }
  );
  row(
    'D35',
    'time events stop while the engine clock runs: no stall, the engine clock is the position',
    async () => {
      const c = await probed();
      await playFor(3, (second) => ({
        position: second,
        health: { framesPresented: second * 24, nativePosition: second },
      }));
      await playFor(
        8,
        (second) => ({ health: { framesPresented: second * 24, nativePosition: second } }),
        3
      );
      expect(c.status.spinner).toBe(false);
      expect(c.resumePosition).toBe(11);
      await c.stop();
      expect(harness.server.sent('progress').at(-1)?.body).toMatchObject({
        positionTicks: 11 * TICKS,
      });
    }
  );
  row('D36', 'no audio with a running picture: "No sound", then a reload', async () => {
    const c = await probed();
    const silent = (second: number) => ({
      position: second,
      health: { framesPresented: second * 24, audioProgress: Math.min(second, 3) * 1000 },
    });
    await playFor(7, silent);
    expect(c.status).toMatchObject({ spinner: false, hint: { key: 'noAudio' } });
    await playFor(4, silent, 7);
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    await c.stop();
  });
  pending('D37', 'Audio/video drift', 'S5');
  row(
    'D38',
    'heavy frame drops: "This device can\'t keep up" with Lower quality, above 60 % the quality goes down',
    async () => {
      const c = await probed(hd);
      const drops = (share: number) => (second: number) => ({
        position: second,
        health: {
          framesPresented: Math.round(second * 24 * (1 - share)),
          framesDropped: Math.round(second * 24 * share),
          audioProgress: second * 1000,
        },
      });
      await playFor(15, drops(0.4));
      expect(c.status).toMatchObject({
        hint: { key: 'deviceSlow', params: { percent: 40 } },
        actions: ['lowerQuality'],
      });
      expect(harness.server.sent('switch')).toHaveLength(0);
      await playFor(15, drops(0.7), 15);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({
        preferences: expect.objectContaining({ maxHeight: 720 }),
      });
      await c.stop();
    }
  );
  row(
    'D39',
    'the engine never reaches a first frame: hint by 4 s, reload at 20 s, then another way to play',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('start', reply.ok(harness.server.playback()));
      const c = newController();
      await c.start();
      await jest.advanceTimersByTimeAsync(4_000);
      expect(c.status.hint?.key).toBe('startSlow');
      await jest.advanceTimersByTimeAsync(16_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(20_000);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      await c.stop();
    }
  );
  row(
    'D40',
    'a rejected replaceAsync puts the engine in error and classifies like any engine error',
    async () => {
      const expo = await expoPlaying();
      expo.engine.load({ uri: 'http://server/b.m3u8', kind: 'hls' });
      FakeExpoPlayer.last.loaded(new Error('Source error: Response code: 410'));
      await Promise.resolve();
      await Promise.resolve();
      const [event] = expo.of('error');
      expect(expo.engine.getSnapshot().state).toBe('error');
      expect(classified(event!)).toMatchObject({ category: 'T2', code: 'session_closed' });
      expo.engine.release();
    }
  );
  row(
    'D41',
    'engine errors reload once, then step down once; an error during the switch starts nothing more',
    async () => {
      jest.useFakeTimers();
      const server = harness.server;
      const controller = await playing({}, {}, 42);
      server.answer('switch', (request) =>
        reply.ok(server.playback({ playbackId: request.playbackId, method: 'remux', revision: 1 }))
      );
      harness.engine.fail('first');
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(42);
      harness.engine.fail('again');
      expect(controller.phase).toBe('switching');
      harness.engine.fail('during the switch');
      await settle();
      expect(server.sent('switch')).toHaveLength(1);
      expect(server.sent('switch')[0]?.body).toMatchObject({
        stepDown: true,
        positionTicks: 42 * TICKS,
      });
      expect(controller.phase).toBe('playing');
      expect(controller.notice?.kind).toBe('stepDown');
      await controller.stop();
    }
  );
});

describe('matrix D — code review S1-S4 (S4b)', () => {
  const decode = 'MediaCodecVideoRenderer error: decoder init failed';
  const minutes = (count: number) => jest.advanceTimersByTimeAsync(count * 60_000);

  row(
    'D39',
    'a reloaded source that never shows a picture and never errors ends on a card, never an endless spinner (review P1)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      harness.engine.fail(decode);
      await settle();
      expect(harness.engine.sources).toHaveLength(2);
      await minutes(10);
      expect(c.phase).toBe('failed');
      expect(c.status.spinner).toBe(false);
      expect(c.failure?.tried?.length).toBeGreaterThan(1);
    }
  );

  row(
    'D39',
    'a reload that stays black while the viewer has paused still has a budget; a ready paused source counts as loaded',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      c.setPaused(true);
      harness.engine.fail(decode);
      await settle();
      harness.engine.state('paused');
      expect(c.status).toEqual({ spinner: false, hint: null, actions: [] });
      harness.engine.fail(decode);
      await settle();
      await minutes(10);
      expect(c.phase).toBe('failed');
    }
  );

  row(
    'D41',
    'a second step-down on the same revision is no endless "No picture": the ladder goes on or ends (review P2)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      harness.engine.fail(decode);
      await settle();
      harness.server.answer('switch', reply.error(500, 'server_error'));
      harness.engine.fail(decode);
      await settle();
      await jest.advanceTimersByTimeAsync(6_000);
      harness.engine.fail(decode);
      await settle();
      await minutes(10);
      expect(c.phase).toBe('failed');
      expect(c.status.spinner).toBe(false);
    }
  );

  row(
    'D41',
    'a step-down that cannot run (a switch is in progress) gives up instead of waiting forever',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      harness.server.answer('switch', () =>
        reply.ok(
          harness.server.playback({
            playbackId: c.playback!.playbackId!,
            state: 'starting',
            revision: 1,
            pollAfterMs: 60_000,
          } as never)
        )
      );
      void c.setQuality(720);
      await settle();
      expect(c.phase).toBe('switching');
      expect(await c.stepDown('decode_error')).toBe(false);
      await c.stop();
    }
  );

  row(
    'D26',
    'VLC stopping while offline is a lost connection, not a short file (review 12)',
    async () => {
      jest.useFakeTimers();
      const network = fakeNetwork();
      const c = await playing(
        { network },
        {
          engine: 'vlc',
          mediaInfo: { durationTicks: 3600 * TICKS, audioTracks: [], subtitleTracks: [] },
        } as never,
        0
      );
      harness.engine.time(2460, 3600);
      network.set(false);
      harness.engine.emit({ type: 'ended' });
      await settle();
      // libVLC reports the dropped connection again: still no "file ends" card.
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.failure).toBeNull();
      expect(c.status.hint?.key).toBe('offline');
      network.set(true);
      await settle();
      expect(harness.engine.source?.startPosition).toBe(2460);
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );

  row(
    'D26',
    'VLC stopping again at another position is a connection that keeps breaking, not "the file ends at"',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        {
          engine: 'vlc',
          mediaInfo: { durationTicks: 3600 * TICKS, audioTracks: [], subtitleTracks: [] },
        } as never,
        0
      );
      harness.engine.time(1200, 3600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      harness.engine.started(3600);
      harness.engine.time(1250, 3600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.failure).toBeNull();
      expect(c.status.hint?.key).toBe('reconnecting');
      await jest.advanceTimersByTimeAsync(2_000);
      expect(harness.engine.source?.startPosition).toBe(1250);
      await c.stop();
    }
  );

  row(
    'D07',
    'muted autoplay: the overlay speaker button (controller.setMuted) clears the hint too (review 8)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.emit({ type: 'autoplay', result: 'muted' });
      expect(c.muted).toBe(true);
      expect(c.status.hint?.key).toBe('mutedAutoplay');
      c.setMuted(false);
      expect(harness.engine.setMuted).toHaveBeenLastCalledWith(false);
      expect(c.status.hint).toBeNull();
      c.setMuted(true);
      expect(c.status.hint).toBeNull();
      await c.stop();
    }
  );

  row(
    'D08',
    'blocked autoplay that starts anyway (media key, system controls) clears the hint and the pause (review P13)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.emit({ type: 'autoplay', result: 'blocked' });
      expect(c.status.hint?.key).toBe('autoplayBlocked');
      harness.engine.time(5);
      harness.engine.time(10);
      expect(c.paused).toBe(false);
      expect(c.status.hint).toBeNull();
      await c.stop();
    }
  );
});

describe('matrix D — hls.js media errors far apart (review 18)', () => {
  row(
    'D02',
    'a media error every 35 s recovers in hls.js six times, then the ladder takes over',
    async () => {
      jest.useFakeTimers();
      const engine = new WebEngine();
      (engine as unknown as { attach(video: unknown): void }).attach(new FakeVideoElement());
      await loadHls();
      const reasons: string[] = [];
      engine.subscribe((event) => void (event.type === 'error' && reasons.push(event.reason)));
      engine.load({ uri: 'http://server.test/master.m3u8', kind: 'hls' });
      const hls = FakeHls.last;
      for (let glitch = 0; glitch < 6; glitch += 1) {
        hls.error('mediaError', 'bufferAppendError');
        await jest.advanceTimersByTimeAsync(35_000);
      }
      expect(hls.recoverMediaError).toHaveBeenCalledTimes(6);
      expect(reasons).toEqual([]);
      hls.error('mediaError', 'bufferAppendError');
      expect(reasons).toEqual(['mediaError:bufferAppendError']);
      engine.release();
    }
  );
});
