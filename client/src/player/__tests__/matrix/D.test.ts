import { render } from '@testing-library/react-native';
import { createElement } from 'react';
import { AppState, Platform } from 'react-native';

import type { EngineEvent } from '@/player/engines';
import { loadHls, WebEngine } from '@/player/engines/web-engine.web';
import { classify } from '@/player/recovery/classify';
import { VlcEngine } from '@/player/engines/vlc-engine';
import { noticeText, stepDownReasonKey } from '@/player/overlay-labels';
import { Incident, nextStep } from '@/player/recovery/ladder';
import { SYSTEM_PAUSE_MS } from '@/player/recovery/budgets';
import { AUDIO_SWITCH_TIMEOUT_MS } from '@/player/controller';
import { describeError } from '@/api/error-text';
import { cardButtons } from '@/screens/player/card-actions';
import i18n from '@/i18n';
import { harness, newController, reply } from '@/../jest/player/harness';
import {
  FakeExpoPlayer,
  FakeHls,
  FakeVideoElement,
  FakeVlcView,
} from '@/../jest/player/library-fakes';
import { row } from '@/../jest/player/matrix';
import type { ControllerOptions, PlaybackController } from '@/player/controller';
import type { Playback } from '@/player/playback-api';
import {
  fakeNetwork,
  playFor,
  playing,
  playOn,
  settle,
  starts,
  TICKS,
} from '@/../jest/player/play';
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
      harness.engine.time(harness.engine.getSnapshot().position + 0.5);
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
      globalThis.fetch = jest.fn(async () => ({ status: 206 })) as unknown as typeof fetch;
      FakeVlcView.call('onEncounteredError', { message: "Your input can't be opened" });
      await jest.advanceTimersByTimeAsync(0);
      const [event] = vlc.of('error');
      expect(event).not.toHaveProperty('status');
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
      globalThis.fetch = jest.fn(async () => ({ status: 206 })) as unknown as typeof fetch;
      FakeVlcView.call('onDialogDisplay', {
        title: 'Codec not supported',
        text: 'VLC could not decode the format "dts "',
        type: 'error',
        cancelText: null,
        action1Text: null,
        action2Text: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(classify({ kind: 'engine', engine: 'vlc', ...vlc.of('error')[1]! })).toMatchObject({
        category: 'T7',
        code: 'vlc_dialog',
      });
      expect(vlc.engine.getSnapshot().state).toBe('error');
      vlc.engine.release();
    }
  );
  describe('S6x: libVLC names no HTTP status, the engine asks the server', () => {
    const notFound = {
      title: "Your input can't be opened",
      text: 'VLC is unable to open the MRL',
      type: 'error',
      cancelText: null,
      action1Text: null,
      action2Text: null,
    };
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    row(
      'D22',
      'a direct source answering 401 or 403 (V2 turn 2, GTV direct_status 401): the error carries the status, the attempt reads unauthorized, never unknown_stream',
      async () => {
        for (const [status, code] of [
          [401, 'unauthorized'],
          [403, 'unknown_stream'],
        ] as const) {
          globalThis.fetch = jest.fn(async () => ({ status })) as unknown as typeof fetch;
          const vlc = vlcPlaying();
          await render(createElement(vlc.engine.Surface));
          vlc.internals.view.current = FakeVlcView.ref;
          FakeVlcView.call('onEncounteredError', { message: 'Player encountered an error' });
          await flush();
          expect(vlc.of('error')).toEqual([
            { type: 'error', reason: 'Player encountered an error', status },
          ]);
          expect(classify({ kind: 'engine', engine: 'vlc', ...vlc.of('error')[0]! })).toMatchObject(
            {
              category: 'T2',
              code,
            }
          );
        }
      }
    );

    row(
      'D22',
      'a direct source answering 404: the dialog and the error that follows carry status 404 (one HEAD), and the stop is no end',
      async () => {
        const head = jest.fn(async () => ({ status: 404 }));
        globalThis.fetch = head as unknown as typeof fetch;
        const vlc = vlcPlaying();
        await render(createElement(vlc.engine.Surface));
        vlc.internals.view.current = FakeVlcView.ref;
        FakeVlcView.call('onDialogDisplay', notFound);
        expect(vlc.engine.getSnapshot().state).toBe('error');
        FakeVlcView.call('onEncounteredError', { message: 'Player encountered an error' });
        FakeVlcView.call('onStopped');
        await flush();
        expect(head).toHaveBeenCalledTimes(1);
        expect(head).toHaveBeenCalledWith(
          'http://server/media.mkv',
          expect.objectContaining({ method: 'HEAD' })
        );
        expect(vlc.of('error')).toEqual([
          {
            type: 'error',
            reason: "vlc_dialog error: Your input can't be opened VLC is unable to open the MRL",
            status: 404,
          },
          { type: 'error', reason: 'Player encountered an error', status: 404 },
        ]);
        expect(vlc.of('ended')).toEqual([]);
        expect(classify({ kind: 'engine', engine: 'vlc', ...vlc.of('error')[1]! })).toMatchObject({
          category: 'T2',
        });
        // The next load asks again: another version that answers is not "missing".
        globalThis.fetch = jest.fn(async () => ({ status: 206 })) as unknown as typeof fetch;
        vlc.engine.load({ uri: 'http://server/other.mkv', kind: 'progressive' });
        FakeVlcView.call('onEncounteredError', { message: 'Player encountered an error' });
        await flush();
        expect(vlc.of('error').at(-1)).toEqual({
          type: 'error',
          reason: 'Player encountered an error',
        });
        vlc.engine.release();
      }
    );

    row(
      'D22',
      'no answer, a fine answer or an HLS source add no status; an answer for the previous load is dropped',
      async () => {
        globalThis.fetch = jest.fn(async () => {
          throw new TypeError('Network request failed');
        }) as unknown as typeof fetch;
        const vlc = vlcPlaying();
        await render(createElement(vlc.engine.Surface));
        FakeVlcView.call('onEncounteredError', { message: 'Player encountered an error' });
        await flush();
        expect(vlc.of('error')).toEqual([{ type: 'error', reason: 'Player encountered an error' }]);

        let answer: (value: { status: number }) => void = () => undefined;
        const head = jest.fn(() => new Promise((resolve) => (answer = resolve)));
        globalThis.fetch = head as unknown as typeof fetch;
        vlc.engine.load({ uri: 'http://server/other.mkv', kind: 'progressive' });
        FakeVlcView.call('onDialogDisplay', notFound);
        vlc.engine.load({ uri: 'http://server/third.mkv', kind: 'progressive' });
        answer({ status: 404 });
        await flush();
        expect(vlc.of('error')).toHaveLength(1);

        head.mockClear();
        vlc.engine.load({ uri: 'http://server/master.m3u8', kind: 'hls' });
        FakeVlcView.call('onDialogDisplay', notFound);
        expect(head).not.toHaveBeenCalled();
        expect(vlc.of('error').at(-1)).not.toHaveProperty('status');
        vlc.engine.release();
      }
    );
  });

  row(
    'D28',
    'a libVLC stop that never reports Stopped releases after 3 s; a reported stop releases at once',
    async () => {
      jest.useFakeTimers();
      FakeVlcView.reset();
      const hung = vlcPlaying();
      await render(createElement(hung.engine.Surface));
      let released = false;
      void hung.engine.shutdown().then(() => (released = true));
      await jest.advanceTimersByTimeAsync(2_900);
      expect(released).toBe(false);
      await jest.advanceTimersByTimeAsync(200);
      expect(released).toBe(true);
      hung.engine.release();

      FakeVlcView.reset();
      const quick = vlcPlaying();
      await render(createElement(quick.engine.Surface));
      released = false;
      void quick.engine.shutdown().then(() => (released = true));
      FakeVlcView.call('onStopped');
      await settle();
      expect(released).toBe(true);
      quick.engine.release();
    }
  );
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

