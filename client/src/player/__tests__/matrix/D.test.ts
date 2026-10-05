import type { EngineEvent } from '@/player/engines';
import { loadHls, WebEngine } from '@/player/engines/web-engine.web';
import { classify } from '@/player/recovery/classify';
import { AUDIO_SWITCH_TIMEOUT_MS } from '@/player/controller';
import i18n from '@/i18n';
import { harness, newController, reply } from '@/../jest/player/harness';
import { FakeHls, FakeVideoElement } from '@/../jest/player/library-fakes';
import { pending, row } from '@/../jest/player/matrix';
import type { ControllerOptions, PlaybackController } from '@/player/controller';
import type { Playback } from '@/player/playback-api';
import { fakeNetwork, playFor, playing, playOn, settle, TICKS } from '@/../jest/player/play';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());
jest.mock('hls.js', () => jest.requireActual('@/../jest/player/library-fakes').hlsJsModule());

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
const hd = {
  mediaInfo: {
    durationTicks: 600 * TICKS,
    audioTracks: [],
    subtitleTracks: [],
    video: { height: 1080 },
  },
} as never;

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
  pending(
    'D11',
    'Exo source errors (ERROR_CODE_IO_NETWORK_CONNECTION_FAILED/TIMEOUT, IO_BAD_HTTP_STATUS,…',
    'S6'
  );
  pending(
    'D12',
    'Exo decoder errors (DECODER_INIT_FAILED, DECODER_QUERY_FAILED, DECODING_FAILED, DECODIN…',
    'S6'
  );
  pending('D15', 'Exo stuck in STATE_BUFFERING (loader waits on a 90 s segment)', 'S6');
  pending('D16', 'Exo renders audio, video renderer has no track (unsupported → deselected)', 'S6');
  pending('D17', 'Exo MediaCodec reclaimed / released (other app, return from background)', 'S6');
  pending(
    'D18',
    'AVPlayer item failed (-11800, -11828, -11850, -12642 playlist parse, -12660/-12938 HTTP…',
    'S6'
  );
  pending(
    'D19',
    'AVPlayer stalled (playbackStalled, timeControlStatus = waitingToPlayAtSpecifiedRate, is…',
    'S6'
  );
  pending('D20', 'AVPlayer black picture while the clock runs (I1: frame 0 for ~45 s)', 'S6');
  pending(
    'D21',
    'AVPlayer picture without sound (unsupported/absent audio, passthrough route)',
    'S6'
  );
  pending('D22', 'VLC EncounteredError', 'S7');
  pending('D23', 'VLC never shows a picture (MediaCodec direct rendering, A1 of M3.1)', 'S7');
  pending('D24', 'VLC frozen picture with a running clock (after seek/load)', 'S7');
  pending('D25', 'VLC no audio (audio output failed, passthrough)', 'S7');
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
  pending('D27', 'VLC dialog request (onDialogDisplay: certificate, login, codec question)', 'S7');
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
  pending('D40', 'replaceAsync rejects', 'S6');
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
    'an in-session audio switch that never confirms: after its timeout the server switches, with the notice "Audio switched by restarting the stream"',
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
        'Audio switched by restarting the stream.'
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