describe('matrix D — audio conversion, Retry-After, seek debounce (S4c, S8)', () => {
  const audioSink = 'Source error: AudioSink$InitializationException: AudioTrack init failed 0';

  row(
    'D13',
    'an audio output/decoder failure: the server converts the audio (no reload first), with a notice',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { method: 'remux' } as never, 200);
      harness.server.answer('switch', () => {
        expect(c.status.hint?.key).toBe('convertingAudio');
        return reply.ok(
          harness.server.playback({
            playbackId: c.playback!.playbackId!,
            method: 'remux',
            audioFallback: true,
            revision: 1,
          } as never)
        );
      });
      harness.engine.fail(audioSink);
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.server.sent('switch')[0]?.body).toMatchObject({
        audioFallback: true,
        positionTicks: 200 * TICKS,
      });
      expect(harness.server.sent('switch')[0]?.body).not.toHaveProperty('stepDown');
      expect(c.notice?.kind).toBe('audioFallback');
      expect(c.playback?.audioFallback).toBe(true);
      await c.stop();
    }
  );

  row(
    'D13',
    'still failing with converted audio: one reload, then another way to play; the conversion is asked once',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { method: 'remux' } as never, 200);
      for (let round = 0; round < 3; round += 1) {
        harness.engine.fail(audioSink);
        await settle();
        harness.engine.started();
      }
      const bodies = harness.server.sent('switch').map((request) => request.body);
      expect(bodies.filter((body) => body?.audioFallback)).toHaveLength(1);
      expect(bodies.at(-1)).toMatchObject({ stepDown: true });
      expect(harness.engine.load).toHaveBeenCalledTimes(4);
      await c.stop();
    }
  );

  row('D13', 'a playback that already converts its audio skips step A', async () => {
    jest.useFakeTimers();
    const c = await playing({}, { method: 'remux', audioFallback: true } as never, 10);
    harness.engine.fail(audioSink);
    await settle();
    expect(harness.server.sent('switch')).toHaveLength(0);
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    await c.stop();
  });

  row(
    'D13',
    'the conversion is part of the viewing: a new start after it converts again',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { method: 'remux' } as never, 200);
      harness.engine.fail(audioSink);
      await settle();
      harness.engine.started();
      const before = c.playback!.playbackId;
      harness.engine.fail('Source error: InvalidResponseCodeException: Response code: 404');
      await settle();
      expect(c.playback!.playbackId).not.toBe(before);
      const last = harness.server.sent('switch').at(-1);
      expect(last).toMatchObject({
        playbackId: c.playback!.playbackId,
        body: { audioFallback: true },
      });
      expect(c.playback?.audioFallback).toBe(true);
      await c.stop();
    }
  );

  row(
    'D02',
    'hls.js: a codec error of the audio buffer reaches the ladder as an audio failure',
    async () => {
      const engine = new WebEngine();
      (engine as unknown as { attach(video: unknown): void }).attach(new FakeVideoElement());
      await loadHls();
      const reasons: string[] = [];
      engine.subscribe((event) => void (event.type === 'error' && reasons.push(event.reason)));
      engine.load({ uri: 'http://server.test/master.m3u8', kind: 'hls' });
      const hls = FakeHls.last;
      for (let glitch = 0; glitch < 3; glitch += 1)
        hls.error('mediaError', 'bufferAddCodecError', { sourceBufferName: 'audio' });
      expect(reasons).toEqual(['mediaError:bufferAddCodecError:audio']);
      expect(classify({ kind: 'engine', engine: 'web', reason: reasons[0]! })).toMatchObject({
        category: 'T7',
        code: 'audio_decode_error',
      });
      hls.error('mediaError', 'bufferAddCodecError', { sourceBufferName: 'video' });
      engine.release();
    }
  );

  row(
    'D01',
    'hls.js: a fatal 503 carries its status, never a guessed Retry-After; the ladder waits its own 5 s',
    async () => {
      jest.useFakeTimers();
      const engine = new WebEngine();
      (engine as unknown as { attach(video: unknown): void }).attach(new FakeVideoElement());
      await loadHls();
      const events: unknown[] = [];
      engine.subscribe((event) => void (event.type === 'error' && events.push(event)));
      engine.load({ uri: 'http://server.test/master.m3u8', kind: 'hls' });
      FakeHls.last.error('networkError', 'fragLoadError', { status: 503, retryAfter: 7 });
      expect(events).toEqual([
        { type: 'error', reason: 'networkError:fragLoadError', status: 503 },
      ]);
      engine.release();
    }
  );

  row(
    'D02',
    'a corrupt fragment that hls.js would fetch again at once: at most three attempts with backoff, then the ladder (B13b)',
    async () => {
      jest.useFakeTimers();
      const engine = new WebEngine();
      (engine as unknown as { attach(video: unknown): void }).attach(new FakeVideoElement());
      await loadHls();
      const events: EngineEvent[] = [];
      engine.subscribe((event) => void events.push(event));
      engine.load({ uri: 'http://server.test/master.m3u8', kind: 'hls' });
      const hls = FakeHls.last;
      // hls.js on a fragment that does not parse: it fetches the same segment again right away while it loads.
      const fetches: number[] = [];
      const fetchSegment = () => {
        if (!hls.loading) return;
        fetches.push(Date.now());
        hls.error('mediaError', 'fragParsingError', {
          fatal: false,
          frag: { type: 'main', sn: 6, level: 0 },
        });
        setTimeout(fetchSegment, 1);
      };
      hls.startLoad.mockImplementation(() => {
        hls.loading = true;
        setTimeout(fetchSegment, 0);
      });
      const started = Date.now();
      fetchSegment();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(fetches).toHaveLength(3);
      const gaps = fetches.slice(1).map((at, index) => at - fetches[index]!);
      expect(fetches[0]! - started).toBe(0);
      // 1 s, then 2 s between the attempts (a few ms of fake-timer granularity aside), never a tight loop.
      expect(gaps.map((gap) => Math.round(gap / 100) * 100)).toEqual([1_000, 2_000]);
      expect(hls.loading).toBe(false);
      expect(events.filter((event) => event.type === 'error')).toEqual([
        { type: 'error', reason: 'mediaError:fragParsingError' },
      ]);
      engine.release();
    }
  );

  row(
    'D31',
    'quick seeks on a transcode become one seek after 300 ms; the target shows at once',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { method: 'transcode' } as never, 100);
      c.seekBy(30);
      c.seekBy(30);
      await jest.advanceTimersByTimeAsync(200);
      c.seekBy(30);
      expect(c.position).toBe(190);
      expect(harness.engine.seek).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(299);
      expect(harness.engine.seek).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(harness.engine.seek.mock.calls).toEqual([[190]]);
      await c.stop();
    }
  );

  row('D31', 'a remux or direct play seeks at once', async () => {
    jest.useFakeTimers();
    const c = await playing({}, { method: 'remux' } as never, 100);
    c.seekBy(30);
    c.seekBy(30);
    expect(harness.engine.seek.mock.calls).toEqual([[130], [160]]);
    await c.stop();
  });
});

describe('matrix D — code review S5 + S4b (S4d)', () => {
  const decode = 'MediaCodecVideoRenderer error: decoder init failed';
  const keysOf = (c: PlaybackController, keys: string[]) => () => {
    const key = c.status.hint?.key;
    if (key && keys.at(-1) !== key) keys.push(key);
  };

  row(
    'D33',
    'a pure-black stretch reached by a seek, with frames and sound running, is content: no hint, no reload (review B1)',
    async () => {
      const c = await probed();
      await playFor(20, (second) => ({
        position: second,
        health: { framesPresented: second * 24, audioProgress: second * 1000, luma: 90 },
      }));
      c.seekTo(1000);
      const keys: string[] = [];
      await playFor(
        35,
        (second) => ({
          position: 1000 + second,
          health: {
            framesPresented: 480 + second * 24,
            audioProgress: 20_000 + second * 1000,
            luma: 0,
          },
        }),
        0,
        keysOf(c, keys)
      );
      expect(keys).toEqual([]);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      await c.stop();
    }
  );

  row(
    'D33',
    'an audio-only file (the server says no video) never gets "No picture" (review R3)',
    async () => {
      const info = {
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: [{ index: 1, selected: true, deliveredAs: 'original' }],
          subtitleTracks: [],
          video: null,
        },
      } as never;
      const c = await probed(info);
      const keys: string[] = [];
      await playFor(
        12,
        (second) => ({
          position: second,
          health: { framesPresented: 0, audioProgress: second * 1000 },
        }),
        0,
        keysOf(c, keys)
      );
      expect(keys).toEqual([]);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      await c.stop();
    }
  );

  row(
    'D34',
    'the video track ending a few seconds before the audio ends the title, no reload at the end (review X1)',
    async () => {
      const c = await probed();
      await playFor(12, (second) => ({
        position: 580 + second,
        health: { framesPresented: second * 24, audioProgress: second * 1000 },
      }));
      await playFor(
        8,
        (second) => ({
          position: 580 + second,
          health: { framesPresented: 12 * 24, audioProgress: second * 1000 },
        }),
        12
      );
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(c.ended).toBe(true);
      await c.stop();
    }
  );

  row(
    'D35',
    'an engine without a probe (native until S6) still gets the clock rule: a frozen clock shows the stall timeline (review R6)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      await jest.advanceTimersByTimeAsync(6_000);
      expect(c.status.spinner).toBe(false);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(c.status.spinner).toBe(true);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(c.status.hint).toMatchObject({ key: 'buffering' });
      await c.stop();
    }
  );

  row(
    'D12',
    'the same decoder failure every 2.5 minutes: the third time goes straight to another way to play (review R5)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      for (let round = 0; round < 3; round += 1) {
        harness.engine.fail(decode);
        await settle();
        harness.engine.started();
        harness.engine.time(100 + round * 150 + 1);
        await playOn(150);
      }
      const switches = harness.server.sent('switch');
      expect(switches).toHaveLength(1);
      expect(switches[0]?.body).toMatchObject({ stepDown: true });
      expect(harness.engine.load.mock.calls.length).toBe(4);
      await c.stop();
    }
  );
});

describe('matrix D — web probe, code review S5 + S4b (S4d)', () => {
  const engines: WebEngine[] = [];
  afterEach(() => engines.splice(0).forEach((engine) => engine.release()));
  function nativeEngine() {
    const engine = new WebEngine();
    engines.push(engine);
    Object.defineProperty(engine, 'mode', { value: 'native' });
    const video = new FakeVideoElement();
    (engine as unknown as { attach(video: unknown): void }).attach(video);
    const events: EngineEvent[] = [];
    engine.subscribe((event) => events.push(event));
    return { engine, video, events };
  }

  row(
    'D09',
    'Safari native HLS is never probed with HEAD (its routes answer 405): a format error stays a format error (review B6)',
    async () => {
      const fetchMock = jest.fn(async () => ({ status: 405 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const { engine, video, events } = nativeEngine();
      engine.load({ uri: 'http://server.test/api/v1/transcode/t/master.m3u8', kind: 'hls' });
      video.present();
      video.tick(1);
      video.fail(4);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).not.toHaveBeenCalled();
      const failure = events.find((event) => event.type === 'error') as Extract<
        EngineEvent,
        { type: 'error' }
      >;
      expect(classify({ kind: 'engine', engine: 'web', ...failure }).category).toBe('T7');
    }
  );

  row(
    'D09',
    'a direct-play HEAD answered 405 adds no status; the media error is judged by itself',
    async () => {
      globalThis.fetch = jest.fn(async () => ({ status: 405 })) as unknown as typeof fetch;
      const { engine, video, events } = nativeEngine();
      engine.load({ uri: 'http://server.test/api/v1/stream/p1', kind: 'progressive' });
      video.present();
      video.tick(1);
      video.fail(4);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const failure = events.find((event) => event.type === 'error') as Extract<
        EngineEvent,
        { type: 'error' }
      >;
      expect(failure).not.toHaveProperty('status');
      expect(classify({ kind: 'engine', engine: 'web', ...failure }).code).not.toMatch(/^http_/);
    }
  );

  row(
    'D09',
    'a HEAD that never answers gives up after 5 s and the media error goes on (review R1)',
    async () => {
      jest.useFakeTimers();
      globalThis.fetch = jest.fn(() => new Promise(() => undefined)) as unknown as typeof fetch;
      const { engine, video, events } = nativeEngine();
      engine.load({ uri: 'http://server.test/api/v1/stream/p1', kind: 'progressive' });
      video.present();
      video.tick(1);
      video.fail(2);
      await jest.advanceTimersByTimeAsync(4_900);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      await jest.advanceTimersByTimeAsync(200);
      expect(events.filter((event) => event.type === 'error')).toEqual([
        { type: 'error', reason: 'media_error_2', status: 0 },
      ]);
    }
  );
});

describe('matrix D — Safari treats a playlist without ENDLIST as live (S9a D10)', () => {
  row(
    'D10',
    'a reload that Safari starts in its live window (duration unknown, clock below the position): seek back, keep the position for every step',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing({}, { method: 'remux' } as never, 0);
      await playFor(5, (second) => ({
        position: 54 + second,
        health: { framesPresented: second * 24, audioProgress: second * 1000 },
      }));
      harness.engine.fail('networkError:fragLoadError');
      await settle();
      await jest.advanceTimersByTimeAsync(3_000);
      expect(harness.engine.source?.startPosition).toBe(59);
      harness.engine.emit({ type: 'firstFrame' });
      harness.engine.state('playing');
      harness.engine.time(21, Infinity);
      harness.engine.time(22, Infinity);
      expect(c.duration).toBe(600);
      expect(harness.engine.seek).toHaveBeenLastCalledWith(59);
      await playFor(12, (second) => ({
        position: 22 + Math.min(second, 7),
        health: {
          framesPresented: 100 + Math.min(second, 7) * 24,
          audioProgress: 9_000 + second * 1000,
        },
      }));
      await settle();
      const resumed = harness.engine.sources.at(-1)?.startPosition ?? 0;
      expect(resumed).toBeGreaterThanOrEqual(59);
      await c.stop();
    }
  );
});

describe('matrix D — a picture verdict below a start position never reached (S9a D10)', () => {
  row(
    'D10',
    'frames that moved only in a live window below the position are no place to resume: the reload goes back to the position',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing({}, { method: 'remux' } as never, 0);
      await playFor(5, (second) => ({
        position: 54 + second,
        health: { framesPresented: second * 24, audioProgress: second * 1000 },
      }));
      harness.engine.fail('networkError:fragLoadError');
      await settle();
      await jest.advanceTimersByTimeAsync(3_000);
      expect(harness.engine.source?.startPosition).toBe(59);
      harness.engine.emit({ type: 'firstFrame' });
      harness.engine.state('playing');
      // The engine plays from 0:21 with a finite duration (no seek-back), then its picture freezes.
      await playFor(14, (second) => ({
        position: 21 + second,
        health: {
          framesPresented: 200 + Math.min(second, 8) * 24,
          audioProgress: 9_000 + second * 1000,
        },
      }));
      await settle();
      expect(harness.engine.sources.length).toBeGreaterThanOrEqual(3);
      expect(harness.engine.sources.at(-1)?.startPosition).toBe(59);
      await c.stop();
    }
  );
});

describe('matrix D — buffer full, live window, audio switch, drift (S4f)', () => {
  row(
    'D05',
    'MSE buffer full (bufferFullError, non-fatal): hls.js shrinks its buffer itself; no error, no ladder',
    async () => {
      const engine = new WebEngine();
      (engine as unknown as { attach(video: unknown): void }).attach(new FakeVideoElement());
      await loadHls();
      const events: EngineEvent[] = [];
      engine.subscribe((event) => void events.push(event));
      engine.load({ uri: 'http://server.test/master.m3u8', kind: 'hls' });
      // hls.js 1.7.3 sends the fragment with it; three quota errors of one segment are still hls.js's own business (review B2).
      for (let round = 0; round < 3; round += 1)
        FakeHls.last.error('mediaError', 'bufferFullError', {
          fatal: false,
          frag: { type: 'main', sn: 6, level: 0 },
        });
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(FakeHls.last.recoverMediaError).not.toHaveBeenCalled();
      expect(FakeHls.last.stopLoad).not.toHaveBeenCalled();
      engine.release();
    }
  );

  row(
    'D14',
    'ExoPlayer BEHIND_LIVE_WINDOW on a VOD source: a reload at the position, never a step-down',
    async () => {
      jest.useFakeTimers();
      expect(
        classify({
          kind: 'engine',
          engine: 'expo-video',
          reason: 'Source error: ERROR_CODE_BEHIND_LIVE_WINDOW',
        })
      ).toMatchObject({ category: 'T1', code: 'stream_interrupted' });
      const c = await playing({}, { method: 'remux' } as never, 200);
      harness.engine.fail('Source error: ERROR_CODE_BEHIND_LIVE_WINDOW');
      await jest.advanceTimersByTimeAsync(2_500);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(200);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );

  row(
    'D32',
    'an in-session audio switch that never confirms: after its timeout the server switches, with the notice "Audio track switched; playback restarted at the same spot"',
    async () => {
      jest.useFakeTimers();
      const renditions = [
        {
          id: '1',
          streamIndex: 1,
          language: 'de',
          label: 'Deutsch',
          channels: 2,
          codec: 'aac',
          default: true,
        },
        {
          id: '2',
          streamIndex: 2,
          language: 'en',
          label: 'English',
          channels: 2,
          codec: 'aac',
          default: false,
        },
      ];
      const c = await playing(
        {},
        {
          method: 'remux',
          inSessionAudioSwitch: true,
          audioRenditions: renditions,
          mediaInfo: {
            durationTicks: 600 * TICKS,
            audioTracks: [
              { index: 1, language: 'ger', selected: true, deliveredAs: 'remux', renditionId: '1' },
              {
                index: 2,
                language: 'eng',
                selected: false,
                deliveredAs: 'remux',
                renditionId: '2',
              },
            ],
            subtitleTracks: [],
          },
        } as never,
        40
      );
      harness.engine.emit({
        type: 'tracks',
        tracks: {
          audio: [
            { id: 'e0', label: 'English', language: 'en', selected: false },
            { id: 'e1', label: 'Deutsch', language: 'de', selected: true },
          ],
          subtitles: [],
        },
      });
      const switching = c.selectAudio({ index: 2, language: 'eng' } as never);
      await jest.advanceTimersByTimeAsync(AUDIO_SWITCH_TIMEOUT_MS + 100);
      expect(harness.server.sent('switch')[0]?.body).toMatchObject({ audioStreamIndex: 2 });
      harness.engine.started();
      harness.engine.time(41);
      await switching;
      expect(c.notice).toMatchObject({ kind: 'audioRestarted' });
      await i18n.changeLanguage('en');
      expect(i18n.t('notice.audioRestarted', { ns: 'player' } as never)).toBe(
        'Audio track switched; playback restarted at the same spot for it.'
      );
      await c.stop();
    }
  );

  row(
    'D37',
    'drift and drops are logged, not acted on: the web engine reports dropped/total frames for the Info panel; no hint, no ladder',
    async () => {
      jest.useFakeTimers();
      const engine = new WebEngine();
      const video = new FakeVideoElement();
      (engine as unknown as { attach(video: unknown): void }).attach(video);
      await loadHls();
      const stats: EngineEvent[] = [];
      engine.subscribe((event) => void (event.type === 'stats' && stats.push(event)));
      engine.load({ uri: 'http://server.test/master.m3u8', kind: 'hls' });
      video.present(240);
      video.droppedFrames = 12;
      await jest.advanceTimersByTimeAsync(1_000);
      expect(engine.getSnapshot().stats).toMatchObject({
        droppedFrames: 12,
        totalFrames: expect.any(Number),
      });
      engine.release();
      await i18n.changeLanguage('en');
      expect(i18n.t('info.dropped', { ns: 'player', count: 12 } as never)).toMatch(/12/);
    }
  );
});

describe('matrix D — code review S4c-S4f (S4g)', () => {
  row(
    'D34',
    'a frozen clock in the last seconds ends the title, never a stall ladder or a reload (review M04)',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing({}, {}, 0);
      await playFor(5, (second) => ({
        position: 590 + second,
        health: { framesPresented: second * 24, audioProgress: second * 1000 },
      }));
      // The clock stands at 9:55 while the engine says it plays: the stall verdict itself ends it, no hint first.
      await jest.advanceTimersByTimeAsync(6_000);
      expect(c.ended).toBe(true);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );

  row(
    'D35',
    'a clock that jumps far (more than 3 s) is a seek, not a running picture: still loading (review M05)',
    async () => {
      jest.useFakeTimers();
      const c = newController({ startSeconds: 90 });
      await c.start();
      harness.engine.state('playing');
      harness.engine.time(0, 600);
      harness.engine.time(90, 600);
      expect(c.status.spinner).toBe(true);
      harness.engine.time(90.6, 600);
      expect(c.status.spinner).toBe(false);
      await c.stop();
    }
  );

  row(
    'D33',
    "web: the frame counter of a new source starts at 0, not at the old source's count (review M08)",
    async () => {
      const engine = new WebEngine();
      const video = new FakeVideoElement();
      (engine as unknown as { attach(video: unknown): void }).attach(video);
      await loadHls();
      engine.load({ uri: 'http://server.test/a/master.m3u8', kind: 'hls' });
      video.present(500);
      engine.load({ uri: 'http://server.test/b/master.m3u8', kind: 'hls' });
      expect((await engine.readHealth()).framesPresented).toBe(0);
      video.present(24);
      expect((await engine.readHealth()).framesPresented).toBe(24);
      engine.release();
    }
  );
});

describe('matrix D — live re-audit S9a2: hls.js cancelling its own requests (S4i)', () => {
  async function hlsEngine() {
    const engine = new WebEngine();
    (engine as unknown as { attach(video: unknown): void }).attach(new FakeVideoElement());
    await loadHls();
    const events: EngineEvent[] = [];
    engine.subscribe((event) => void (event.type !== 'stats' && events.push(event)));
    engine.load({ uri: 'http://server.test/master.m3u8', kind: 'hls' });
    return { engine, events, hls: FakeHls.last };
  }
  const aborted = (hls: FakeHls, type: string) =>
    hls.error('networkError', 'aborted', { fatal: false, status: 0, frag: { type } });

  row(
    'D29',
    'a seek cancels the subtitle segment in flight (hls.js "aborted"): no subtitle failure, the subtitles stay on (S9a2 SEEK-SUB)',
    async () => {
      const { engine, events, hls } = await hlsEngine();
      aborted(hls, 'subtitle');
      expect(events.filter((event) => event.type === 'subtitleError')).toEqual([]);
      engine.release();
    }
  );

  row(
    'D29',
    'a seek cancels the audio and video segments in flight while video loaded: no audio failure, no retry, no error (S9a2 D29)',
    async () => {
      const { engine, events, hls } = await hlsEngine();
      hls.trigger('hlsFragLoaded', {
        frag: {
          type: 'main',
          duration: 6,
          stats: { loading: { start: 0, first: 100, end: 600 }, loaded: 1 },
        },
      });
      events.length = 0;
      aborted(hls, 'audio');
      aborted(hls, 'main');
      expect(events.map((event) => event.type)).toEqual([]);
      engine.release();
    }
  );
  row(
    'D18',
    'an AVPlayer decoder failure keeps no HTTP status from an older, recovered error-log entry (review 4)',
    async () => {
      const expo = await expoPlaying();
      expo.player.failWith({
        message: 'Cannot Decode',
        domain: 'AVFoundationErrorDomain',
        code: -11821,
        underlyingDomain: 'NSOSStatusErrorDomain',
        underlyingCode: -12909,
        errorLog: 'CoreMediaErrorDomain 404 HTTP 404: File Not Found',
        httpStatus: 404,
      });
      const [decode] = expo.of('error');
      expect(decode?.status).toBeUndefined();
      expect(decode?.reason).not.toContain('404');
      expect(classified(decode!)).toMatchObject({ category: 'T7', code: 'decode_error' });
      // A transport failure keeps the status of its own request.
      const http = await expoPlaying();
      http.player.failWith({
        message: 'File Not Found',
        domain: 'CoreMediaErrorDomain',
        code: -12938,
        errorLog: 'CoreMediaErrorDomain -12938 HTTP 404: File Not Found',
        httpStatus: 404,
      });
      expect(http.of('error')[0]).toMatchObject({ status: 404 });
      expect(classified(http.of('error')[0]!)).toMatchObject({ category: 'T2' });
      // AVFoundation's 403 without an error log is the capability refused (review 17).
      expect(
        classified({ reason: 'NSURLErrorDomain -1102 (CoreMediaErrorDomain -12660): Forbidden' })
      ).toMatchObject({ category: 'T2', code: 'unknown_stream' });
      expo.engine.release();
      http.engine.release();
    }
  );
  row(
    'D28',
    'after a stop the handler is gone: the next real Stopped ends the source, and no stats are read during the stop',
    async () => {
      jest.useFakeTimers();
      FakeVlcView.reset();
      FakeVlcView.stats = { displayedPictures: 5, decodedVideo: 5 };
      const vlc = vlcPlaying();
      await render(createElement(vlc.engine.Surface));
      const done = vlc.engine.shutdown();
      FakeVlcView.ref.getStats.mockClear();
      await expect(vlc.engine.readHealth()).resolves.toEqual({});
      expect(FakeVlcView.ref.getStats).not.toHaveBeenCalled();
      FakeVlcView.call('onStopped');
      await done;
      expect(vlc.of('ended')).toEqual([]);
      FakeVlcView.call('onStopped');
      expect(vlc.of('ended')).toHaveLength(1);
      vlc.engine.release();
    }
  );
  row(
    'D23',
    "VLC's own reload without direct rendering is a fresh load for the controller, not a stall (review 12)",
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { engine: 'vlc' } as never, 0);
      harness.engine.time(20);
      harness.engine.state('loading');
      harness.engine.emit({ type: 'reload' });
      await jest.advanceTimersByTimeAsync(16_000);
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(c.status.hint?.key).toBe('startSlow');
      harness.engine.emit({ type: 'firstFrame' });
      harness.engine.state('playing');
      await settle();
      expect(c.status.hint).toBeNull();
      await c.stop();
    }
  );
  row(
    'D36',
    'Exo: a dead audio rendition while the picture plays is the audio path (reload, conversion), never "Connection lost" (S9b)',
    async () => {
      jest.useFakeTimers();
      const expo = await expoPlaying();
      expo.player.failWith({
        message: 'Source error',
        errorCodeName: 'ERROR_CODE_IO_NETWORK_CONNECTION_FAILED',
        uri: 'http://server/api/v1/transcode/tok/audio/1/12.m4s',
      });
      const [event] = expo.of('error');
      expect(event?.reason).toMatch(/^audioRendition:/);
      expect(classified(event!)).toMatchObject({ category: 'T7', code: 'audio_rendition_failed' });
      expo.engine.release();
      // The same failure on the video segment stays a lost connection.
      const video = await expoPlaying();
      video.player.failWith({
        message: 'Source error',
        errorCodeName: 'ERROR_CODE_IO_NETWORK_CONNECTION_FAILED',
        uri: 'http://server/api/v1/transcode/tok/12.m4s',
      });
      expect(classified(video.of('error')[0]!)).toMatchObject({ category: 'T1' });
      video.engine.release();
      const c = await playing(
        {},
        { mediaInfo: { ...hdInfo, audioTracks: [{ index: 1 }] } } as never,
        0
      );
      harness.engine.time(35);
      harness.engine.emit(event!);
      await settle();
      expect(c.status.hint?.key).not.toBe('reconnecting');
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started();
      harness.engine.emit(event!);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ audioFallback: true });
      await c.stop();
    }
  );
  row(
    'D41',
    'Exo: a segment that does not parse is damaged content: reload once (even when it recurs), then another way with the honest reason (S9b)',
    async () => {
      jest.useFakeTimers();
      const expo = await expoPlaying();
      expo.player.failWith({
        message: 'Source error',
        errorCodeName: 'ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED',
        uri: 'http://server/api/v1/transcode/tok/7.m4s',
      });
      const [event] = expo.of('error');
      expect(classified(event!)).toMatchObject({ category: 'T7', code: 'media_damaged' });
      // Without a segment (a direct-play file the device cannot open) it stays the device's decoder.
      expect(
        classified({ reason: 'ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED: Source error' })
      ).toMatchObject({ code: 'decode_error' });
      expo.engine.release();
      const c = await playing({}, { method: 'remux', mediaInfo: hdInfo } as never, 0);
      harness.engine.time(41);
      // A damaged spot is no device failure: even recurring it reloads first.
      expect(
        nextStep(
          new Incident(Date.now()),
          { category: 'T7', code: 'media_damaged' },
          {
            attached: true,
            online: true,
            canLowerQuality: false,
            revision: 0,
            audioFallback: false,
            recurring: true,
          }
        ).step
      ).toBe('R');
      harness.engine.emit(event!);
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.server.sent('switch')).toHaveLength(0);
      harness.engine.emit(event!);
      await settle();
      harness.engine.started();
      harness.engine.emit(event!);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      expect(c.notice).toMatchObject({ kind: 'stepDown', params: { reason: 'media_damaged' } });
      const pt = (key: string, options?: Record<string, unknown>) =>
        i18n.getFixedT('en')(key, { ...options, ns: 'player' } as never) as unknown as string;
      const key = stepDownReasonKey(c.notice?.params);
      expect(key && pt(key, { time: c.notice?.params?.at })).toMatch(
        /^The video data is damaged at \d+:\d\d\.$/
      );
      await c.stop();
    }
  );
  row(
    'D24',
    'VLC started at a position: black until the clock passes it, the dropped start seek is sent again after 3 s (S9b)',
    async () => {
      jest.useFakeTimers();
      FakeVlcView.reset();
      const engine = new VlcEngine();
      const internals = engine as unknown as {
        view: { current: unknown };
        props: { get(): { cover: boolean } };
        onTime(seconds: number): void;
      };
      engine.load({ uri: 'http://server/a.mkv', kind: 'progressive', startPosition: 42 });
      await render(createElement(engine.Surface));
      internals.view.current = FakeVlcView.ref;
      expect(internals.props.get().cover).toBe(true);
      FakeVlcView.call('onPlaying');
      internals.onTime(0.2);
      expect(FakeVlcView.ref.seek).not.toHaveBeenCalled();
      jest.setSystemTime(Date.now() + 3_100);
      internals.onTime(0.3);
      expect(FakeVlcView.ref.seek).toHaveBeenCalledWith(42_000, 'time');
      expect(internals.props.get().cover).toBe(true);
      internals.onTime(42.4);
      expect(internals.props.get().cover).toBe(false);
      engine.release();
    }
  );
  row(
    'D41',
    'Exo on HLS: a parser error without a URI (seen live on Google TV, S6t) is damaged content, on a file it is the decoder',
    async () => {
      const hls = await expoPlaying('hls');
      hls.player.failWith({
        message: 'Source error Skipping atom with length > 2147483647 (unsupported).',
        errorCodeName: 'ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED',
      });
      expect(classified(hls.of('error')[0]!)).toMatchObject({ code: 'media_damaged' });
      hls.engine.release();
      const file = await expoPlaying('progressive');
      file.player.failWith({
        message: 'Source error Skipping atom with length > 2147483647 (unsupported).',
        errorCodeName: 'ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED',
      });
      expect(classified(file.of('error')[0]!).code).not.toBe('media_damaged');
      file.engine.release();
    }
  );
});

describe("matrix D — live native audit S9b turn 2: another version keeps the viewer's languages (S4l)", () => {
  const german = {
    method: 'remux',
    version: { releaseId: 'r1' },
    mediaInfo: {
      durationTicks: 600 * TICKS,
      audioTracks: [{ index: 1, language: 'de', deliveredAs: 'original', selected: true }],
      subtitleTracks: [
        { index: 3, language: 'de', forced: false, deliveredAs: 'webvtt', selected: true },
      ],
    },
  } as never;
  const other = (subtitles: { index: number; language: string; selected: boolean }[]) =>
    reply.ok(
      harness.server.playback({
        playbackId: 'v2',
        version: { releaseId: 'r2' },
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: [{ index: 1, language: 'de', deliveredAs: 'original', selected: true }],
          subtitleTracks: subtitles.map((track) => ({ ...track, deliveredAs: 'webvtt' })),
        },
      } as never)
    );

  async function toOtherVersion(answer: ReturnType<typeof other>) {
    jest.useFakeTimers();
    const c = await playing({}, german, 44);
    harness.engine.emit({
      type: 'tracks',
      tracks: {
        audio: [{ id: 'a0', label: 'de', language: 'de', selected: true }],
        subtitles: [{ id: 's0', label: 'de', language: 'de', selected: true }],
      },
    });
    harness.server.answer(
      'versions',
      reply.ok({ versions: [{ releaseId: 'r2', rank: 1, predictedMethod: 'remux' }] })
    );
    harness.server.answer('start', answer);
    harness.engine.fail('keySystemError:keySystemNoKeys');
    await settle();
    harness.engine.started();
    harness.engine.fail('keySystemError:keySystemNoKeys');
    await settle();
    return c;
  }

  row(
    'D36',
    "step V asks the other version for the viewer's audio and subtitle language (S9b2 D36)",
    async () => {
      const c = await toOtherVersion(other([{ index: 7, language: 'de', selected: true }]));
      expect(starts().at(-1)?.releaseId).toBe('r2');
      expect(starts().at(-1)?.body.preferences).toMatchObject({
        audioLanguage: 'de',
        subtitleLanguage: 'de',
        subtitleMode: 'always',
      });
      expect(c.notice).toEqual(expect.objectContaining({ kind: 'otherVersion', params: {} }));
      await c.stop();
    }
  );

  row(
    'D36',
    'an other version without the viewer\'s subtitle language says so: "This version has no German subtitles." (S9b2 D36)',
    async () => {
      await i18n.changeLanguage('en');
      const c = await toOtherVersion(other([{ index: 7, language: 'en', selected: false }]));
      expect(c.notice).toMatchObject({ kind: 'otherVersion', params: { noSubtitle: 'de' } });
      const pt = (key: string, options?: Record<string, unknown>) =>
        i18n.t(key as never, { ...options, ns: 'player' } as never) as unknown as string;
      expect(
        noticeText(
          c.notice!,
          pt as never,
          () => '',
          () => ''
        )
      ).toBe('Switched to another version to keep playing. This version has no German subtitles.');
      await c.stop();
    }
  );
});

describe('matrix D — S4s: a browser network error keeps its MediaError code (V1 blocking D09)', () => {
  const web = (reason: string, status?: number) =>
    classify({
      kind: 'engine',
      engine: 'web',
      reason,
      ...(status === undefined ? {} : { status }),
    });

  row(
    'D09',
    'Chrome, Firefox and Safari messages on MEDIA_ERR_NETWORK, or an unreachable HEAD, are the network (T1), never a decoder step-down',
    async () => {
      // The <video> element keeps the code in front of the browser's message.
      const engine = new WebEngine();
      const video = new FakeVideoElement();
      (engine as unknown as { attach(video: unknown): void }).attach(video);
      const reasons: string[] = [];
      engine.subscribe((event) => void (event.type === 'error' && reasons.push(event.reason)));
      engine.load({ uri: 'http://server.test/master.m3u8', kind: 'hls' });
      video.fail(2, 'PIPELINE_ERROR_READ: FFmpegDemuxer: data source error');
      expect(reasons).toEqual([
        'media_error_2: PIPELINE_ERROR_READ: FFmpegDemuxer: data source error',
      ]);
      engine.release();
      for (const reason of [
        'media_error_2: PIPELINE_ERROR_READ: FFmpegDemuxer: data source error',
        'media_error_2: NS_ERROR_NET_PARTIAL_TRANSFER',
        'media_error_2: Load failed',
        'media_error_2',
      ])
        expect(web(reason)).toMatchObject({ category: 'T1', code: 'network_unreachable' });
      // The V1 probes: a browser message without the code, but the HEAD probe got no answer (status 0).
      expect(web('PIPELINE_ERROR_READ: FFmpegDemuxer: data source error', 0).category).toBe('T1');
      expect(web('NS_ERROR_NET_PARTIAL_TRANSFER', 0).category).toBe('T1');
      // Any other message (not a decode or format code) with the HEAD unanswered is the network too.
      expect(web('DEMUXER_ERROR_COULD_NOT_OPEN', 0).category).toBe('T1');
    }
  );

  row('D09', 'MEDIA_ERR_DECODE and SRC_NOT_SUPPORTED keep their paths', () => {
    expect(web('media_error_3: PIPELINE_ERROR_DECODE: video decode failed')).toMatchObject({
      category: 'T7',
      code: 'decode_error',
    });
    expect(web('media_error_4: MEDIA_ERR_SRC_NOT_SUPPORTED')).toMatchObject({ category: 'T7' });
    expect(web('media_error_4', 404)).toMatchObject({ category: 'T2' });
  });
});

describe('matrix D — S4u: Chrome reports a dead server before metadata as code 4 (review 7 P2-3)', () => {
  const web = (reason: string, status?: number) =>
    classify({
      kind: 'engine',
      engine: 'web',
      reason,
      ...(status === undefined ? {} : { status }),
    });

  row(
    'D09',
    'code 4 with the HEAD unanswered or a network message is the network; with an answered HEAD it stays the format (T7, 404 → T2)',
    () => {
      const formatError = 'media_error_4: MEDIA_ELEMENT_ERROR: Format error';
      expect(web(formatError, 0)).toMatchObject({ category: 'T1', code: 'network_unreachable' });
      expect(
        web('media_error_4: PIPELINE_ERROR_READ: FFmpegDemuxer: data source error')
      ).toMatchObject({ category: 'T1' });
      expect(web('media_error_4: NS_ERROR_NET_INTERRUPT')).toMatchObject({ category: 'T1' });
      expect(web('media_error_4: NS_ERROR_CONNECTION_REFUSED')).toMatchObject({ category: 'T1' });
      expect(web(formatError)).toMatchObject({ category: 'T7' });
      expect(web(formatError, 404)).toMatchObject({ category: 'T2' });
      // MEDIA_ERR_NETWORK decides over a pipeline word the decoder rule would take (Chrome's PIPELINE_ERROR_NETWORK).
      expect(web('media_error_2: PIPELINE_ERROR_NETWORK')).toMatchObject({
        category: 'T1',
      });
      // MEDIA_ERR_NETWORK without a message (Safari native HLS, no HEAD) is the network on its own.
      expect(web('media_error_2: MEDIA_ELEMENT_ERROR: Empty src attribute')).toMatchObject({
        category: 'T1',
      });
      // MEDIA_ERR_DECODE: the bytes arrived; its reload meets a dead network as code 2 or 4 again.
      expect(web('media_error_3: NS_ERROR_NET_INTERRUPT')).toMatchObject({ category: 'T7' });
    }
  );

  row(
    'D09',
    'web direct play while the server is down: code 2, reconnect, reload fails as code 4 with no HEAD answer → still reconnecting, then the network card, never a step-down (review 7 P6)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({ nativeEngine: 'web' }, { method: 'direct' } as never, 100);
      harness.engine.emit({
        type: 'error',
        reason: 'media_error_2: PIPELINE_ERROR_READ: FFmpegDemuxer: data source error',
        status: 0,
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(c.status.hint?.key).toBe('reconnecting');
      for (let reload = 0; reload < 2; reload += 1) {
        const loads = harness.engine.load.mock.calls.length;
        await jest.advanceTimersByTimeAsync(20_000);
        expect(harness.engine.load.mock.calls.length).toBeGreaterThan(loads);
        harness.engine.emit({
          type: 'error',
          reason: 'media_error_4: MEDIA_ELEMENT_ERROR: Format error',
          status: 0,
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(c.status.hint?.key).toBe('reconnecting');
      }
      // The stuck budget ends on the "connection lost" card (T1, Retry), not on the device.
      await jest.advanceTimersByTimeAsync(20_000);
      harness.engine.emit({
        type: 'error',
        reason: 'media_error_4: MEDIA_ELEMENT_ERROR: Format error',
        status: 0,
      });
      await settle();
      expect(c.failure).toMatchObject({ category: 'T1', code: 'network_unreachable' });
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(harness.server.sent('versions')).toHaveLength(0);
      await c.stop();
    }
  );
});

describe('matrix D — S4s: a reclaimed decoder is the device, not the server (V1 D17, A21)', () => {
  row(
    'D17',
    'reclaim: "Reloading at …" at once (no server hint, no wait), a second reclaim steps down with the device as the reason (V1 probe P5)',
    async () => {
      jest.useFakeTimers();
      const reclaim = 'ERROR_CODE_DECODING_RESOURCES_RECLAIMED: MediaCodec released';
      const failure = classify({ kind: 'engine', engine: 'expo-video', reason: reclaim });
      const context = {
        attached: true,
        online: true,
        canLowerQuality: true,
        revision: 1,
        audioFallback: false,
      };
      const first = nextStep(new Incident(0), failure, context);
      expect(first).toEqual({ step: 'R', delayMs: 0, hint: 'reloading' });
      const c = await playing({}, {}, 33);
      harness.engine.fail(reclaim);
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(33);
      expect(c.status.hint?.key).not.toBe('serverError');
      harness.engine.started();
      harness.engine.time(34);
      harness.engine.fail(reclaim);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      expect(stepDownReasonKey({ reason: 'decoder_reclaimed' })).toBe('notice.because.T7');
      await c.stop();
    }
  );

  row(
    'D17',
    'reclaim while no source is attached (a start, a new start): one new start with "Reloading", then its own card, never "the server had a problem" (review 7 P3-2)',
    () => {
      const failure = classify({
        kind: 'engine',
        engine: 'expo-video',
        reason: 'ERROR_CODE_DECODING_RESOURCES_RECLAIMED: MediaCodec released',
      });
      const context = {
        attached: false,
        online: true,
        canLowerQuality: true,
        revision: 1,
        audioFallback: false,
      };
      const incident = new Incident(0);
      const first = nextStep(incident, failure, context);
      expect(first).toEqual({ step: 'N', delayMs: 0, hint: 'reloading' });
      incident.attempts.push({
        step: 'N',
        category: 'T6',
        code: 'decoder_reclaimed',
        position: 0,
        at: 0,
        revision: 1,
      } as never);
      expect(nextStep(incident, failure, context)).toEqual({ step: 'G', delayMs: 0 });
      expect(describeError(i18n.t, { code: 'decoder_reclaimed' })).not.toEqual(
        describeError(i18n.t, { code: 'server_error' })
      );
    }
  );
});

describe("matrix D — S4s: a VLC failure with the server's HTTP status (S6x payloads)", () => {
  const vlc = (reason: string, status?: number) =>
    classify({
      kind: 'engine',
      engine: 'vlc',
      reason,
      ...(status === undefined ? {} : { status }),
    });
  const dialog =
    "vlc_dialog error: Your media can't be opened VLC is unable to open the MRL 'http://127.0.0.1:39300/api/v1/stream/tok'. Check the log for details.";

  row(
    'D27',
    'the recorded S6x payload (dialog + error, status 404) is the missing file (T2, new start); 5xx the server; no status keeps the S4r rule',
    () => {
      expect(vlc(dialog, 404)).toMatchObject({ category: 'T2', code: 'unknown_stream' });
      expect(vlc('Player encountered an error', 404)).toMatchObject({ category: 'T2' });
      expect(vlc(dialog, 410)).toMatchObject({ category: 'T2', code: 'session_closed' });
      expect(vlc(dialog, 416)).toMatchObject({ category: 'T8', code: 'end_of_stream' });
      expect(vlc(dialog, 503)).toMatchObject({ category: 'T6' });
      expect(
        vlc('vlc_dialog error: Codec not supported VLC could not decode the format "dts "', 503)
      ).toMatchObject({
        category: 'T6',
      });
      // No answer from the server: the S4r rule (MRL open failure = a new start) still agrees.
      expect(vlc(dialog)).toMatchObject({ category: 'T2' });
      expect(
        vlc('vlc_dialog error: Codec not supported VLC could not decode the format "dts "')
      ).toMatchObject({
        category: 'T7',
        code: 'vlc_dialog',
      });
    }
  );
});

describe('matrix D — S4s: Exo I/O failures are the stream, not the device (V1 D11 drift)', () => {
  row(
    'D11',
    'IO_FILE_NOT_FOUND is the missing file (T2, new start), IO_UNSPECIFIED a broken-off stream (T1)',
    () => {
      const exo = (reason: string) => classify({ kind: 'engine', engine: 'expo-video', reason });
      expect(exo('ERROR_CODE_IO_FILE_NOT_FOUND: Source error')).toMatchObject({ category: 'T2' });
      expect(exo('ERROR_CODE_IO_UNSPECIFIED: Source error')).toMatchObject({
        category: 'T1',
        code: 'stream_interrupted',
      });
    }
  );
});

describe('matrix D — S4x: AVPlayer gives up waiting in a stall, replayed on the real engine (S9c D19, review 8 P1-1)', () => {
  const subtitled = {
    method: 'remux',
    mediaInfo: {
      durationTicks: 600 * TICKS,
      audioTracks: [],
      subtitleTracks: [{ index: 5, language: 'de', deliveredAs: 'webvtt', selected: true }],
    },
  } as never;
  const shown = {
    audio: [],
    subtitles: [{ id: 's0', label: 'de', language: 'de', selected: true }],
  };
  /** The controller at 0:47 with the German subtitle; the real ExpoVideoEngine starved: loading, not playing. */
  async function starved() {
    const c = await playing({}, subtitled, 47);
    harness.engine.emit({ type: 'tracks', tracks: shown });
    const expo = await expoPlaying();
    expo.player.setStatus('loading');
    expo.player.setPlaying(false);
    expect(expo.events).toEqual([
      { type: 'buffering', buffering: true },
      { type: 'state', state: 'buffering' },
    ]);
    expo.replay();
    return { c, expo };
  }
  /** AVPlayer stops waiting by itself 20 s into the stall (timeControlStatus paused → readyToPlay, not playing). */
  async function stopsItself(expo: Awaited<ReturnType<typeof starved>>['expo']) {
    await jest.advanceTimersByTimeAsync(20_000);
    harness.engine.play.mockClear();
    expo.player.setStatus('readyToPlay');
    expect(expo.events).toEqual([{ type: 'stalledPause' }]);
    expo.replay();
  }

  async function holdsTheStall(c: PlaybackController) {
    // Asked once to play again after the patch's own check for a system cause had its time.
    await jest.advanceTimersByTimeAsync(400);
    expect(harness.engine.play).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(200);
    expect(harness.engine.play).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(SYSTEM_PAUSE_MS + 2_000);
    expect(c.systemPaused).toBe(false);
    expect(c.paused).toBe(false);
    expect(c.status.hint?.key).not.toBe('pausedBySystem');
    expect(c.notice?.kind).not.toBe('subtitleFailed');
    // The quiet subtitle try ran at 15 s; the ladder for the video reloads at 0:47 with the subtitle back on.
    await jest.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    expect(harness.engine.source?.startPosition).toBe(47);
    expect(c.notice?.kind).not.toBe('subtitleFailed');
    expect(c.currentSubtitle()).toBe(5);
  }

  row(
    'D19',
    'iPhone: the recorded order (loading, not playing; readyToPlay without playing at 20 s) keeps the stall: no "subtitles failed", no "paused outside the app", the ladder reloads at 0:47',
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, expo } = await starved();
      await stopsItself(expo);
      await holdsTheStall(c);
      expo.engine.release();
      os.restore();
      await c.stop();
    }
  );

  row('D19', 'Apple TV (tvOS AVPlayer): the same order, the same stall', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const tv = jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const { c, expo } = await starved();
    await stopsItself(expo);
    await holdsTheStall(c);
    expo.engine.release();
    tv.mockRestore();
    os.restore();
    await c.stop();
  });

  row(
    'D19',
    'headphones unplugged during the stall: AVPlayer stops, the patch names the cause 0.3 s later — no "play again", the cause is shown',
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, expo } = await starved();
      await stopsItself(expo);
      await jest.advanceTimersByTimeAsync(300);
      expo.player.system(true, 'headphones');
      expo.replay();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(harness.engine.play).not.toHaveBeenCalled();
      expect(c.systemPaused).toBe(true);
      expect(c.status.hint).toMatchObject({
        key: 'pausedBySystem',
        params: { cause: 'headphones' },
      });
      await jest.advanceTimersByTimeAsync(60_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expo.engine.release();
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    'a pause during a stall on the web (media key, browser controls) is a real pause: the player stays paused, never played again (review 8 P2-1)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({ nativeEngine: 'web' }, subtitled, 47);
      harness.engine.play.mockClear();
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      await jest.advanceTimersByTimeAsync(3_000);
      // The web engine's order: the element's `pause`, then its userPlayback.
      harness.engine.state('paused');
      harness.engine.emit({ type: 'userPlayback', paused: true });
      await jest.advanceTimersByTimeAsync(60_000);
      expect(harness.engine.play).not.toHaveBeenCalled();
      expect(c.paused).toBe(true);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      await c.stop();
    }
  );

  row(
    'D19',
    'the viewer pauses in the app during a stall, also on VLC: paused it stays, no ladder runs while paused (review 8 R01, R02)',
    async () => {
      jest.useFakeTimers();
      for (const engine of ['expo-video', 'vlc'] as const) {
        harness.reset();
        const c = await playing(
          {},
          { ...(subtitled as object), engine: engine === 'vlc' ? 'vlc' : undefined } as never,
          47
        );
        harness.engine.play.mockClear();
        harness.engine.emit({ type: 'buffering', buffering: true });
        harness.engine.state('buffering');
        await jest.advanceTimersByTimeAsync(3_000);
        c.setPaused(true);
        harness.engine.state('paused');
        // VLC also reports its audio-focus loss and background as a plain pause.
        harness.engine.state('paused');
        await jest.advanceTimersByTimeAsync(60_000);
        expect(harness.engine.play).not.toHaveBeenCalled();
        expect(c.paused).toBe(true);
        expect(harness.engine.load).toHaveBeenCalledTimes(1);
        await c.stop();
      }
    }
  );

  /** V2's live order (iPhone and Apple TV, forced subtitle): the quiet subtitle try, AVPlayer reports playing with the clock still, starves again, stops itself. */
  async function v2Order() {
    jest.useFakeTimers();
    const { c, expo } = await starved();
    await jest.advanceTimersByTimeAsync(16_000);
    expect(harness.engine.commands).toContain('subtitle:null');
    // AVPlayer re-evaluates without the subtitle: readyToPlay and playing for a moment, the clock does not move.
    expo.player.playing = true;
    expo.player.setStatus('readyToPlay');
    expect(expo.of('buffering')).toEqual([{ type: 'buffering', buffering: false }]);
    expo.replay();
    await jest.advanceTimersByTimeAsync(1_200);
    expect(c.status.spinner).toBe(true);
    expect(c.notice).toBeNull();
    // Starved again, then its own stop.
    expo.player.setStatus('loading');
    expo.player.setPlaying(false);
    expo.replay();
    await jest.advanceTimersByTimeAsync(4_000);
    expo.player.setStatus('readyToPlay');
    expect(expo.events).toEqual([{ type: 'stalledPause' }]);
    expo.replay();
    await jest.advanceTimersByTimeAsync(SYSTEM_PAUSE_MS + 1_000);
    expect(c.notice).toBeNull();
    expect(c.systemPaused).toBe(false);
    expect(c.status.hint?.key).not.toBe('pausedBySystem');
    // One fresh budget for the quiet try (S4w): the ladder reloads at 0:47 within 31 s of the stall, subtitles back.
    await jest.advanceTimersByTimeAsync(9_000);
    await settle();
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    expect(harness.engine.source?.startPosition).toBe(47);
    expect(c.currentSubtitle()).toBe(5);
    expo.engine.release();
    await c.stop();
  }

  row(
    'D19',
    'iPhone, V2 live order: subtitles off quietly → "playing" with the clock standing → starved → own stop: the stall never ends without the clock, no notice, no "outside", the ladder reloads',
    async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      await v2Order();
      os.restore();
    }
  );

  row('D19', 'Apple TV, V2 live order: the same stall to the same reload', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const tv = jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    await v2Order();
    tv.mockRestore();
    os.restore();
  });

  row(
    'D19',
    'iPhone, V2 blocking 2: lock during the stall, unlock, "Weiter": the engine still starves, so the spinner and the stall budget come back at once and the ladder reloads',
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, expo } = await starved();
      await jest.advanceTimersByTimeAsync(8_000);
      expo.player.system(true, 'locked');
      expo.replay();
      expect(c.systemPaused).toBe(true);
      await jest.advanceTimersByTimeAsync(28_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      // Unlocked, the viewer taps "Weiter": AVPlayer reports nothing new (still loading, not playing).
      c.setPaused(false);
      expect(expo.events).toEqual([]);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(true);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(c.status.hint?.key).toBe('buffering');
      await jest.advanceTimersByTimeAsync(27_000);
      await settle();
      expect(
        harness.engine.load.mock.calls.length + harness.server.sent('switch').length
      ).toBeGreaterThan(1);
      expect(harness.engine.source?.startPosition ?? 47).toBe(47);
      expo.engine.release();
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    'the OS ends its own pause (a call ends) into a starved buffer: the same spinner and budget, no black screen',
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, expo } = await starved();
      await jest.advanceTimersByTimeAsync(3_000);
      expo.player.system(true, 'call');
      expo.replay();
      await jest.advanceTimersByTimeAsync(30_000);
      expo.player.system(false, 'resume');
      expo.replay();
      expect(c.paused).toBe(false);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(true);
      await jest.advanceTimersByTimeAsync(30_000);
      await settle();
      expect(
        harness.engine.load.mock.calls.length + harness.server.sent('switch').length
      ).toBeGreaterThan(1);
      expo.engine.release();
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    'any path: an engine that waits for data while the player wants to play becomes a stall within 2 s (the watchdog rule, here a buffering state the controller missed)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, subtitled, 47);
      // The state arrived while the controller was paused, so no stall started; then a resume without a new event.
      c.setPaused(true);
      harness.engine.state('paused');
      harness.engine.snapshot = { ...harness.engine.snapshot, state: 'buffering' };
      (c as unknown as { paused: boolean }).paused = false;
      expect(c.status.spinner).toBe(false);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(c.status.spinner).toBe(true);
      await c.stop();
    }
  );

  row(
    'D19',
    'back in the foreground (JS timers slept in the background) with the engine starved and no stall armed: the stall starts at once (V2 turn 2)',
    async () => {
      jest.useFakeTimers();
      const handlers: ((state: string) => void)[] = [];
      jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
        handlers.push(handler as (state: string) => void);
        return { remove: () => undefined };
      });
      const c = await playing({}, subtitled, 47);
      (c as unknown as { monitor: { stop(): void } }).monitor.stop();
      harness.engine.snapshot = { ...harness.engine.snapshot, state: 'buffering' };
      await jest.advanceTimersByTimeAsync(3_000);
      expect(c.status.spinner).toBe(false);
      handlers.forEach((handler) => handler('active'));
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(true);
      await c.stop();
    }
  );

  row(
    'D19',
    'V2 order, then AVPlayer starves again and one 0.3 s clock step (drained frames) arrives: the stall goes on — no notice, spinner stays, the reload keeps the subtitle (review 9 P2-1)',
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, expo } = await starved();
      await jest.advanceTimersByTimeAsync(16_000);
      expect(harness.engine.commands).toContain('subtitle:null');
      // The flicker: readyToPlay and playing for a moment, the clock stands.
      expo.player.playing = true;
      expo.player.setStatus('readyToPlay');
      expo.replay();
      await jest.advanceTimersByTimeAsync(500);
      // Starved again, then one time event 0.3 s ahead and nothing more.
      expo.player.setStatus('loading');
      expo.player.setPlaying(false);
      expo.replay();
      await jest.advanceTimersByTimeAsync(3_000);
      harness.engine.time(47.3);
      expect(c.notice).toBeNull();
      expect(c.status.spinner).toBe(true);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(true);
      await jest.advanceTimersByTimeAsync(12_000);
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(c.notice?.kind).not.toBe('subtitleFailed');
      expect(c.currentSubtitle()).toBe(5);
      expo.engine.release();
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    'an engine that only says "buffering" (VLC, no state change): buffering over, starving again, one 0.3 s step — still the stall (review 9 M39)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { method: 'direct', engine: 'vlc' } as never, 47);
      expect(harness.engine.kind).toBe('vlc');
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(3_000);
      harness.engine.emit({ type: 'buffering', buffering: false });
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.time(47.3);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(true);
      // The clock really runs: the stall ends.
      harness.engine.emit({ type: 'buffering', buffering: false });
      harness.engine.time(47.6);
      expect(c.status.spinner).toBe(false);
      await c.stop();
    }
  );

  row(
    'D19',
    'a forward seek during the quiet subtitle try: no "subtitles failed", the subtitles come back, the spinner stays while the engine waits at the new place (review 9 P2-2)',
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, expo } = await starved();
      await jest.advanceTimersByTimeAsync(16_000);
      expect(harness.engine.commands).toContain('subtitle:null');
      c.seekTo(120);
      harness.engine.time(120);
      expect(c.notice).toBeNull();
      expect(
        harness.engine.commands.filter((command) => command.startsWith('subtitle:')).at(-1)
      ).toBe('subtitle:s0');
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(true);
      // It plays at the new place: the stall ends, nobody is blamed.
      harness.engine.time(121.5);
      expect(c.status.spinner).toBe(false);
      expect(c.notice).toBeNull();
      expect(c.currentSubtitle()).toBe(5);
      expo.engine.release();
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    'Back within the half second after AVPlayer stopped itself: no "play again" reaches the closed player (review 9 P3-1)',
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, expo } = await starved();
      await stopsItself(expo);
      await jest.advanceTimersByTimeAsync(200);
      await c.stop();
      harness.engine.play.mockClear();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(harness.engine.play).not.toHaveBeenCalled();
      expo.engine.release();
      os.restore();
    }
  );

  row(
    'D19',
    'the stall ends within the half second (the data came): no late "play again" (review 9 M33)',
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, expo } = await starved();
      await stopsItself(expo);
      harness.engine.time(48.5);
      expect(c.status.spinner).toBe(false);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(harness.engine.play).not.toHaveBeenCalled();
      expo.engine.release();
      os.restore();
      await c.stop();
    }
  );

  row('D19', "on AirPlay AVPlayer's stop is not overridden (review 9 M17)", async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const { c, expo } = await starved();
    harness.engine.emit({ type: 'external', active: true, device: 'Living room' });
    await stopsItself(expo);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(harness.engine.play).not.toHaveBeenCalled();
    expo.engine.release();
    os.restore();
    await c.stop();
  });

  row(
    'D19',
    'Android (Exo): readyToPlay without playing during buffering is a pause (audio focus), never a stalledPause or a "play again" (review 9 M14)',
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'android');
      const c = await playing({}, subtitled, 47);
      const expo = await expoPlaying();
      expo.player.setStatus('loading');
      expo.player.setPlaying(false);
      expo.replay();
      await jest.advanceTimersByTimeAsync(3_000);
      expo.player.setStatus('readyToPlay');
      expect(expo.of('stalledPause')).toEqual([]);
      expo.replay();
      harness.engine.play.mockClear();
      await jest.advanceTimersByTimeAsync(2_000);
      expect(harness.engine.play).not.toHaveBeenCalled();
      expo.engine.release();
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    'headphones out after AVPlayer stopped itself, the data comes while paused, then Play: no stall counted at once, no spinner without a wait (review 9 P3-4)',
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, expo } = await starved();
      await stopsItself(expo);
      // AVPlayer was already not playing: the patch's systemPlayback comes without a playingChange.
      expo.player.fire('systemPlayback', { paused: true, cause: 'headphones' });
      expect(expo.of('state')).toEqual([{ type: 'state', state: 'paused' }]);
      expo.replay();
      expect(c.paused).toBe(true);
      await jest.advanceTimersByTimeAsync(5_000);
      c.setPaused(false);
      await jest.advanceTimersByTimeAsync(1_200);
      expect(c.status.spinner).toBe(false);
      await jest.advanceTimersByTimeAsync(20_000);
      expect(c.status.spinner).toBe(false);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expo.engine.release();
      os.restore();
      await c.stop();
    }
  );

  it.each([300, 100])(
    'D19 AVPlayer stops itself %d ms before the quiet subtitle try: still asked once to play again (review 10 P3-1)',
    async (before) => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, expo } = await starved();
      await jest.advanceTimersByTimeAsync(15_000 - before);
      harness.engine.play.mockClear();
      expo.player.setStatus('readyToPlay');
      expect(expo.events).toEqual([{ type: 'stalledPause' }]);
      expo.replay();
      await jest.advanceTimersByTimeAsync(2_000);
      expect(harness.engine.commands).toContain('subtitle:null');
      expect(harness.engine.play).toHaveBeenCalledTimes(1);
      expo.engine.release();
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    'the data comes within the half second and the next stall starts at once: that stall gets no "play again" meant for the last one (review 10 Z09)',
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, expo } = await starved();
      await stopsItself(expo);
      await jest.advanceTimersByTimeAsync(100);
      // AVPlayer plays on by itself (the data came), the clock runs, then it starves again right away.
      expo.player.playing = true;
      expo.player.setStatus('loading');
      expo.player.setStatus('readyToPlay');
      expo.replay();
      harness.engine.time(47.5);
      expect(c.status.spinner).toBe(false);
      expo.player.setStatus('loading');
      expo.replay();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(harness.engine.play).not.toHaveBeenCalled();
      expo.engine.release();
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    'the viewer presses pause in the app within the half second: no "play again" (review 8 R01)',
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, expo } = await starved();
      await stopsItself(expo);
      await jest.advanceTimersByTimeAsync(200);
      // The app's own pause: the starved engine sends nothing (it does not play anyway).
      c.setPaused(true);
      harness.engine.play.mockClear();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(harness.engine.play).not.toHaveBeenCalled();
      expect(c.paused).toBe(true);
      expo.engine.release();
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    "AVPlayer stops itself twice in one stall: asked once to play again, the second stop is the ladder's (review 8 R02)",
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, expo } = await starved();
      await stopsItself(expo);
      await jest.advanceTimersByTimeAsync(600);
      expect(harness.engine.play).toHaveBeenCalledTimes(1);
      expo.player.setStatus('loading');
      expo.player.setStatus('readyToPlay');
      expo.replay();
      await jest.advanceTimersByTimeAsync(600);
      expect(harness.engine.play).toHaveBeenCalledTimes(1);
      expo.engine.release();
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    "in picture-in-picture or with the app inactive (Control Center, a call banner) AVPlayer's stop is not overridden (review 8 P2-1)",
    async () => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const handlers: ((state: string) => void)[] = [];
      jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
        handlers.push(handler as (state: string) => void);
        return { remove: () => undefined };
      });
      for (const situation of ['pip', 'inactive'] as const) {
        harness.reset();
        handlers.length = 0;
        const { c, expo } = await starved();
        if (situation === 'pip') harness.engine.emit({ type: 'pip', active: true });
        else handlers.forEach((handler) => handler('inactive'));
        await stopsItself(expo);
        await jest.advanceTimersByTimeAsync(1_000);
        expect(harness.engine.play).not.toHaveBeenCalled();
        expo.engine.release();
        await c.stop();
      }
      jest.restoreAllMocks();
      os.restore();
    }
  );

  row(
    'D19',
    'a real pause from the system during a stall (background) reads as that cause, stops the stall budget, and back the stall starts with a fresh budget (review 8 R04)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, subtitled, 47);
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      await jest.advanceTimersByTimeAsync(10_000);
      harness.engine.emit({ type: 'userPlayback', paused: true, cause: 'background' });
      expect(c.status.hint).toMatchObject({
        key: 'pausedBySystem',
        params: { cause: 'background' },
      });
      await jest.advanceTimersByTimeAsync(60_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      c.setPaused(false);
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      // 10 s of the old stall + 8 s of the new one: no step yet (the old budget would have run out).
      await jest.advanceTimersByTimeAsync(8_000);
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );

  row(
    'D19',
    'AVPlayer says paused first and starved right after: the stall that began within the adoption moment is never adopted as a pause',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, subtitled, 47);
      harness.engine.state('paused');
      await jest.advanceTimersByTimeAsync(300);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(SYSTEM_PAUSE_MS);
      expect(c.systemPaused).toBe(false);
      expect(c.paused).toBe(false);
      await c.stop();
    }
  );

  row(
    'D19',
    'a subtitle timeout the engine reports while the video is starved belongs to the stall: no notice, no failure counted',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, subtitled, 47);
      harness.engine.emit({ type: 'tracks', tracks: shown });
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      await jest.advanceTimersByTimeAsync(5_000);
      harness.engine.emit({ type: 'subtitleError', code: 'subtitle_timeout' });
      expect(c.notice).toBeNull();
      expect(c.currentSubtitle()).toBe(5);
      // While the video plays, a subtitle timeout is the subtitles' (C22).
      harness.engine.emit({ type: 'buffering', buffering: false });
      harness.engine.state('playing');
      harness.engine.time(harness.engine.getSnapshot().position + 0.5);
      harness.engine.emit({ type: 'subtitleError', code: 'subtitle_timeout' });
      expect(c.notice).toMatchObject({ kind: 'subtitleFailed', params: { retry: 'later' } });
      await c.stop();
    }
  );
});

describe('matrix D — S4x: the quiet subtitle try never costs the viewer their subtitles (review 8 P2-2, P3-2)', () => {
  const subtitled = {
    method: 'remux',
    mediaInfo: {
      durationTicks: 600 * TICKS,
      audioTracks: [],
      subtitleTracks: [{ index: 5, language: 'de', deliveredAs: 'webvtt', selected: true }],
    },
  } as never;
  const shown = {
    audio: [],
    subtitles: [{ id: 's0', label: 'de', language: 'de', selected: true }],
  };
  async function quietTry(over: object = subtitled) {
    jest.useFakeTimers();
    const c = await playing({}, over as never, 47);
    harness.engine.emit({ type: 'tracks', tracks: shown });
    harness.engine.emit({ type: 'buffering', buffering: true });
    harness.engine.state('buffering');
    await jest.advanceTimersByTimeAsync(16_000);
    expect(harness.engine.commands).toContain('subtitle:null');
    return c;
  }

  row(
    'D19',
    'paused during the quiet try while AVPlayer still starves (no engine event), then a seek: the clock moving at the new place is no "subtitles failed" (review 8 R08)',
    async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const c = await quietTry();
      c.setPaused(true);
      c.seekTo(120);
      harness.engine.time(120);
      harness.engine.time(121.5);
      expect(c.notice).toBeNull();
      expect(
        harness.engine.commands.filter((command) => command.startsWith('subtitle:')).at(-1)
      ).toBe('subtitle:s0');
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    "the server's 504 for the hanging segment after the quiet try: the reload at 0:47 brings the subtitles back (review 8 PROBE-4)",
    async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const c = await quietTry();
      harness.engine.emit({ type: 'loadRetry', status: 504, audio: false });
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(47);
      expect(
        harness.engine.commands.filter((command) => command.startsWith('subtitle:')).at(-1)
      ).toBe('subtitle:s0');
      expect(c.currentSubtitle()).toBe(5);
      expect(c.notice).toBeNull();
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    'an engine error during the quiet try: the step takes the viewer\'s subtitles (5), not "none"',
    async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const c = await quietTry();
      harness.engine.fail('ERROR_CODE_DECODER_INIT_FAILED: video/avc');
      await settle();
      expect(harness.engine.load.mock.calls.length + starts().length).toBeGreaterThan(2);
      // The reloaded item lists its tracks (subtitles still off): the step puts the viewer's back.
      harness.engine.emit({
        type: 'tracks',
        tracks: {
          audio: [],
          subtitles: [{ id: 's0', label: 'de', language: 'de', selected: false }],
        },
      });
      expect(c.currentSubtitle()).toBe(5);
      os.restore();
      await c.stop();
    }
  );

  it.each([
    ['an engine error', () => harness.engine.state('error')],
    ['a VLC reload of its own source', () => harness.engine.emit({ type: 'reload' })],
    [
      'the stream ending at the stall position (an early end)',
      () => harness.engine.emit({ type: 'ended' }),
    ],
  ])(
    'D19 %s during the quiet try ends the stall without the picture: no "subtitles failed" (review 9 M22)',
    async (_name, exit) => {
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const c = await quietTry();
      exit();
      await settle();
      expect(c.notice?.kind).not.toBe('subtitleFailed');
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    'the viewer pauses during the quiet try: no "subtitles failed", the subtitles come back (review 8 R08)',
    async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const c = await quietTry();
      c.setPaused(true);
      // The engine's order (readyToPlay while the app does not want to play): buffering over, then paused.
      harness.engine.emit({ type: 'buffering', buffering: false });
      harness.engine.state('paused');
      expect(c.notice).toBeNull();
      expect(c.currentSubtitle()).toBe(5);
      os.restore();
      await c.stop();
    }
  );

  row(
    'D19',
    'a subtitle AVPlayer shows that the server does not list: the quiet try turns it off and the stall still reaches the ladder (review 8 PROBE-5)',
    async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const c = await quietTry({
        method: 'remux',
        mediaInfo: { durationTicks: 600 * TICKS, audioTracks: [], subtitleTracks: [] },
      });
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(47);
      expect(
        harness.engine.commands.filter((command) => command.startsWith('subtitle:')).at(-1)
      ).toBe('subtitle:s0');
      os.restore();
      await c.stop();
    }
  );
});

describe('matrix D — S4v: a direct-play file names its own HTTP failure (S9c turn 2 VLC 503 / 401)', () => {
  const failed = (engine: 'vlc' | 'web', reason: string, status?: number) =>
    classify({ kind: 'engine', engine, reason, ...(status === undefined ? {} : { status }) });
  const mrl = "VLC is unable to open the MRL 'http://127.0.0.1:39300/api/v1/stream/tok'.";

  row(
    'D27',
    'VLC and web direct: 503/5xx is the server (T6 server_error), 401 the capability (T2 unauthorized), 404 the stream (T2 unknown_stream), never "unknown_transcode"',
    async () => {
      for (const engine of ['vlc', 'web'] as const) {
        expect(failed(engine, 'Player encountered an error', 503)).toMatchObject({
          category: 'T6',
          code: 'server_error',
        });
        expect(failed(engine, 'Player encountered an error', 500)).toMatchObject({
          code: 'server_error',
        });
        expect(failed(engine, 'Player encountered an error', 401)).toMatchObject({
          category: 'T2',
          code: 'unauthorized',
        });
        expect(failed(engine, 'Player encountered an error', 404)).toMatchObject({
          category: 'T2',
          code: 'unknown_stream',
        });
      }
      expect(failed('web', 'media_error_4', 416)).toMatchObject({ code: 'end_of_stream' });
      expect(failed('vlc', mrl)).toMatchObject({ category: 'T2', code: 'unknown_stream' });
      expect(failed('vlc', `${mrl} HTTP 503`)).toMatchObject({ code: 'server_error' });
      // HLS segments keep their own names.
      expect(failed('web', 'networkError:fragLoadError', 503)).toMatchObject({
        code: 'segment_unavailable',
      });
      // The controller: a 503 on VLC reloads with the server hint, not a new start.
      jest.useFakeTimers();
      const c = await playing({}, { method: 'direct', engine: 'vlc' } as never, 10);
      harness.engine.emit({ type: 'error', reason: 'Player encountered an error', status: 503 });
      await jest.advanceTimersByTimeAsync(0);
      expect(c.status.hint?.key).toBe('serverError');
      await c.stop();
    }
  );
});

describe('matrix D — S4w: one corrupt segment freezes AVPlayer, the subtitles keep failing (S9c turn 3 D20, iPhone)', () => {
  const forced = {
    method: 'remux',
    mediaInfo: {
      durationTicks: 600 * TICKS,
      audioTracks: [],
      subtitleTracks: [
        { index: 5, language: 'de', deliveredAs: 'webvtt', selected: true, forced: true },
      ],
    },
  } as never;
  const shown = {
    audio: [],
    subtitles: [{ id: 's0', label: 'de', language: 'de', selected: true }],
  };
  /** Frozen at 0:10 with the forced subtitle that AVPlayer keeps selected; `subtitleErrors` every 10 s from the engine. */
  async function frozen(subtitleErrors: boolean) {
    jest.useFakeTimers();
    const c = await playing({}, forced, 10);
    harness.engine.emit({ type: 'tracks', tracks: shown });
    harness.engine.emit({ type: 'buffering', buffering: true });
    harness.engine.state('buffering');
    const stalledAt = Date.now();
    for (let second = 1; second <= 90; second++) {
      // AVPlayer shows the forced subtitle whatever the app asks.
      harness.engine.emit({ type: 'tracks', tracks: shown });
      if (subtitleErrors && second % 10 === 0) {
        harness.engine.emit({ type: 'subtitleError', code: 'subtitle_unavailable' });
        harness.engine.emit({ type: 'subtitleError', code: 'subtitle_timeout' });
      }
      harness.engine.time(10);
      await jest.advanceTimersByTimeAsync(1_000);
      if (harness.engine.load.mock.calls.length > 1 || harness.server.sent('switch').length)
        return { c, after: Date.now() - stalledAt };
    }
    return { c, after: Infinity };
  }

  row(
    'D20',
    'the recorded cycle (buffering, "subtitles failed", buffering … every 15 s with the forced subtitle still on): an incident within the stall budget, reloading at 0:10',
    async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, after } = await frozen(false);
      expect(after).toBeLessThanOrEqual(31_000);
      expect(harness.engine.source?.startPosition).toBe(10);
      os.restore();
      await c.stop();
    }
  );

  row(
    'D20',
    'subtitle failures the engine keeps reporting during the stall give it one fresh budget at most, never one per failure',
    async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      const { c, after } = await frozen(true);
      expect(after).toBeLessThanOrEqual(31_000);
      os.restore();
      await c.stop();
    }
  );
});

describe('matrix D — S4y: a direct file that stays missing (V2 turn 2, GTV VLC 404)', () => {
  row(
    'D27',
    'VLC 404 after every automatic new start: the card says the file is missing on the server and offers another version and Back — never "start again", de and en',
    async () => {
      jest.useFakeTimers();
      const vlcDirect = { method: 'direct', engine: 'vlc' } as never;
      harness.server.answer(
        'start',
        ...Array.from({ length: 6 }, () => reply.ok(harness.server.playback(vlcDirect)))
      );
      const c = newController();
      await c.start();
      for (let attempt = 0; attempt < 6 && c.phase !== 'failed'; attempt++) {
        harness.engine.started();
        harness.engine.time(10);
        harness.engine.emit({ type: 'error', reason: 'Player encountered an error', status: 404 });
        await jest.advanceTimersByTimeAsync(2_000);
        await settle();
      }
      expect(c.phase).toBe('failed');
      expect(c.failure).toMatchObject({ code: 'stream_missing', category: 'T2' });
      expect(cardButtons(c.failure!.actions)).toEqual(['otherVersion', 'back']);
      expect(c.failure!.tried?.filter((attempt) => attempt.step === 'N').length).toBeGreaterThan(0);
      for (const [lang, title, wrong] of [
        ['en', 'Video file missing on the server', /Start playback again/],
        ['de', 'Videodatei fehlt auf dem Server', /Starte die Wiedergabe neu/],
      ] as const) {
        const text = describeError(i18n.getFixedT(lang), c.failure!);
        expect(text.title).toBe(title);
        expect(text.message).not.toMatch(wrong);
      }
      await c.stop();
    }
  );

  /** A source that answers `status` after every automatic new start (the review 10 probe). */
  async function refused(over: object, status: number, reason = 'Player encountered an error') {
    jest.useFakeTimers();
    harness.server.answer(
      'start',
      ...Array.from({ length: 8 }, () => reply.ok(harness.server.playback(over as never)))
    );
    const c = newController();
    await c.start();
    for (let attempt = 0; attempt < 8 && c.phase !== 'failed'; attempt++) {
      harness.engine.started();
      harness.engine.time(10);
      harness.engine.emit({ type: 'error', reason, status });
      await jest.advanceTimersByTimeAsync(2_000);
      await settle();
    }
    return c;
  }

  it.each([
    ['VLC direct 403', { method: 'direct', engine: 'vlc' }, 403, 'Player encountered an error'],
    ['VLC direct 401', { method: 'direct', engine: 'vlc' }, 401, 'Player encountered an error'],
    ['HLS remux 403', { method: 'remux' }, 403, 'networkError:fragLoadError'],
    ['transcode 401', { method: 'transcode' }, 401, 'networkError:fragLoadError'],
  ])(
    'D27 %s after every automatic new start: "No access to this video file" with Try again and another version — never "file missing" (review 10 P2-1)',
    async (_name, over, status, reason) => {
      const c = await refused(over, status, reason);
      expect(c.phase).toBe('failed');
      expect(c.failure?.code).not.toBe('stream_missing');
      expect(c.failure).toMatchObject({ code: 'stream_forbidden', category: 'T2' });
      expect(cardButtons(c.failure!.actions)).toEqual(['retry', 'otherVersion', 'back']);
      for (const [lang, title] of [
        ['en', 'No access to this video file'],
        ['de', 'Kein Zugriff auf die Videodatei'],
      ] as const)
        expect(describeError(i18n.getFixedT(lang), c.failure!).title).toBe(title);
      await c.stop();
    }
  );

  it('D27 an HLS remux 404 after the new starts keeps its own name (the server lost the stream), no "file missing"', async () => {
    const c = await refused({ method: 'remux' }, 404, 'networkError:fragLoadError');
    expect(c.failure?.code).not.toBe('stream_missing');
    expect(c.failure?.code).not.toBe('stream_forbidden');
    await c.stop();
  });

  row('D27', 'a single 404 still starts again at once (the lost capability, C01)', async () => {
    jest.useFakeTimers();
    const c = await playing({}, { method: 'direct', engine: 'vlc' } as never, 10);
    harness.engine.emit({ type: 'error', reason: 'Player encountered an error', status: 404 });
    await settle();
    expect(starts()).toHaveLength(2);
    expect(c.failure).toBeNull();
    await c.stop();
  });
});
