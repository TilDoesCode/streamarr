import { Platform } from 'react-native';

import { harness, newController, reply } from '@/../jest/player/harness';
import { row } from '@/../jest/player/matrix';
import { expoPlaying } from '@/../jest/player/native';
import { playFor, playing, playOn, settle, starts, TICKS } from '@/../jest/player/play';
import type { EngineHealth } from '@/player/health/types';
import { Incident, nextStep } from '@/player/recovery/ladder';
import { classify } from '@/player/recovery/classify';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());
jest.mock('expo-video', () =>
  jest.requireActual('@/../jest/player/library-fakes').expoVideoModule()
);

beforeEach(() => {
  harness.reset();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

const exo = (status: number) =>
  `Source error: InvalidResponseCodeException: Response code: ${status}`;
const hls = {
  method: 'remux',
  mediaInfo: { durationTicks: 600 * TICKS, audioTracks: [], subtitleTracks: [] },
} as never;

async function probed(over: unknown = {}) {
  harness.features.probe = true;
  return playing({}, over as never, 0);
}
const engineError = (reason: string, status?: number) =>
  harness.engine.emit({ type: 'error', reason, ...(status === undefined ? null : { status }) });
const blackFrom = (second: number) => ({
  position: second,
  health: { framesPresented: 0, audioProgress: second * 1000 },
});
const silentFrom = (second: number) => ({
  position: second,
  health: { framesPresented: second * 24, audioProgress: Math.min(second, 3) * 1000 },
});

/** What the real expo-video engine makes of the patched native probe (Exo counters / AVPlayer readings). */
async function nativeHealth(
  raw: Record<string, number | boolean | string | null>
): Promise<EngineHealth> {
  const expo = await expoPlaying();
  expo.player.health = raw;
  const health = await expo.engine.readHealth();
  expo.engine.release();
  return health;
}

/** The real expo-video engine's error event for a failed item, replayed into the controller. */
async function nativeFailure(error: Parameters<FakeExpoPlayerType['failWith']>[0]) {
  const expo = await expoPlaying();
  expo.player.failWith(error);
  const [event] = expo.of('error');
  expo.engine.release();
  harness.engine.emit(event!);
  return event!;
}
type FakeExpoPlayerType = import('@/../jest/player/library-fakes').FakeExpoPlayer;

const hd = () => ({
  mediaInfo: {
    durationTicks: 600 * TICKS,
    audioTracks: [],
    subtitleTracks: [],
    video: { height: 1080 },
  },
});

// State matrix layer C (docs/client/player/state-matrix.md § 1): one test per row id.

describe('matrix C — Delivery (server → engine)', () => {
  row(
    'C01',
    'an expired direct-play capability (404) starts anew at the position, no step-down',
    async () => {
      const c = await playing({}, {}, 0);
      harness.engine.time(240);
      harness.engine.fail(exo(404));
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(starts().at(-1)?.position).toBe(240);
      expect(harness.engine.source?.startPosition).toBe(240);
      expect(c.notice).toBeNull();
      await c.stop();
    }
  );
  row(
    'C02',
    'a direct-play range past the end (416) reloads once, then the card explains the short file',
    async () => {
      const c = await playing({}, {}, 0);
      harness.engine.time(900, 1200);
      harness.engine.fail(exo(416));
      await settle();
      expect(harness.engine.source?.startPosition).toBe(900);
      harness.engine.started(1200);
      harness.engine.fail(exo(416));
      await settle();
      expect(c.failure).toMatchObject({
        code: 'end_of_stream',
        category: 'T8',
        actions: ['otherVersion'],
      });
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );
  row(
    'C03',
    'throughput below the bitrate: spinner, then "Slow connection: 2 of 8 Mbit/s", then lower quality',
    async () => {
      const c = await probed({
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: [],
          subtitleTracks: [],
          bitrateKbps: 8_000,
          video: { height: 1080 },
        },
      });
      harness.engine.setHealth({ bandwidthBps: 2_000_000 });
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status).toMatchObject({ spinner: true, hint: null });
      await jest.advanceTimersByTimeAsync(3_000);
      expect(c.status.hint).toEqual({ key: 'slowNet', params: { measured: 2, needed: 8 } });
      await jest.advanceTimersByTimeAsync(11_000);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({
        preferences: expect.objectContaining({ maxHeight: 720 }),
      });
      await c.stop();
    }
  );
  row(
    'C03',
    'native engines: the Exo bandwidth meter / AVPlayer access log feed the same "Slow connection" hint',
    async () => {
      const health = await nativeHealth({ bandwidthBps: 2_000_000, framesPresented: 10 });
      expect(health).toMatchObject({ bandwidthBps: 2_000_000 });
      const c = await probed({
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: [],
          subtitleTracks: [],
          bitrateKbps: 8_000,
          video: { height: 1080 },
        },
      });
      harness.engine.setHealth(health);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(4_000);
      expect(c.status.hint).toEqual({ key: 'slowNet', params: { measured: 2, needed: 8 } });
      await c.stop();
    }
  );
  row(
    'C05',
    'a connection reset mid-transfer shows the spinner and never steps down while it recovers',
    async () => {
      const c = await playing({}, {}, 20);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(2_000);
      expect(c.status.spinner).toBe(true);
      harness.engine.emit({ type: 'buffering', buffering: false });
      harness.engine.time(harness.engine.getSnapshot().position + 0.5);
      expect(c.status.spinner).toBe(false);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );
  row(
    'C07',
    'a server conversion failure mid-play reloads after a pause, then starts anew, then steps down',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(100);
      harness.engine.fail(exo(500));
      expect(c.status.hint).toMatchObject({ key: 'serverError', params: { seconds: 5 } });
      await jest.advanceTimersByTimeAsync(5_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.fail(exo(500));
      await jest.advanceTimersByTimeAsync(15_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(3);
      harness.engine.fail(exo(500));
      await jest.advanceTimersByTimeAsync(5_000);
      expect(starts()).toHaveLength(2);
      harness.engine.fail(exo(500));
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({
        stepDown: true,
        positionTicks: 100 * TICKS,
      });
      await c.stop();
    }
  );
  row(
    'C08',
    'a transcode stall with nothing measured: "Loading takes longer" (never a guessed "converts slower", S9b2 C11), then lower quality',
    async () => {
      const c = await playing(
        {},
        {
          method: 'transcode',
          mediaInfo: {
            durationTicks: 600 * TICKS,
            audioTracks: [],
            subtitleTracks: [],
            video: { height: 1080 },
          },
        } as never,
        20
      );
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(4_000);
      expect(c.status.hint?.key).toBe('buffering');
      await jest.advanceTimersByTimeAsync(11_000);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({
        preferences: expect.objectContaining({ maxHeight: 720 }),
      });
      await c.stop();
    }
  );
  row(
    'C09',
    'a seek that never continues reloads at the target after 15 s before lowering quality',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(2_000, 3_600);
      c.seekTo(100);
      harness.engine.state('buffering');
      await jest.advanceTimersByTimeAsync(15_000);
      expect(harness.engine.source?.startPosition).toBe(100);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );
  row(
    'C10',
    'a playlist 404 (session closed on the server) starts anew silently (ExoPlayer/AVPlayer)',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(30);
      harness.engine.fail(exo(404));
      await settle();
      expect(starts().at(-1)?.position).toBe(30);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );
  row(
    'C10',
    'hls.js: a playlist 404 (with its status) starts anew silently, no step-down',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(30);
      engineError('networkError:levelLoadError', 404);
      await settle();
      expect(starts().at(-1)?.position).toBe(30);
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(c.notice).toBeNull();
      await c.stop();
    }
  );
  row(
    'C11',
    'a playlist 5xx reloads the same source after a backoff, never steps down first',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(12);
      harness.engine.fail(exo(502));
      await jest.advanceTimersByTimeAsync(4_999);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(12);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );
  row(
    'C12',
    'an endless playlist (clock stands, no stall reported): watchdog spinner, then the stall ladder',
    async () => {
      harness.features.probe = true;
      const c = await playing({}, hls, 0);
      await playFor(3, (second) => ({
        position: second,
        health: { framesPresented: second * 24 },
      }));
      await playFor(7, () => ({ health: { framesPresented: 72 } }), 3);
      expect(c.status.spinner).toBe(true);
      await jest.advanceTimersByTimeAsync(15_000);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      await c.stop();
    }
  );
  row('C13', 'a segment error within two segments of the end ends playback', async () => {
    const c = await playing({}, hls, 0);
    harness.engine.time(592, 600);
    harness.engine.fail(exo(404));
    await settle();
    expect(c.ended).toBe(true);
    expect(c.phase).toBe('playing');
    expect(starts()).toHaveLength(1);
    await c.stop();
  });
  row(
    'C14',
    "segment 503 shows the spinner and retries the same source with the server's Retry-After",
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(44);
      harness.engine.fail(exo(503));
      expect(c.status).toMatchObject({ spinner: true, hint: { key: 'serverError' } });
      await jest.advanceTimersByTimeAsync(5_000);
      expect(harness.engine.source?.startPosition).toBe(44);
      harness.engine.started();
      expect(c.status.hint).toBeNull();
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );
  row('C15', 'segment 410 session_closed starts anew at the position', async () => {
    const c = await playing({}, hls, 0);
    harness.engine.time(61);
    harness.engine.fail(exo(410));
    expect(c.status.hint).toMatchObject({ key: 'restarting', params: { time: '1:01' } });
    await settle();
    expect(starts().at(-1)?.position).toBe(61);
    await c.stop();
  });
  row(
    'C16',
    'a truncated segment: spinner while hls.js retries, a parse error then reloads at the position',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(50);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(2_000);
      expect(c.status.spinner).toBe(true);
      engineError('mediaError:fragParsingError');
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(50);
      await c.stop();
    }
  );
  row(
    'C17',
    'a corrupt segment past the engine budget: reload once, then another way to play',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(80);
      engineError('mediaError:bufferAppendError');
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started();
      engineError('mediaError:bufferAppendError');
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({
        stepDown: true,
        positionTicks: 80 * TICKS,
      });
      await c.stop();
    }
  );
  row(
    'C18',
    'a hard stall at a timestamp discontinuity is caught as a frozen clock (spinner)',
    async () => {
      harness.features.probe = true;
      const c = await playing({}, hls, 0);
      await playFor(3, (second) => ({
        position: second,
        health: { framesPresented: second * 24 },
      }));
      expect(c.status.spinner).toBe(false);
      await playFor(7, () => ({ health: { framesPresented: 72 } }), 3);
      expect(c.status.spinner).toBe(true);
      await c.stop();
    }
  );
  row(
    'C20',
    'an audio rendition that dies mid-play: "No sound", reload (re-selects the rendition), audio conversion, then another way',
    async () => {
      const c = await probed(hls);
      await playFor(7, silentFrom);
      expect(c.status.hint?.key).toBe('noAudio');
      await playFor(4, silentFrom, 7);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started();
      await playFor(12, silentFrom, 0);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ audioFallback: true });
      expect(c.playback?.audioFallback).toBe(true);
      // Still silent with converted audio: one reload of the new revision, then another way to play.
      for (let round = 0; round < 2; round += 1) {
        harness.engine.started();
        await playFor(12, silentFrom, 0);
        await settle();
      }
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      expect(harness.server.sent('switch').filter((r) => r.body?.audioFallback)).toHaveLength(1);
      await c.stop();
    }
  );
  row(
    'C21',
    'init/media playlist missing (503 init_unavailable): reload after a pause, then a new start',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(10);
      engineError('networkError:fragLoadError', 503);
      expect(c.status.hint?.key).toBe('serverError');
      await jest.advanceTimersByTimeAsync(5_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );
  row(
    'C25',
    'AVPlayer rejects a playlist/segment of the wrong type (-12642/-11850): server problem, reload — no step-down',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(30);
      const event = await nativeFailure({
        message: 'The operation couldn’t be completed.',
        domain: 'AVFoundationErrorDomain',
        code: -11800,
        underlyingDomain: 'CoreMediaErrorDomain',
        underlyingCode: -12642,
      });
      expect(classify({ kind: 'engine', engine: 'expo-video', ...event })).toMatchObject({
        category: 'T6',
        code: 'unexpected_format',
      });
      expect(
        classify({
          kind: 'engine',
          engine: 'expo-video',
          reason: 'AVFoundationErrorDomain -11850: Operation Stopped',
        })
      ).toMatchObject({ category: 'T6' });
      expect(c.status.hint?.key).toBe('serverError');
      await jest.advanceTimersByTimeAsync(30_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(30);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );
  row(
    'C26',
    'AVPlayer -12927 (HDR tag mismatch): kept in the log, reload, then "This device can\'t play HDR. Trying another way to play…"',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(30);
      await nativeFailure({
        message: 'Cannot Decode',
        domain: 'AVFoundationErrorDomain',
        code: -11821,
        underlyingDomain: 'CoreMediaErrorDomain',
        underlyingCode: -12927,
      });
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started();
      await nativeFailure({
        message: 'Cannot Decode',
        domain: 'AVFoundationErrorDomain',
        code: -11821,
        underlyingDomain: 'CoreMediaErrorDomain',
        underlyingCode: -12927,
      });
      expect(c.status.hint).toMatchObject({ key: 'decoder', params: { format: 'HDR' } });
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      await c.stop();
    }
  );
  row(
    'C27',
    'web: an audio codec the browser cannot decode (counter stands): "No sound", reload, the server converts the audio',
    async () => {
      const c = await probed();
      await playFor(11, silentFrom);
      harness.engine.started();
      await playFor(12, silentFrom, 0);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ audioFallback: true });
      expect(c.notice?.kind).toBe('audioFallback');
      await c.stop();
    }
  );
  row(
    'C27',
    'native: an Exo audio renderer that renders nothing (counter stands) is "No sound" like the web',
    async () => {
      const at = (second: number) =>
        nativeHealth({ framesPresented: second * 24, audioProgress: Math.min(second, 3) * 40 });
      const c = await probed();
      for (let second = 1; second <= 7; second++) {
        harness.engine.setHealth(await at(second));
        harness.engine.time(second);
        await jest.advanceTimersByTimeAsync(1_000);
      }
      expect(c.status.hint?.key).toBe('noAudio');
      await c.stop();
    }
  );
  row(
    'C28',
    'web: a video codec without decoder (black, clock runs): "No picture", reload, then another way',
    async () => {
      const c = await probed();
      await playFor(6, blackFrom);
      expect(c.status.hint?.key).toBe('noPicture');
      await playFor(3, blackFrom, 6);
      harness.engine.started();
      await playFor(10, blackFrom, 2);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      await c.stop();
    }
  );
  row(
    'C28',
    'native: no rendered video buffer (Exo) / not ready for display (AVPlayer) is "No picture"',
    async () => {
      // Exo deselected the video track: no video decoder, zero frames although the server has video.
      await expect(
        nativeHealth({
          hasVideoTrack: false,
          hasAudioTrack: true,
          framesPresented: 0,
          audioProgress: 5,
        })
      ).resolves.toMatchObject({ framesPresented: 0, hasVideoTrack: false });
      await expect(nativeHealth({ readyForDisplay: false, framesPresented: 0 })).resolves.toEqual({
        readyForDisplay: false,
        framesPresented: 0,
      });
      const c = await probed({ ...hd() });
      for (let second = 1; second <= 6; second++) {
        harness.engine.setHealth({
          framesPresented: 0,
          hasVideoTrack: false,
          audioProgress: second,
        });
        harness.engine.time(second);
        await jest.advanceTimersByTimeAsync(1_000);
      }
      expect(c.status.hint?.key).toBe('noPicture');
      await c.stop();
    }
  );
  row(
    'C29',
    'a resolution beyond the decoder (most frames dropped): the quality goes down',
    async () => {
      const c = await probed({
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: [],
          subtitleTracks: [],
          video: { height: 2160 },
        },
      });
      await playFor(15, (second) => ({
        position: second,
        health: {
          framesPresented: second * 6,
          framesDropped: second * 18,
          audioProgress: second * 1000,
        },
      }));
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({
        preferences: expect.objectContaining({ maxHeight: 1080 }),
      });
      await c.stop();
    }
  );
  row(
    'C32',
    'a stream that ends early reloads once at the position, then says where the file ends',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(300, 600);
      harness.engine.emit({ type: 'ended' });
      expect(c.ended).toBe(false);
      await settle();
      expect(harness.engine.source?.startPosition).toBe(300);
      harness.engine.started();
      harness.engine.time(302, 600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.failure).toMatchObject({
        code: 'end_of_stream',
        hint: { key: 'endedEarly', params: { time: '5:02', missing: '4:58' } },
      });
      expect(c.failure?.tried).toEqual([expect.objectContaining({ step: 'R', position: 300 })]);
      await c.stop();
    }
  );
  row('C32', 'playToEnd while a new source loads is not an early end', async () => {
    const c = await playing({}, hls, 0);
    harness.engine.time(300, 600);
    await c.setQuality(720);
    harness.engine.emit({ type: 'ended' });
    await settle();
    expect(c.failure).toBeNull();
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    await c.stop();
  });
});

describe('matrix C — code review S1-S4 (S4b)', () => {
  const decode = 'MediaCodecVideoRenderer error: decoder init failed';

  row(
    'C32',
    'a reloaded short file that ends again before any time event is explained, not a frozen frame (review P5)',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(300, 600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(harness.engine.source?.startPosition).toBe(300);
      harness.engine.emit({ type: 'firstFrame' });
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.phase).toBe('failed');
      expect(c.failure).toMatchObject({
        code: 'end_of_stream',
        hint: { key: 'endedEarly', params: { time: '5:00', missing: '5:00' } },
      });
    }
  );

  row(
    'C32',
    'playToEnd after a user switch, with a picture but before the start position, is not an early end (review M05)',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(300, 600);
      await c.setQuality(720);
      harness.engine.emit({ type: 'firstFrame' });
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.failure).toBeNull();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await c.stop();
    }
  );

  row('C07', 'a reload keeps the audio the viewer picked in the engine (review P4)', async () => {
    const audioTracks = [
      { index: 1, language: 'en', deliveredAs: 'original', selected: true },
      { index: 2, language: 'de', deliveredAs: 'original', selected: false },
    ];
    const c = await playing(
      {},
      { mediaInfo: { durationTicks: 6e9, audioTracks, subtitleTracks: [] } } as never,
      100
    );
    const tracks = (selected: number) => ({
      audio: [
        { id: 'a0', label: 'en', language: 'en', selected: selected === 0 },
        { id: 'a1', label: 'de', language: 'de', selected: selected === 1 },
      ],
      subtitles: [],
    });
    harness.engine.emit({ type: 'tracks', tracks: tracks(0) });
    await c.selectAudio(audioTracks[1] as never);
    expect(c.currentAudio()).toBe(2);
    harness.engine.time(120);
    harness.engine.fail(decode);
    await settle();
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    // The new source lists its tracks with the server's default selected.
    harness.engine.emit({ type: 'tracks', tracks: tracks(0) });
    expect(c.currentAudio()).toBe(2);
    await c.stop();
  });

  row(
    'C07',
    'a reload keeps the subtitle the viewer picked in the engine (review P10)',
    async () => {
      const subtitleTracks = [
        { index: 3, language: 'en', deliveredAs: 'webvtt', selected: false },
        { index: 4, language: 'de', deliveredAs: 'webvtt', selected: false },
      ];
      const c = await playing(
        {},
        { mediaInfo: { durationTicks: 6e9, audioTracks: [], subtitleTracks } } as never,
        100
      );
      const tracks = (selected: number) => ({
        audio: [],
        subtitles: [
          { id: 's0', label: 'en', language: 'en', selected: selected === 0 },
          { id: 's1', label: 'de', language: 'de', selected: selected === 1 },
        ],
      });
      harness.engine.emit({ type: 'tracks', tracks: tracks(-1) });
      await c.selectSubtitle(subtitleTracks[1] as never);
      expect(c.currentSubtitle()).toBe(4);
      harness.engine.fail(decode);
      await settle();
      harness.engine.emit({ type: 'tracks', tracks: tracks(-1) });
      expect(c.currentSubtitle()).toBe(4);
      await c.stop();
    }
  );

  row(
    'C10',
    'a new start (session gone) keeps the audio and subtitle the viewer picked in the engine',
    async () => {
      const audioTracks = [
        { index: 1, language: 'en', deliveredAs: 'original', selected: true },
        { index: 2, language: 'de', deliveredAs: 'original', selected: false },
      ];
      const c = await playing(
        {},
        { mediaInfo: { durationTicks: 6e9, audioTracks, subtitleTracks: [] } } as never,
        100
      );
      harness.engine.emit({
        type: 'tracks',
        tracks: {
          audio: [
            { id: 'a0', label: 'en', selected: true },
            { id: 'a1', label: 'de', selected: false },
          ],
          subtitles: [],
        },
      });
      await c.selectAudio(audioTracks[1] as never);
      harness.engine.fail(exo(404));
      await settle();
      expect(starts().at(-1)?.body).toMatchObject({ audioStreamIndex: 2, subtitleStreamIndex: -1 });
      await c.stop();
    }
  );

  row(
    'C14',
    'a user switch during a pending reload replaces it: no jump back to the old position (review P8)',
    async () => {
      const c = await playing({}, {}, 100);
      harness.engine.fail(exo(503));
      await settle();
      expect(c.status.hint).toMatchObject({ key: 'serverError' });
      harness.engine.time(100);
      expect(await c.setQuality(720)).toBe(true);
      harness.engine.started();
      harness.engine.time(130);
      await jest.advanceTimersByTimeAsync(6_000);
      expect(harness.engine.sources).toHaveLength(2);
      expect(c.status.hint).toBeNull();
      await c.stop();
    }
  );

  row(
    'C14',
    'repeated errors while a reload waits are absorbed: one reload, on time (review M22)',
    async () => {
      const c = await playing({}, hls, 40);
      harness.engine.fail(exo(503));
      await jest.advanceTimersByTimeAsync(2_000);
      harness.engine.fail(exo(503));
      harness.engine.fail(exo(503));
      await jest.advanceTimersByTimeAsync(3_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await c.stop();
    }
  );

  row(
    'C03',
    'stalls lower the quality twice, then try another way to play (review M01)',
    async () => {
      const c = await playing(
        {},
        {
          method: 'transcode',
          mediaInfo: {
            durationTicks: 6e9,
            audioTracks: [],
            subtitleTracks: [],
            video: { height: 2160 },
          },
        } as never,
        100
      );
      for (let stall = 0; stall < 3; stall += 1) {
        harness.engine.started();
        harness.engine.emit({ type: 'buffering', buffering: true });
        await jest.advanceTimersByTimeAsync(16_000);
      }
      expect(harness.server.sent('switch').map((request) => request.body)).toEqual([
        expect.objectContaining({ preferences: expect.objectContaining({ maxHeight: 1080 }) }),
        expect.objectContaining({ preferences: expect.objectContaining({ maxHeight: 720 }) }),
        expect.objectContaining({ stepDown: true }),
      ]);
      await c.stop();
    }
  );

  row(
    'C03',
    'while the quality goes down on its own the hint offers no button, and Lower quality is refused (review P8)',
    async () => {
      const c = await playing(
        {},
        {
          method: 'transcode',
          mediaInfo: {
            durationTicks: 6e9,
            audioTracks: [],
            subtitleTracks: [],
            video: { height: 2160 },
          },
        } as never,
        100
      );
      const answer = new Promise<void>((resolve) => {
        harness.server.answer('switch', () => {
          resolve();
          return reply.ok(
            harness.server.playback({
              playbackId: c.playback!.playbackId!,
              state: 'starting',
              revision: 1,
              pollAfterMs: 5_000,
            } as never)
          );
        });
      });
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(16_000);
      await answer;
      expect(c.phase).toBe('switching');
      expect(await c.lowerQuality()).toBe(false);
      expect(harness.server.sent('switch')).toHaveLength(1);
      await c.stop();
    }
  );
});

describe('matrix C — subtitles and content edge cases (S8)', () => {
  const subtitled = {
    method: 'remux',
    mediaInfo: {
      durationTicks: 600 * TICKS,
      audioTracks: [],
      subtitleTracks: [
        { index: 3, language: 'de', deliveredAs: 'webvtt', selected: true },
        { index: 4, language: 'en', deliveredAs: 'webvtt', selected: false },
      ],
    },
  } as never;
  const engineSubtitles = (selected: string | null) => ({
    audio: [],
    subtitles: [
      { id: 's0', label: 'de', language: 'de', selected: selected === 's0' },
      { id: 's1', label: 'en', language: 'en', selected: selected === 's1' },
    ],
  });

  async function withSubtitles() {
    const c = await playing({}, subtitled, 50);
    harness.engine.emit({ type: 'tracks', tracks: engineSubtitles('s0') });
    await playOn(16);
    expect(c.currentSubtitle()).toBe(3);
    return c;
  }
  const subtitleCommands = () =>
    harness.engine.commands.filter((command) => command.startsWith('subtitle:'));

  row(
    'C22',
    'a subtitle segment that fails: subtitles off with a notice, playback goes on, one retry a minute later',
    async () => {
      const c = await withSubtitles();
      harness.engine.emit({ type: 'subtitleError', code: 'unknown_subtitle_stream' });
      harness.engine.emit({ type: 'subtitleError', code: 'unknown_subtitle_stream' });
      expect(c.currentSubtitle()).toBeNull();
      expect(c.notice).toMatchObject({
        kind: 'subtitleFailed',
        params: { index: '3', retry: 'later' },
      });
      expect(c.phase).toBe('playing');
      expect(c.status.hint).toBeNull();
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      await playOn(60);
      expect(subtitleCommands().at(-1)).toBe('subtitle:s0');
      expect(c.currentSubtitle()).toBe(3);
      await c.stop();
    }
  );
  row(
    'C22',
    'Exo/AVPlayer: a subtitle request that fails (404, retried by the player) gives one notice and the subtitles go off (S9b)',
    async () => {
      const c = await withSubtitles();
      const expo = await expoPlaying();
      for (let segment = 11; segment < 15; segment++)
        expo.player.loadError({
          uri: `http://server/api/v1/transcode/tok/subtitles/5/${segment}.vtt`,
          trackType: 'text',
          status: 404,
        });
      expect(expo.of('subtitleError')).toEqual([
        { type: 'subtitleError', code: 'unknown_subtitle_stream' },
      ]);
      // AVPlayer's error log names no track type: the URL says it is a subtitle.
      expo.player.loadError({
        uri: 'http://server/api/v1/transcode/tok/subtitles/6/3.vtt',
        status: 503,
      });
      expect(expo.of('subtitleError').at(-1)).toEqual({
        type: 'subtitleError',
        code: 'subtitle_unavailable',
      });
      // AVPlayer's note about a segment above the variant's bandwidth (seen live, S6t) is no failed request.
      const before = expo.events.length;
      expo.player.loadError({
        uri: 'http://server/api/v1/transcode/tok/audio/1/0.m4s',
        domain: 'CoreMediaErrorDomain',
        code: -12318,
        comment: 'Segment exceeds specified bandwidth for variant',
      } as never);
      expect(expo.events.length).toBe(before);
      // Audio and video requests the player retries are retries, not subtitles.
      expo.player.loadError({
        uri: 'http://server/api/v1/transcode/tok/audio/1/9.m4s',
        status: 503,
      });
      expect(expo.of('loadRetry').at(-1)).toEqual({ type: 'loadRetry', status: 503, audio: true });
      expo.replay();
      expect(c.currentSubtitle()).toBeNull();
      expect(c.notice).toMatchObject({ kind: 'subtitleFailed' });
      expect(c.phase).toBe('playing');
      expo.engine.release();
      await c.stop();
    }
  );

  row('C22', 'subtitles that fail again after the retry stay off for good', async () => {
    const c = await withSubtitles();
    harness.engine.emit({ type: 'subtitleError', code: 'subtitle_timeout' });
    await playOn(60);
    harness.engine.emit({ type: 'subtitleError', code: 'subtitle_timeout' });
    expect(c.notice).toMatchObject({ kind: 'subtitleFailed', params: { retry: '' } });
    const commands = subtitleCommands().length;
    await playOn(300);
    expect(subtitleCommands()).toHaveLength(commands);
    expect(c.currentSubtitle()).toBeNull();
    expect(harness.server.sent('switch')).toHaveLength(0);
    await c.stop();
  });

  row(
    'C22',
    'the viewer picking other subtitles cancels the retry; no subtitle shown means nothing to do',
    async () => {
      const c = await withSubtitles();
      harness.engine.emit({ type: 'subtitleError', code: 'subtitle_unavailable' });
      await c.selectSubtitle({ index: 4, language: 'en', deliveredAs: 'webvtt' } as never);
      expect(c.currentSubtitle()).toBe(4);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(c.currentSubtitle()).toBe(4);
      await c.selectSubtitle(null);
      const notice = c.notice;
      harness.engine.emit({ type: 'subtitleError', code: 'subtitle_unavailable' });
      expect(c.notice).toBe(notice);
      await c.stop();
    }
  );

  row(
    'C22',
    'a subtitle failure right after the load is not undone by the server track pick',
    async () => {
      const c = await playing({}, subtitled, 50);
      harness.engine.emit({ type: 'tracks', tracks: engineSubtitles('s0') });
      harness.engine.emit({ type: 'subtitleError', code: 'subtitle_unavailable' });
      harness.engine.emit({ type: 'tracks', tracks: engineSubtitles(null) });
      await jest.advanceTimersByTimeAsync(10_000);
      expect(c.currentSubtitle()).toBeNull();
      expect(subtitleCommands().at(-1)).toBe('subtitle:null');
      await c.stop();
    }
  );

  row(
    'C22',
    'subtitles the server picked after a new start win over the retry of the failed ones',
    async () => {
      const c = await withSubtitles();
      harness.engine.emit({ type: 'subtitleError', code: 'subtitle_unavailable' });
      // The new playback comes with the English subtitles selected by the server.
      harness.server.answer(
        'start',
        reply.ok(
          harness.server.playback({
            method: 'remux',
            mediaInfo: {
              durationTicks: 600 * TICKS,
              audioTracks: [],
              subtitleTracks: [
                { index: 3, language: 'de', deliveredAs: 'webvtt', selected: false },
                { index: 4, language: 'en', deliveredAs: 'webvtt', selected: true },
              ],
            },
          } as never)
        )
      );
      harness.engine.fail(exo(404));
      await settle();
      harness.engine.started();
      harness.engine.emit({ type: 'tracks', tracks: engineSubtitles('s1') });
      const commands = subtitleCommands().length;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(subtitleCommands()).toHaveLength(commands);
      expect(c.currentSubtitle()).toBe(4);
      await c.stop();
    }
  );

  row(
    'C22',
    'another version drops the retry of the failed subtitles (indexes belong to a release)',
    async () => {
      const c = await withSubtitles();
      harness.engine.emit({ type: 'subtitleError', code: 'subtitle_unavailable' });
      harness.server.answer(
        'switch',
        reply.ok(
          harness.server.playback({
            playbackId: c.playback!.playbackId!,
            revision: 1,
            version: { releaseId: 'r2' },
            mediaInfo: {
              durationTicks: 600 * TICKS,
              audioTracks: [],
              subtitleTracks: [
                { index: 3, language: 'fr', deliveredAs: 'webvtt', selected: false },
              ],
            },
          } as never)
        )
      );
      await c.selectVersion('r2');
      harness.engine.started();
      harness.engine.emit({ type: 'tracks', tracks: engineSubtitles(null) });
      const commands = subtitleCommands().length;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(subtitleCommands()).toHaveLength(commands);
      await c.stop();
    }
  );

  row(
    'C23',
    'a WebVTT segment that does not parse is a subtitle failure, never an engine error',
    async () => {
      const c = await withSubtitles();
      harness.engine.emit({ type: 'subtitleError', code: 'subtitle_unreadable' });
      expect(c.notice).toMatchObject({
        kind: 'subtitleFailed',
        params: { code: 'subtitle_unreadable' },
      });
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );

  row(
    'C24',
    'a selected subtitle the server cannot deliver is said at once, with VLC when the device has it',
    async () => {
      const undeliverable = {
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: [],
          subtitleTracks: [{ index: 5, language: 'ja', deliveredAs: 'none', selected: true }],
        },
      } as never;
      let c = await playing(
        { profile: { engines: [{ engine: 'vlc' }] } as never },
        undeliverable,
        0
      );
      expect(c.notice).toMatchObject({
        kind: 'subtitleNotDeliverable',
        params: { index: '5', vlc: 'vlc' },
      });
      await c.stop();
      harness.reset();
      c = await playing({}, undeliverable, 0);
      expect(c.notice).toMatchObject({ kind: 'subtitleNotDeliverable', params: { vlc: '' } });
      c.dismissNotice();
      harness.engine.fail(exo(503));
      await jest.advanceTimersByTimeAsync(5_000);
      expect(c.notice).toBeNull();
      await c.stop();
    }
  );

  row(
    'C30',
    'encrypted media: reload once, then another version, else the card with Other version; never a step-down',
    async () => {
      const c = await playing({}, {}, 30);
      harness.engine.fail('keySystemError:keySystemNoKeys');
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started();
      harness.engine.fail('keySystemError:keySystemNoKeys');
      await settle();
      expect(harness.server.sent('versions')).toHaveLength(1);
      expect(c.failure).toMatchObject({ code: 'encrypted_media', category: 'T8' });
      expect(c.failure?.actions).toContain('otherVersion');
      expect(harness.server.sent('switch')).toHaveLength(0);
    }
  );

  row(
    'C31',
    'a zero-length file (ends without a picture) is explained after a reload and a version search, never "ended"',
    async () => {
      const c = newController();
      await c.start();
      await jest.advanceTimersByTimeAsync(1_000);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.ended).toBe(false);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1_000);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.failure).toMatchObject({
        code: 'empty_media',
        category: 'T8',
        actions: ['otherVersion'],
      });
      expect(c.ended).toBe(false);
    }
  );

  row(
    'C31',
    'a file under a second long is not "ended" either; a playToEnd right after a load is ignored',
    async () => {
      let c = await playing({}, {}, 0);
      harness.engine.started(0.5);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.ended).toBe(false);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await c.stop();
      harness.reset();
      c = newController();
      await c.start();
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );
});

describe('matrix C — code review S5 + S4b (S4d)', () => {
  row(
    'C14',
    'a seek while a reload waits moves the reload to the new position (review B4)',
    async () => {
      const c = await playing({}, {}, 100);
      harness.engine.fail(exo(503));
      await settle();
      c.seekTo(400);
      expect(c.status.hint?.params?.time).toBe('6:40');
      await jest.advanceTimersByTimeAsync(6_000);
      expect(harness.engine.source?.startPosition).toBe(400);
      await c.stop();
    }
  );

  row(
    'C14',
    'a stall while hls.js retries a 503 is the server, not the bandwidth: reload, not lower quality (review R7)',
    async () => {
      const c = await playing(
        {},
        {
          method: 'remux',
          mediaInfo: {
            durationTicks: 600 * TICKS,
            audioTracks: [],
            subtitleTracks: [],
            video: { height: 1080 },
          },
        } as never,
        100
      );
      harness.engine.emit({ type: 'loadRetry', status: 503 });
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(15_000);
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(c.status.hint).toMatchObject({ key: 'serverError' });
      await jest.advanceTimersByTimeAsync(5_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await c.stop();
    }
  );

  row(
    'C13',
    'a stall in the last seconds ends the title instead of lowering the quality or stepping down (review B3)',
    async () => {
      const c = await playing({}, {}, 0);
      harness.engine.time(596, 600);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(c.ended).toBe(true);
      await c.stop();
    }
  );

  row(
    'C07',
    'a chained step keeps the tracks captured at the failure, even when the reloaded engine forgot them (review K15)',
    async () => {
      const audioTracks = [
        { index: 1, language: 'en', deliveredAs: 'original', selected: true },
        { index: 2, language: 'de', deliveredAs: 'original', selected: false },
      ];
      const c = await playing(
        {},
        { mediaInfo: { durationTicks: 6e9, audioTracks, subtitleTracks: [] } } as never,
        100
      );
      const tracks = (selected: number) => ({
        audio: [
          { id: 'a0', label: 'en', language: 'en', selected: selected === 0 },
          { id: 'a1', label: 'de', language: 'de', selected: selected === 1 },
        ],
        subtitles: [],
      });
      harness.engine.emit({ type: 'tracks', tracks: tracks(0) });
      await c.selectAudio(audioTracks[1] as never);
      harness.engine.emit({ type: 'tracks', tracks: tracks(1) });
      harness.engine.time(120);
      const decode = 'MediaCodecVideoRenderer error: decoder init failed';
      harness.engine.fail(decode);
      await settle();
      harness.engine.emit({ type: 'tracks', tracks: { audio: [], subtitles: [] } });
      harness.engine.fail(decode);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({
        stepDown: true,
        audioStreamIndex: 2,
      });
      await c.stop();
    }
  );
});

describe('matrix C — live web audit S9a (S4d)', () => {
  const remux = {
    method: 'remux',
    mediaInfo: {
      durationTicks: 600 * TICKS,
      audioTracks: [],
      subtitleTracks: [],
      video: { height: 1080 },
    },
  } as never;

  row(
    'C14',
    'while hls.js retries a 503 the stall says "problem on the server" at once, never "buffering" with Lower quality (S9a C10)',
    async () => {
      const c = await playing({}, remux, 30);
      harness.engine.emit({ type: 'loadRetry', status: 503 });
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status).toEqual({ spinner: true, hint: { key: 'serverRetrying' }, actions: [] });
      await c.stop();
    }
  );

  row(
    'C08',
    'a transcode whose segments wait for the server is "the server converts slower", not a slow connection (S9a C08)',
    async () => {
      harness.features.probe = true;
      const c = await playing(
        {},
        {
          ...(remux as object),
          method: 'transcode',
          mediaInfo: {
            durationTicks: 600 * TICKS,
            audioTracks: [],
            subtitleTracks: [],
            bitrateKbps: 2_200,
            video: { height: 1080 },
          },
        } as never,
        10
      );
      harness.engine.setHealth({
        bandwidthBps: 600_000,
        fetch: { waitMs: 5_400, transferMs: 300, bytes: 1_000_000 },
      });
      await jest.advanceTimersByTimeAsync(1_000);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(4_000);
      expect(c.status.hint).toEqual({ key: 'serverSlow' });
      await c.stop();
    }
  );

  row(
    'C03',
    'a remux segment that arrives slowly after a quick first byte is the network: measured from the transfer (S9a C03 kept)',
    async () => {
      harness.features.probe = true;
      const c = await playing(
        {},
        {
          ...(remux as object),
          mediaInfo: {
            durationTicks: 600 * TICKS,
            audioTracks: [],
            subtitleTracks: [],
            bitrateKbps: 700,
            video: { height: 1080 },
          },
        } as never,
        10
      );
      harness.engine.setHealth({ fetch: { waitMs: 50, transferMs: 8_000, bytes: 200_000 } });
      await jest.advanceTimersByTimeAsync(1_000);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(4_000);
      expect(c.status.hint).toEqual({ key: 'slowNet', params: { measured: 0.2, needed: 0.7 } });
      await c.stop();
    }
  );

  row(
    'C20',
    'an aborted audio split: "No sound", reload of the audio, the server converts the audio, then the card — never the network loop (S9a D36)',
    async () => {
      const c = await playing({}, remux, 40);
      const keys: string[] = [];
      const seen = () => {
        const key = c.status.hint?.key;
        if (key && keys.at(-1) !== key) keys.push(key);
      };
      harness.engine.emit({ type: 'loadRetry', status: 0, audio: true });
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(1_000);
      // Said at once, before hls.js gives up (no 4 s "buffering" first).
      expect(c.status).toEqual({
        spinner: true,
        hint: { key: 'noAudio' },
        actions: ['otherAudio'],
      });
      seen();
      harness.engine.fail('audioRendition:fragLoadError');
      await settle();
      seen();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started();
      harness.engine.fail('audioRendition:fragLoadError');
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ audioFallback: true });
      harness.engine.started();
      harness.engine.fail('audioRendition:fragLoadError');
      await settle();
      expect(c.phase).toBe('failed');
      expect(c.failure).toMatchObject({
        code: 'audio_rendition_failed',
        actions: ['retry', 'otherVersion'],
      });
      expect(keys[0]).toBe('noAudio');
      expect(harness.server.sent('switch').some((r) => r.body?.stepDown)).toBe(false);
    }
  );
});

describe('matrix C — the countdown is the wait the player really uses (S9a P8, B13b)', () => {
  row(
    'C14',
    'an hls.js fragment 503 (its Retry-After is not readable): the fixed 5 s, shown as 5 s',
    async () => {
      const c = await playing({}, { method: 'remux' } as never, 41);
      harness.engine.emit({ type: 'error', reason: 'networkError:fragLoadError', status: 503 });
      await settle();
      expect(c.status.hint).toMatchObject({ key: 'serverError', params: { seconds: 5 } });
      await jest.advanceTimersByTimeAsync(4_900);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(200);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await c.stop();
    }
  );

  row(
    'C14',
    'a request the app sends itself (a new start) answered 503 Retry-After 10: shown and waited as 10 s',
    async () => {
      const c = await playing({}, { method: 'remux' } as never, 41);
      harness.server.answer('start', reply.error(503, 'transcode_capacity', undefined, 10));
      harness.engine.fail('Source error: InvalidResponseCodeException: Response code: 404');
      await settle();
      expect(c.status.hint).toMatchObject({ params: { seconds: 10 } });
      await jest.advanceTimersByTimeAsync(9_900);
      expect(harness.server.sent('start')).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(200);
      expect(harness.server.sent('start')).toHaveLength(3);
      await c.stop();
    }
  );
});

describe('matrix C — a remux whose segments wait for the server (S9a C08)', () => {
  row(
    'C08',
    'remux (no conversion) or a quick first byte: never "the server converts", the network or plain buffering (review B3)',
    async () => {
      harness.features.probe = true;
      const media = (method: string) =>
        ({
          method,
          mediaInfo: {
            durationTicks: 600 * TICKS,
            audioTracks: [],
            subtitleTracks: [],
            bitrateKbps: 2_200,
            video: { height: 1080 },
          },
        }) as never;
      const c = await playing({}, media('remux'), 10);
      // A LAN segment: 30 ms to the first byte, 10 ms to arrive; and one long wait without a measured rate.
      harness.engine.setHealth({ fetch: { waitMs: 30, transferMs: 10, bytes: 4_000_000 } });
      await jest.advanceTimersByTimeAsync(1_000);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(4_000);
      expect(c.status.hint).toEqual({ key: 'buffering' });
      harness.engine.setHealth({ fetch: { waitMs: 5_400, transferMs: 300, bytes: 1_000_000 } });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.hint?.key).not.toBe('serverSlow');
      await c.stop();
      harness.reset();
      harness.features.probe = true;
      // A transcode that delivers 6 s of media per 9 s of waiting over three segments converts slower than real time.
      const t = await playing({}, media('transcode'), 10);
      harness.engine.setHealth({ conversionRate: 0.66, bandwidthBps: 1_000_000 });
      await jest.advanceTimersByTimeAsync(1_000);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(4_000);
      expect(t.status.hint).toEqual({ key: 'serverSlow' });
      await t.stop();
    }
  );
});

describe('matrix C — repair, conversion start, renditions, durations, image subtitles (S4f)', () => {
  row(
    'C04',
    'a direct play that stalls while the server repairs the release: "The server is repairing missing data", never "slow connection"',
    async () => {
      const c = await playing(
        {},
        {
          method: 'direct',
          mediaInfo: {
            durationTicks: 600 * TICKS,
            audioTracks: [],
            subtitleTracks: [],
            bitrateKbps: 8_000,
          },
        } as never,
        300
      );
      const id = c.playback!.playbackId!;
      harness.server.answer(
        'poll',
        reply.ok(
          harness.server.playback({
            playbackId: id,
            repair: { state: 'downloadingRecovery', progressPercent: 40 },
          } as never)
        )
      );
      harness.engine.emit({ type: 'buffering', buffering: true });
      await settle();
      expect(harness.server.sent('poll')).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(4_000);
      expect(c.status.hint).toEqual({ key: 'serverRepairing' });
      expect(c.status.actions).toEqual([]);
      await c.stop();
    }
  );

  row('C04', 'a repair that ended (ready, failed) is no reason: the usual stall hint', async () => {
    const c = await playing({}, { method: 'direct' } as never, 300);
    const id = c.playback!.playbackId!;
    harness.server.answer(
      'poll',
      reply.ok(harness.server.playback({ playbackId: id, repair: { state: 'ready' } } as never))
    );
    harness.engine.emit({ type: 'buffering', buffering: true });
    await jest.advanceTimersByTimeAsync(4_000);
    expect(c.status.hint).toEqual({ key: 'buffering' });
    await c.stop();
  });

  row(
    'C06',
    'a remux or transcode that fails to start (transcode_failed at create): one more start, then another version, then the card',
    async () => {
      const failed = () =>
        reply.ok(
          harness.server.playback({ state: 'failed', error: { code: 'transcode_failed' } } as never)
        );
      harness.server.answer('start', failed(), failed());
      const c = newController();
      await c.start();
      await settle();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(harness.server.sent('start')).toHaveLength(2);
      expect(harness.server.sent('versions')).toHaveLength(1);
      expect(c.failure).toMatchObject({ code: 'transcode_failed', category: 'T6' });
    }
  );

  row(
    'C19',
    'an in-session audio switch whose rendition fails (404): the switch goes to the server, the notice says the stream restarted',
    async () => {
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
      const media = {
        method: 'remux',
        inSessionAudioSwitch: true,
        audioRenditions: renditions,
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: [
            { index: 1, language: 'ger', selected: true, deliveredAs: 'remux', renditionId: '1' },
            { index: 2, language: 'eng', selected: false, deliveredAs: 'remux', renditionId: '2' },
          ],
          subtitleTracks: [],
        },
      } as never;
      const c = await playing({}, media, 40);
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
      harness.engine.emit({ type: 'audioError', code: 'unknown_audio_rendition' });
      await settle();
      await settle();
      expect(harness.server.sent('switch')[0]?.body).toMatchObject({ audioStreamIndex: 2 });
      harness.engine.started();
      harness.engine.time(41);
      await switching;
      expect(c.notice).toMatchObject({ kind: 'audioRestarted' });
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );

  row(
    'C33',
    'the media runs longer than the announced duration: the engine duration wins, playing past the server length is no failure',
    async () => {
      const c = await playing(
        {},
        { mediaInfo: { durationTicks: 300 * TICKS, audioTracks: [], subtitleTracks: [] } } as never,
        0
      );
      harness.engine.time(290, 330);
      expect(c.duration).toBe(330);
      harness.engine.time(310, 330);
      await settle();
      expect(c.ended).toBe(false);
      expect(c.failure).toBeNull();
      expect(c.status.hint).toBeNull();
      harness.engine.time(329, 330);
      harness.engine.emit({ type: 'ended' });
      expect(c.ended).toBe(true);
      await c.stop();
    }
  );

  row(
    'C34',
    'an image subtitle the server must burn in: the pick is a server switch at the position; turning it off switches back',
    async () => {
      const media = {
        method: 'transcode',
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: [],
          subtitleTracks: [
            { index: 5, language: 'de', codec: 'pgs', deliveredAs: 'burnedIn', selected: false },
          ],
        },
      } as never;
      const c = await playing({}, media, 120);
      const id = c.playback!.playbackId!;
      harness.server.answer(
        'switch',
        reply.ok(
          harness.server.playback({
            playbackId: id,
            revision: 1,
            method: 'transcode',
            mediaInfo: {
              durationTicks: 600 * TICKS,
              audioTracks: [],
              subtitleTracks: [
                { index: 5, language: 'de', codec: 'pgs', deliveredAs: 'burnedIn', selected: true },
              ],
            },
          } as never)
        )
      );
      await c.selectSubtitle({ index: 5, language: 'de', deliveredAs: 'burnedIn' } as never);
      expect(harness.server.sent('switch')[0]?.body).toMatchObject({
        subtitleStreamIndex: 5,
        positionTicks: 120 * TICKS,
      });
      harness.engine.started();
      await c.selectSubtitle(null);
      expect(harness.server.sent('switch')[1]?.body).toMatchObject({ subtitleStreamIndex: -1 });
      await c.stop();
    }
  );
});

describe('matrix C — code review S4c-S4f (S4g)', () => {
  row(
    'C14',
    'three 503 incidents a few minutes apart: each one reloads, the method is never stepped down (review R2)',
    async () => {
      const c = await playing({}, { method: 'direct' } as never, 100);
      for (let incident = 0; incident < 3; incident += 1) {
        harness.engine.fail(exo(503));
        await jest.advanceTimersByTimeAsync(6_000);
        harness.engine.started();
        await playOn(180);
      }
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(harness.engine.load).toHaveBeenCalledTimes(4);
      await c.stop();
    }
  );

  row(
    'C14',
    'a stall while hls.js retries a 504 is the server waiting its own budget: a reload there first, then lower quality; never the server-error reload (review M20, S9c D19)',
    async () => {
      const c = await playing(
        {},
        {
          method: 'transcode',
          mediaInfo: {
            durationTicks: 600 * TICKS,
            audioTracks: [],
            subtitleTracks: [],
            video: { height: 1080 },
          },
        } as never,
        100
      );
      harness.engine.emit({ type: 'loadRetry', status: 504 });
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(15_000);
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(c.status.hint?.key).not.toBe('serverError');
      harness.engine.started();
      // Stuck again, and the server's 504 arrives: the next step at once, no 15 s wait (S9c D19).
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.emit({ type: 'loadRetry', status: 504 });
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({
        preferences: expect.objectContaining({ maxHeight: 720 }),
      });
      await c.stop();
    }
  );

  row(
    'C10',
    'a media request answered 401/403 (the capability is gone) starts anew, like a 404 (review M22)',
    async () => {
      for (const status of [401, 403]) {
        harness.reset();
        const c = await playing({}, { method: 'remux' } as never, 60);
        harness.engine.emit({ type: 'error', reason: 'networkError:fragLoadError', status });
        await settle();
        expect(starts()).toHaveLength(2);
        expect(starts().at(-1)?.position).toBe(60);
        await c.stop();
      }
    }
  );

  row(
    'C04',
    'a repair answer that arrives after the playback was replaced is dropped (review M19)',
    async () => {
      const c = await playing({}, { method: 'direct' } as never, 300);
      const old = c.playback!.playbackId!;
      let release: (value: unknown) => void = () => undefined;
      const gate = new Promise((resolve) => (release = resolve));
      // The repair status of the old playback answers only after the new start attached.
      harness.server.answer('poll', async () => {
        await gate;
        return reply.ok(
          harness.server.playback({
            playbackId: old,
            repair: { state: 'downloadingRecovery' },
          } as never)
        );
      });
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.fail(exo(404));
      await settle();
      release(undefined);
      await settle();
      expect(c.playback!.playbackId).not.toBe(old);
      expect(c.playback?.repair ?? null).toBeNull();
      await c.stop();
    }
  );
});

describe('matrix C — subtitles after a healthy stretch (S4g)', () => {
  row(
    'C22',
    'a second failure of the same subtitles, even long after a successful retry, keeps them off for this video with the way back on (S4p R1, was review B5)',
    async () => {
      const subtitleTracks = [
        { index: 3, language: 'de', title: 'German', deliveredAs: 'webvtt', selected: true },
      ];
      const c = await playing(
        {},
        {
          method: 'remux',
          mediaInfo: { durationTicks: 6e10, audioTracks: [], subtitleTracks },
        } as never,
        100
      );
      const shown = {
        audio: [],
        subtitles: [{ id: 's0', label: 'German', language: 'de', selected: true }],
      };
      harness.engine.emit({ type: 'tracks', tracks: shown });
      await settle();
      harness.engine.emit({ type: 'subtitleError', code: 'subtitle_unavailable' });
      expect(c.notice?.params?.retry).toBe('later');
      await playOn(61);
      harness.engine.emit({ type: 'tracks', tracks: shown });
      await playOn(1800);
      harness.engine.emit({ type: 'subtitleError', code: 'subtitle_unavailable' });
      expect(c.notice).toMatchObject({ kind: 'subtitleFailed', params: { index: '3', retry: '' } });
      await c.stop();
    }
  );
});

describe('matrix C — live re-audit S9a2 (S4i)', () => {
  row(
    'C12',
    'a playlist without ENDLIST that the engine reads as 1:00 of a 3:00 title: the length is 3:00 and a stall at 0:59 is a stall, never the end card (S9a2)',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        {
          method: 'remux',
          mediaInfo: { durationTicks: 180 * TICKS, audioTracks: [], subtitleTracks: [] },
        } as never,
        40
      );
      harness.engine.time(59, 60);
      expect(c.duration).toBe(180);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(30_000);
      expect(c.ended).toBe(false);
      await c.stop();
    }
  );

  row(
    'C15',
    'the server closed the playback and leaves its restart in "starting": the old buffer runs dry, nothing is tried on the closed playback; the restart\'s own budget decides (S9a2 R13)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, hls, 10);
      harness.server.answer('start', reply.hang());
      harness.server.answer('switch', reply.error(404, 'playback_not_found'));
      harness.engine.emit({ type: 'error', reason: 'networkError:fragLoadError', status: 410 });
      await settle();
      expect(c.status.hint).toMatchObject({ key: 'restarting' });
      // The old source plays on from its buffer, then runs dry.
      harness.engine.time(24);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(30_000);
      expect(c.failure).toBeNull();
      expect(harness.server.sent('switch')).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(40_000);
      expect(c.failure?.code).not.toBe('playback_not_found');
      expect(c.failure).toMatchObject({ code: 'step_timeout' });
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );
});

describe('matrix C — code review native: the length (S4j)', () => {
  row(
    'C12',
    'no server length and an engine that calls the stream endless: the length is unknown (0), never "∞" (review native N21)',
    async () => {
      const c = await playing({}, { mediaInfo: { durationTicks: 0 } } as never, 0);
      harness.engine.time(10, Infinity);
      expect(c.duration).toBe(0);
      harness.engine.time(11, 180);
      expect(c.duration).toBe(180);
      await c.stop();
    }
  );
});

describe('matrix C — live native audit S9b: the engine ends before the title (S4k)', () => {
  const endless = {
    method: 'remux',
    mediaInfo: { durationTicks: 180 * TICKS, audioTracks: [], subtitleTracks: [] },
  } as never;

  row(
    'C12',
    'Exo calls a playlist without ENDLIST 1:00 long and ends at 0:59 of a 3:00 title: an early end that is explained, never "Finished" (S9b C12)',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('poll', reply.ok(harness.server.playback(endless)));
      const c = await playing({}, endless, 40);
      harness.engine.time(59, 60);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.ended).toBe(false);
      // The short-file ladder: a reload at the position first, then the card that says where it ends.
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(59);
      await c.stop();
    }
  );

  row(
    'C12',
    'an engine error at 0:59 of a 3:00 title that the engine calls 1:00 long is a failure, not the missing last segment of the end (S9b C12)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, endless, 40);
      harness.engine.time(59, 60);
      harness.engine.fail('networkError:fragLoadError');
      await settle();
      expect(c.ended).toBe(false);
      await c.stop();
    }
  );
});

describe('matrix C — live native audit S9b: a conversion that is only slow (S4k)', () => {
  const converting = { method: 'transcode' } as never;
  /** The server delivers half a second of media per second: the buffer grows, the picture has not come yet. */
  async function slowSegments(seconds: number, from: number) {
    for (let second = 1; second <= seconds; second++) {
      const buffered = Math.max(from, harness.engine.getSnapshot().buffered) + 0.5;
      harness.engine.emit({ type: 'time', position: from, duration: 600, buffered });
      await jest.advanceTimersByTimeAsync(1_000);
    }
  }

  row(
    'C08',
    'a start whose conversion is slow but delivers: "The server converts slower …" past the start budget, never "The picture didn\'t appear"; too slow for 90 s is "Conversion too slow" (S9b C08)',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('start', reply.ok(harness.server.playback(converting)));
      const c = newController({});
      await c.start();
      await slowSegments(40, 0);
      expect(c.failure).toBeNull();
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(c.status.hint).toMatchObject({ key: 'serverSlow' });
      await slowSegments(55, 0);
      // 90 s too slow: one T5 step (here another way to play, the height is unknown), never the picture reload.
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.server.sent('switch')).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ stepDown: true }) }),
      ]);
      expect(starts()).toHaveLength(1);
      await c.stop();
    }
  );

  row(
    'C08',
    'a slow conversion that stops delivering is "Conversion too slow" one start budget later, not after 90 s (S9b C08)',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('start', reply.ok(harness.server.playback(converting)));
      const c = newController({});
      await c.start();
      await slowSegments(35, 0);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(31_000);
      expect(harness.server.sent('switch')).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ stepDown: true }) }),
      ]);
      await c.stop();
    }
  );

  row(
    'C08',
    'a start that loads nothing at all is still "The picture didn\'t appear" after the start budget (S9b C08 control)',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('start', reply.ok(harness.server.playback(converting)));
      const c = newController({});
      await c.start();
      await jest.advanceTimersByTimeAsync(31_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await c.stop();
    }
  );

  row(
    'C08',
    'a viewer switch to 720p on a slow conversion waits with the hint, then goes back to the previous quality at its position (S9b C08/R4)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, converting, 20);
      const id = c.playback!.playbackId!;
      harness.server.answer(
        'switch',
        reply.ok(
          harness.server.playback({ playbackId: id, revision: 2, method: 'transcode' } as never)
        )
      );
      harness.server.answer('start', reply.ok(harness.server.playback({ playbackId: 'back2' })));
      await c.setQuality(720);
      await slowSegments(40, 20);
      expect(starts()).toHaveLength(1);
      expect(c.status.hint).toMatchObject({ key: 'serverSlow' });
      await slowSegments(55, 20);
      expect(starts().at(-1)?.position).toBe(20);
      expect(starts().at(-1)?.body.preferences).not.toMatchObject({ maxHeight: 720 });
      harness.engine.started();
      expect(c.notice).toMatchObject({ kind: 'switchFailed', params: { code: 'segment_timeout' } });
      await c.stop();
    }
  );
});

describe('matrix C — live native audit S9b: a switch right after a seek (S4k)', () => {
  row(
    'C08',
    'a quality switch 2 s after seeking back from 0:59 to 0:20 continues at 0:20, not at the native clock read before the seek (S9b R4)',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing({}, { method: 'remux' } as never, 59);
      harness.engine.setHealth({ nativePosition: 59 });
      c.seekTo(20);
      harness.engine.time(20);
      // The probe asked before the seek landed still answers 0:59.
      await jest.advanceTimersByTimeAsync(1_500);
      harness.server.answer(
        'switch',
        reply.ok(
          harness.server.playback({ playbackId: c.playback!.playbackId!, revision: 2 } as never)
        )
      );
      await c.setQuality(720);
      expect(Number(harness.server.sent('switch').at(-1)?.body?.positionTicks) / TICKS).toBe(20);
      await c.stop();
    }
  );
});

describe('matrix C — live native audit S9b turn 2: AVPlayer delivery failures (S4l)', () => {
  const converting = {
    method: 'transcode',
    mediaInfo: { durationTicks: 600 * TICKS, audioTracks: [], subtitleTracks: [] },
  } as never;
  const stall = () => harness.engine.emit({ type: 'buffering', buffering: true });

  row(
    'C10',
    'AVPlayer: a video segment answered 404 while it stalls is the server losing the playback: a new start at the position at once, never a lower quality (S9b2 C10)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, converting, 36);
      // The server lost the playback: its status read answers 404 (S4p: asked first).
      harness.server.answer('poll', reply.error(404, 'playback_not_found'));
      stall();
      harness.engine.emit({ type: 'loadRetry', status: 404, audio: false });
      await settle();
      expect(starts()).toHaveLength(2);
      expect(starts().at(-1)?.position).toBe(36);
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );

  row(
    'C15',
    'AVPlayer: 410 (session closed) on a video segment starts anew at once too (S9b2 C10)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, converting, 36);
      // The server lost the playback: its status read answers 404 (S4p: asked first).
      harness.server.answer('poll', reply.error(404, 'playback_not_found'));
      harness.engine.emit({ type: 'loadRetry', status: 410, audio: false });
      await settle();
      expect(starts()).toHaveLength(2);
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );

  row(
    'C10',
    'more 404 retries while the new start prepares are the same loss: the new start goes on, never the card (S9b2 C10)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, converting, 36);
      // The server lost the playback: its status read answers 404 (S4p: asked first).
      harness.server.answer('poll', reply.error(404, 'playback_not_found'));
      harness.server.answer('start', reply.hang());
      harness.engine.emit({ type: 'loadRetry', status: 404, audio: false });
      await settle();
      harness.engine.emit({ type: 'loadRetry', status: 404, audio: false });
      harness.engine.emit({ type: 'loadRetry', status: 404, audio: false });
      await settle();
      expect(c.failure).toBeNull();
      expect(starts()).toHaveLength(2);
      await c.stop();
    }
  );

  row(
    'C11',
    'AVPlayer: 503 on the video segments during a stall says "Problem on the server, retrying", then reloads; never "converts slower", never a lower quality (S9b2 C11)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, converting, 30);
      stall();
      for (let second = 0; second < 20; second++) {
        if (second % 3 === 0) harness.engine.emit({ type: 'loadRetry', status: 503, audio: false });
        await jest.advanceTimersByTimeAsync(1_000);
        expect(c.status.hint?.key).not.toBe('serverSlow');
      }
      expect(c.status.hint?.key).toMatch(/serverRetrying|serverError|reloading/);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );

  row(
    'C08',
    'a converted playback that stalls with no measured conversion speed and no error says "Loading takes longer", never "converts slower" (S9b2 C11)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, converting, 30);
      stall();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(c.status.hint).toEqual({ key: 'buffering' });
      await c.stop();
    }
  );
});

describe('matrix C — live native audit S9b turn 2: a broken subtitle rendition stalls AVPlayer (S4l)', () => {
  const subtitled = {
    method: 'transcode',
    mediaInfo: {
      durationTicks: 600 * TICKS,
      audioTracks: [],
      subtitleTracks: [
        { index: 2, language: 'en', deliveredAs: 'webvtt', selected: true },
        { index: 3, language: 'de', deliveredAs: 'webvtt', selected: false },
      ],
    },
  } as never;
  const tracks = (selected: string | null) => ({
    audio: [],
    subtitles: [
      { id: 's0', label: 'en', language: 'en', selected: selected === 's0' },
      { id: 's1', label: 'de', language: 'de', selected: selected === 's1' },
    ],
  });

  row(
    'C22',
    'AVPlayer waits for a subtitle segment that fails: the error turns the subtitles off first and the stall gets a fresh budget, no step-down (S9b2 C22)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, subtitled, 45);
      harness.engine.emit({ type: 'tracks', tracks: tracks('s0') });
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      await jest.advanceTimersByTimeAsync(10_000);
      harness.engine.emit({ type: 'subtitleError', code: 'unknown_subtitle_stream' });
      expect(harness.engine.commands.at(-1)).toBe('subtitle:null');
      expect(c.notice).toMatchObject({ kind: 'subtitleFailed' });
      await jest.advanceTimersByTimeAsync(10_000);
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      await c.stop();
    }
  );

  row(
    'C22',
    'AVPlayer stalls with a subtitle rendition on and no error at all: the first step turns the subtitles off quietly, before any lower quality or other way; the picture coming back says they blocked (S9b2 C22, S9c D19)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, subtitled, 45);
      harness.engine.emit({ type: 'tracks', tracks: tracks('s0') });
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      await jest.advanceTimersByTimeAsync(16_000);
      expect(harness.engine.commands).toContain('subtitle:null');
      expect(c.notice).toBeNull();
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      // The picture runs again with them off: they blocked the player, now it is said.
      harness.engine.emit({ type: 'buffering', buffering: false });
      harness.engine.state('playing');
      harness.engine.time(harness.engine.getSnapshot().position + 0.5);
      expect(c.notice).toMatchObject({ kind: 'subtitleFailed', params: { index: '2' } });
      await c.stop();
    }
  );

  row(
    'C22',
    "still stalled with the subtitles off: the video's stall, the subtitles come back with the usual ladder and nothing blames them (S9c D19)",
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, subtitled, 45);
      harness.engine.emit({ type: 'tracks', tracks: tracks('s0') });
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      await jest.advanceTimersByTimeAsync(16_000);
      expect(harness.engine.commands.at(-1)).toBe('subtitle:null');
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(
        harness.server.sent('switch').length + harness.engine.load.mock.calls.length
      ).toBeGreaterThan(1);
      expect(harness.engine.commands).toContain('subtitle:s0');
      expect(c.notice?.kind).not.toBe('subtitleFailed');
      expect(c.currentSubtitle()).toBe(2);
      await c.stop();
    }
  );

  row(
    'C22',
    'the web engine is never asked to drop subtitles for a stall: hls.js does not wait for them',
    async () => {
      jest.useFakeTimers();
      const c = await playing({ nativeEngine: 'web' } as never, subtitled, 45);
      harness.engine.emit({ type: 'tracks', tracks: tracks('s0') });
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      await jest.advanceTimersByTimeAsync(16_000);
      expect(harness.engine.commands).not.toContain('subtitle:null');
      await c.stop();
    }
  );

  row(
    'C10',
    'a forced subtitle the engine shows on its own (none selected in the engine) survives a ladder step: the new source asks for it again (S9b2 forced subtitle)',
    async () => {
      jest.useFakeTimers();
      const forced = {
        method: 'remux',
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: [],
          subtitleTracks: [
            { index: 5, language: 'de', forced: true, deliveredAs: 'webvtt', selected: true },
          ],
        },
      } as never;
      const c = await playing({}, forced, 36);
      const avplayer = {
        audio: [],
        subtitles: [{ id: 's0', label: 'de', language: 'de', selected: false }],
      };
      harness.engine.emit({ type: 'tracks', tracks: avplayer });
      await playOn(16);
      // AVPlayer shows a forced rendition by itself and reports no selected legible option.
      harness.engine.emit({ type: 'tracks', tracks: avplayer });
      expect(c.currentSubtitle()).toBe(5);
      harness.engine.fail('Source error: InvalidResponseCodeException: Response code: 410');
      await settle();
      expect(starts().at(-1)?.body.subtitleStreamIndex).toBe(5);
      await c.stop();
    }
  );

  row(
    'C10',
    'a viewer who turned the forced subtitle off keeps it off through a ladder step',
    async () => {
      jest.useFakeTimers();
      const forced = {
        method: 'remux',
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: [],
          subtitleTracks: [
            { index: 5, language: 'de', forced: true, deliveredAs: 'webvtt', selected: true },
          ],
        },
      } as never;
      const c = await playing({}, forced, 36);
      harness.engine.emit({
        type: 'tracks',
        tracks: {
          audio: [],
          subtitles: [{ id: 's0', label: 'de', language: 'de', selected: true }],
        },
      });
      await c.selectSubtitle(null);
      expect(c.currentSubtitle()).toBeNull();
      harness.engine.fail('Source error: InvalidResponseCodeException: Response code: 410');
      await settle();
      expect(starts().at(-1)?.body.subtitleStreamIndex).toBe(-1);
      await c.stop();
    }
  );
});

describe('matrix C — S4s: repeated short stalls and a stall during a server repair (V1 C03, C08, C04)', () => {
  const media = {
    durationTicks: 600 * TICKS,
    audioTracks: [],
    subtitleTracks: [],
    bitrateKbps: 8_000,
  };
  /** A stall of `seconds`, then `play` seconds of a running clock. */
  async function stallThenPlay(at: { now: number }, seconds: number, play: number) {
    harness.engine.emit({ type: 'buffering', buffering: true });
    await jest.advanceTimersByTimeAsync(seconds * 1000);
    harness.engine.emit({ type: 'buffering', buffering: false });
    for (let second = 0; second < play; second += 1) {
      at.now += 1;
      harness.engine.time(at.now);
      await jest.advanceTimersByTimeAsync(1_000);
    }
  }

  row(
    'C03',
    'three 6 s stalls within 2 min lower the quality (V1 probe P2); two do not',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        { method: 'remux', mediaInfo: { ...media, video: { height: 2160 } } } as never,
        100
      );
      const at = { now: 100 };
      await stallThenPlay(at, 6, 20);
      await stallThenPlay(at, 6, 20);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await stallThenPlay(at, 3, 0);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({
        preferences: expect.objectContaining({ maxHeight: 1080 }),
      });
      await c.stop();
    }
  );

  row(
    'C03',
    'short stalls more than 2 min apart, after a seek, or with a fast measured connection are no pattern',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        { method: 'remux', mediaInfo: { ...media, video: { height: 2160 } } } as never,
        100
      );
      const at = { now: 100 };
      for (let stall = 0; stall < 3; stall += 1) await stallThenPlay(at, 5, 70);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );

  row(
    'C08',
    'a transcode that rebuffers twice for more than 4 s lowers the quality at the second one',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        { method: 'transcode', mediaInfo: { ...media, video: { height: 2160 } } } as never,
        100
      );
      const at = { now: 100 };
      await stallThenPlay(at, 5, 30);
      expect(harness.server.sent('switch')).toHaveLength(0);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(6_000);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({
        preferences: expect.objectContaining({ maxHeight: 1080 }),
      });
      await c.stop();
    }
  );

  /** A seek to `target` whose clock comes back after `seconds` (`buffering`: the engine says so, else the tick finds it). */
  async function seekStall(
    c: { seekTo(target: number): void },
    at: { now: number },
    seek: { target: number; seconds: number; buffering: boolean }
  ) {
    c.seekTo(seek.target);
    await jest.advanceTimersByTimeAsync(400);
    if (seek.buffering) harness.engine.emit({ type: 'buffering', buffering: true });
    await jest.advanceTimersByTimeAsync(seek.seconds * 1000);
    if (seek.buffering) harness.engine.emit({ type: 'buffering', buffering: false });
    at.now = seek.target;
    for (let second = 0; second < 20; second += 1) {
      at.now += 1;
      harness.engine.time(at.now);
      await jest.advanceTimersByTimeAsync(1_000);
    }
  }

  row(
    'C08',
    'a transcode that rebuffers 6 s after each of two seeks, then blips for 1.5 s: seeks are no pattern, no /switch (review 7 P1)',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        { method: 'transcode', mediaInfo: { ...media, video: { height: 2160 } } } as never,
        100
      );
      const at = { now: 100 };
      await seekStall(c, at, { target: 200, seconds: 6, buffering: true });
      await seekStall(c, at, { target: 300, seconds: 6, buffering: true });
      await stallThenPlay(at, 1.5, 5);
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );

  row(
    'C03',
    'two seeks whose clock never comes (the tick finds the seek stall) and one short stall on a remux: no /switch (review 7 P5)',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        { method: 'remux', mediaInfo: { ...media, video: { height: 2160 } } } as never,
        100
      );
      const at = { now: 100 };
      await seekStall(c, at, { target: 200, seconds: 6, buffering: false });
      await seekStall(c, at, { target: 300, seconds: 6, buffering: false });
      await stallThenPlay(at, 3, 5);
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );

  row(
    'C03',
    'three short stalls with a measured connection well above the bitrate are no pattern (not the network)',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing(
        {},
        { method: 'remux', mediaInfo: { ...media, video: { height: 2160 } } } as never,
        100
      );
      harness.engine.setHealth({ bandwidthBps: 40_000_000 });
      const at = { now: 100 };
      for (let stall = 0; stall < 3; stall += 1) await stallThenPlay(at, 3, 20);
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );

  row(
    'C03',
    'a new source starts a new count: two stalls, a reload, one stall is no pattern',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        { method: 'remux', mediaInfo: { ...media, video: { height: 2160 } } } as never,
        100
      );
      const at = { now: 100 };
      await stallThenPlay(at, 3, 20);
      await stallThenPlay(at, 3, 20);
      harness.engine.fail('networkError:fragLoadError');
      await settle();
      await jest.advanceTimersByTimeAsync(3_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started();
      harness.engine.time(at.now);
      await stallThenPlay(at, 3, 5);
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );

  /** The server's repair as polls see it: each answer one step further (a refreshing server, B18). */
  const repairs = (steps: [state: string, percent: number][], etaSeconds?: number) =>
    steps.map(([state, progressPercent]) =>
      reply.ok(
        harness.server.playback({
          playbackId: 'p1',
          repair: { jobId: 'j1', state, progressPercent, ...(etaSeconds ? { etaSeconds } : {}) },
        } as never)
      )
    );
  const moving = (state: string, count: number, etaSeconds?: number) =>
    repairs(
      Array.from({ length: count }, (_, step) => [state, 10 + step] as [string, number]),
      etaSeconds
    );
  const laddered = () =>
    harness.engine.load.mock.calls.length + harness.server.sent('switch').length > 1;

  row(
    'C04',
    'a stall while the server repairs waits for the repair: "The server is repairing …" at 20 s, no step-down (V1 probe P1)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { method: 'direct', mediaInfo: media } as never, 300);
      harness.server.answer('poll', ...moving('downloadingRecovery', 30));
      harness.engine.emit({ type: 'buffering', buffering: true });
      await settle();
      await jest.advanceTimersByTimeAsync(20_000);
      expect(c.status.hint).toEqual({ key: 'serverRepairing' });
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      // At most 90 s (no ETA): then the normal stall ladder.
      await jest.advanceTimersByTimeAsync(71_000);
      await settle();
      expect(laddered()).toBe(true);
      await c.stop();
    }
  );

  row('C04', 'the server ETA bounds the wait (30 s here)', async () => {
    jest.useFakeTimers();
    const c = await playing({}, { method: 'direct', mediaInfo: media } as never, 300);
    harness.server.answer('poll', ...moving('reconstructing', 12, 30));
    harness.engine.emit({ type: 'buffering', buffering: true });
    await settle();
    await jest.advanceTimersByTimeAsync(25_000);
    expect(harness.engine.load).toHaveBeenCalledTimes(1);
    expect(harness.server.sent('switch')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(7_000);
    await settle();
    expect(laddered()).toBe(true);
    await c.stop();
  });

  row('C04', 'a short ETA never waits less than the 15 s of any stall (5 s here)', async () => {
    jest.useFakeTimers();
    const c = await playing({}, { method: 'direct', mediaInfo: media } as never, 300);
    harness.server.answer('poll', ...moving('reconstructing', 12, 5));
    harness.engine.emit({ type: 'buffering', buffering: true });
    await settle();
    await jest.advanceTimersByTimeAsync(12_000);
    expect(c.status.hint).toEqual({ key: 'serverRepairing' });
    expect(laddered()).toBe(false);
    await jest.advanceTimersByTimeAsync(4_000);
    await settle();
    expect(laddered()).toBe(true);
    await c.stop();
  });

  row(
    'C04',
    'downloading → verifying → ready: the stall waits while the repair moves, the ready repair ends the wait (review 7 P2-4)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { method: 'direct', mediaInfo: media } as never, 300);
      harness.server.answer(
        'poll',
        ...repairs([
          ['downloadingRecovery', 20],
          ['downloadingRecovery', 40],
          ['downloadingRecovery', 60],
          ['verifying', 80],
          ['verifying', 95],
          ['ready', 100],
        ])
      );
      harness.engine.emit({ type: 'buffering', buffering: true });
      await settle();
      await jest.advanceTimersByTimeAsync(15_000);
      expect(c.status.hint).toEqual({ key: 'serverRepairing' });
      expect(laddered()).toBe(false);
      await jest.advanceTimersByTimeAsync(8_000);
      await settle();
      expect(laddered()).toBe(true);
      await c.stop();
    }
  );

  row(
    'C04',
    'a repair state that never changes (the start snapshot) is stale: no repair hint, the normal 15 s ladder (review 7 P2-4 a)',
    async () => {
      jest.useFakeTimers();
      const stale = {
        jobId: 'j1',
        state: 'downloadingRecovery',
        progressPercent: 40,
        etaSeconds: 80,
      };
      const c = await playing(
        {},
        { method: 'direct', mediaInfo: media, repair: stale } as never,
        300
      );
      harness.server.answer(
        'poll',
        ...Array.from({ length: 10 }, () =>
          reply.ok(harness.server.playback({ playbackId: 'p1', repair: stale } as never))
        )
      );
      harness.engine.emit({ type: 'buffering', buffering: true });
      await settle();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(c.status.hint?.key).not.toBe('serverRepairing');
      await jest.advanceTimersByTimeAsync(6_000);
      await settle();
      expect(laddered()).toBe(true);
      await c.stop();
    }
  );

  row(
    'C04',
    'one hold per repair: the next stall of the same repair follows the normal rules (review 7 P2-4 b)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { method: 'direct', mediaInfo: media } as never, 300);
      harness.server.answer('poll', ...moving('downloadingRecovery', 30));
      harness.engine.emit({ type: 'buffering', buffering: true });
      await settle();
      await jest.advanceTimersByTimeAsync(20_000);
      expect(c.status.hint).toEqual({ key: 'serverRepairing' });
      harness.engine.emit({ type: 'buffering', buffering: false });
      for (let second = 1; second <= 30; second += 1) {
        harness.engine.time(300 + second);
        await jest.advanceTimersByTimeAsync(1_000);
      }
      expect(laddered()).toBe(false);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await settle();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(c.status.hint?.key).not.toBe('serverRepairing');
      await jest.advanceTimersByTimeAsync(6_000);
      await settle();
      expect(laddered()).toBe(true);
      await c.stop();
    }
  );

  row(
    'C04',
    'the server gives the repair up while it stalls: the same release once more, then another version',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, { method: 'direct', mediaInfo: media } as never, 300);
      harness.server.answer(
        'poll',
        ...repairs([
          ['downloadingRecovery', 30],
          ['failed', 30],
          ['failed', 30],
          ['failed', 30],
        ])
      );
      harness.engine.emit({ type: 'buffering', buffering: true });
      await settle();
      await jest.advanceTimersByTimeAsync(6_500);
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(300);
      harness.engine.started();
      harness.engine.emit({ type: 'buffering', buffering: true });
      await settle();
      await jest.advanceTimersByTimeAsync(1_500);
      await settle();
      expect(harness.server.sent('versions')).toHaveLength(1);
      await c.stop();
    }
  );
});

describe('matrix C — S4s: a new method plays past the cut of a truncated file (S6x Left, Google TV VLC run 2)', () => {
  row(
    'C32',
    'after a step-down to a transcode that plays past the old early end, a stall there is a stall: no "damaged" verdict, no other version',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        {
          method: 'direct',
          mediaInfo: {
            durationTicks: 180 * TICKS,
            audioTracks: [],
            subtitleTracks: [],
            video: { height: 1080 },
          },
        } as never,
        80
      );
      // The direct file stops at 1:28 of 3:00: the early end is remembered there.
      harness.engine.time(88, 180);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      // The viewer (or a later step) changes the way to play: the transcode delivers the whole title.
      harness.server.answer(
        'switch',
        reply.ok(
          harness.server.playback({
            playbackId: c.playback!.playbackId!,
            method: 'transcode',
            revision: 1,
            mediaInfo: {
              durationTicks: 180 * TICKS,
              audioTracks: [],
              subtitleTracks: [],
              video: { height: 1080 },
            },
          } as never)
        )
      );
      await c.stepDown();
      await settle();
      harness.engine.started(180);
      for (let second = 89; second <= 91; second += 1) {
        harness.engine.time(second, 180);
        await jest.advanceTimersByTimeAsync(1_000);
      }
      const before = harness.server.sent('switch').length;
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(harness.server.sent('versions')).toHaveLength(0);
      // A plain stall ladder (lower quality), never another step-down for "damaged" data.
      const after = harness.server.sent('switch').slice(before);
      expect(after.some((request) => request.body?.stepDown)).toBe(false);
      expect(after.at(-1)?.body).toMatchObject({
        preferences: expect.objectContaining({ maxHeight: 720 }),
      });
      await c.stop();
    }
  );

  row(
    'C32',
    'the new method\'s own early end elsewhere is its own short file, not "ends at different places" against the old method\'s end (review 7 M24)',
    async () => {
      jest.useFakeTimers();
      const media = {
        durationTicks: 180 * TICKS,
        audioTracks: [],
        subtitleTracks: [],
        video: { height: 1080 },
      };
      const c = await playing({}, { method: 'direct', mediaInfo: media } as never, 80);
      harness.engine.time(88, 180);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.server.answer(
        'switch',
        reply.ok(
          harness.server.playback({
            playbackId: c.playback!.playbackId!,
            method: 'transcode',
            revision: 1,
            mediaInfo: media,
          } as never)
        )
      );
      await c.stepDown();
      await settle();
      harness.engine.started(180);
      for (let second = 89; second <= 150; second += 1) harness.engine.time(second, 180);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.failure).toMatchObject({ code: 'end_of_stream', category: 'T8' });
      expect(c.status.hint?.key).not.toBe('reconnecting');
      await c.stop();
    }
  );
});

describe('matrix C — S4v: the server length wins over an engine guess (S9c turn 2 VLC truncate)', () => {
  row(
    'C12',
    "VLC guesses 1:49:42 from the bytes of a cut MPEG-PS: the title is the server's 3:00 on every engine; a close engine length stays",
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        {
          method: 'direct',
          engine: 'vlc',
          mediaInfo: {
            durationTicks: 179.96 * TICKS,
            container: 'mpeg',
            audioTracks: [],
            subtitleTracks: [],
          },
        } as never,
        10
      );
      expect(harness.engine.kind).toBe('vlc');
      harness.engine.time(12, 6582);
      expect(c.duration).toBeCloseTo(179.96, 2);
      harness.engine.time(13, 181);
      expect(c.duration).toBe(181);
      harness.engine.time(14, 120);
      expect(c.duration).toBeCloseTo(179.96, 2);
      // Longer than announced on VLC is its guess too for an MPEG-PS (on Exo/AVPlayer it is real media, C33).
      harness.engine.time(15, 200);
      expect(c.duration).toBeCloseTo(179.96, 2);
      await c.stop();
    }
  );

  row(
    'C33',
    'VLC playing an MKV that really runs longer than announced (3:20 of 3:00): its length wins, so up-next never comes before the real end (review 8 P3-3)',
    async () => {
      const c = await playing(
        {},
        {
          method: 'direct',
          engine: 'vlc',
          mediaInfo: {
            durationTicks: 180 * TICKS,
            container: 'mkv',
            audioTracks: [],
            subtitleTracks: [],
          },
        } as never,
        10
      );
      expect(harness.engine.kind).toBe('vlc');
      harness.engine.time(12, 200);
      expect(c.duration).toBe(200);
      // A guess beyond twice the server's length stays a guess on any container.
      harness.engine.time(13, 6582);
      expect(c.duration).toBe(180);
      await c.stop();
    }
  );

  row(
    'C12',
    "any engine: a length beyond twice the server's is a guess, the server's wins",
    async () => {
      const c = await playing(
        {},
        { mediaInfo: { durationTicks: 180 * TICKS, audioTracks: [], subtitleTracks: [] } } as never,
        10
      );
      expect(harness.engine.kind).not.toBe('vlc');
      harness.engine.time(12, 6582);
      expect(c.duration).toBe(180);
      harness.engine.time(13, 200);
      expect(c.duration).toBe(200);
      await c.stop();
    }
  );
});

describe('matrix C — S4w: an endless playlist on the web engine (S9c turn 3 C12, Chrome)', () => {
  const endless = {
    method: 'remux',
    mediaInfo: { durationTicks: 180 * TICKS, audioTracks: [], subtitleTracks: [] },
  } as never;
  /** hls.js on a playlist without ENDLIST that stopped growing: the media element knows 1:00, plays to 0:59 and waits. */
  async function stopsAt59() {
    for (let position = 41; position <= 59; position++) {
      harness.engine.emit({ type: 'time', position, duration: 60, buffered: 60 });
      await jest.advanceTimersByTimeAsync(1_000);
    }
    harness.engine.emit({ type: 'buffering', buffering: true });
    harness.engine.state('buffering');
  }

  row(
    'C12',
    'hls.js waits at the end of a 1:00 playlist of a 3:00 title: "ends early", a reload at 0:59, then another version — never "no picture", never a lower quality',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('poll', reply.ok(harness.server.playback(endless)));
      const c = await playing({ nativeEngine: 'web' }, endless, 40);
      expect(harness.engine.kind).toBe('web');
      await stopsAt59();
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(59);
      harness.engine.started(60);
      harness.engine.time(59, 60);
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(harness.server.sent('versions')).toHaveLength(1);
      expect(JSON.stringify(harness.server.sent('switch'))).not.toContain('maxHeight');
      const tried = c.failure?.tried ?? [];
      expect(tried.map((attempt) => attempt.code)).not.toContain('picture_timeout');
      expect(c.failure?.code).not.toBe('picture_timeout');
      await c.stop();
    }
  );

  row(
    'C12',
    'a plain stall in the middle of a VOD playlist (engine length = server length) keeps the stall ladder',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        { nativeEngine: 'web' },
        {
          method: 'remux',
          mediaInfo: { durationTicks: 180 * TICKS, audioTracks: [], subtitleTracks: [] },
        } as never,
        40
      );
      harness.engine.time(59, 180);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(c.status.hint?.key).not.toBe('endedEarly');
      expect(harness.server.sent('versions')).toHaveLength(0);
      await c.stop();
      // An engine length a few seconds short of the server's (rounding) and a stall near it: still a stall.
      harness.reset();
      const d = await playing(
        { nativeEngine: 'web' },
        {
          method: 'remux',
          mediaInfo: { durationTicks: 180 * TICKS, audioTracks: [], subtitleTracks: [] },
        } as never,
        150
      );
      harness.engine.time(165, 175);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(d.status.hint?.key).not.toBe('endedEarly');
      expect(d.failure?.code).not.toBe('end_of_stream');
      expect(harness.server.sent('versions')).toHaveLength(0);
      await d.stop();
    }
  );
});

describe('matrix C — S4x: the playlist-end rule only at the playlist end (review 8 R09, R30)', () => {
  row(
    'C12',
    'a stall at 0:30 of a 1:00 playlist (server 3:00) is a stall, not an early end: the stall ladder, no "ends early"',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        { nativeEngine: 'web' },
        {
          method: 'remux',
          mediaInfo: { durationTicks: 180 * TICKS, audioTracks: [], subtitleTracks: [] },
        } as never,
        20
      );
      harness.engine.time(30, 60);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      // The stall ladder's own step (here another way to play), never the early-end reload at 0:30.
      expect(c.status.hint?.key).not.toBe('endedEarly');
      expect(c.status.hint?.key).not.toBe('reloading');
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      expect(c.failure?.code).not.toBe('end_of_stream');
      await c.stop();
    }
  );

  row(
    'C12',
    'AVPlayer at the end of a short playlist with subtitles on: the quiet try, then the early end reloads at 0:59 with the subtitles back',
    async () => {
      jest.useFakeTimers();
      const endless = {
        method: 'remux',
        mediaInfo: {
          durationTicks: 180 * TICKS,
          audioTracks: [],
          subtitleTracks: [{ index: 5, language: 'de', deliveredAs: 'webvtt', selected: true }],
        },
      } as never;
      harness.server.answer('poll', reply.ok(harness.server.playback(endless)));
      const c = await playing({}, endless, 40);
      harness.engine.emit({
        type: 'tracks',
        tracks: {
          audio: [],
          subtitles: [{ id: 's0', label: 'de', language: 'de', selected: true }],
        },
      });
      harness.engine.time(59, 60);
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      await jest.advanceTimersByTimeAsync(16_000);
      expect(harness.engine.commands).toContain('subtitle:null');
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(harness.engine.source?.startPosition).toBe(59);
      expect(
        harness.engine.commands.filter((command) => command.startsWith('subtitle:')).at(-1)
      ).toBe('subtitle:s0');
      expect(c.currentSubtitle()).toBe(5);
      await c.stop();
    }
  );
});

describe('matrix C — S4x: a stall nobody announced is armed by one rule (V2 turn 2 blocking 3, Chrome)', () => {
  const endless = {
    method: 'remux',
    mediaInfo: { durationTicks: 180 * TICKS, audioTracks: [], subtitleTracks: [] },
  } as never;

  row(
    'C12',
    'the early-end reload at 0:59 lands in "loading", its first frame comes, the engine never plays: spinner within 3 s, then another version — never a frozen frame without a hint',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('poll', reply.ok(harness.server.playback(endless)));
      const c = await playing({ nativeEngine: 'web' }, endless, 40);
      for (let position = 41; position <= 59; position++) {
        harness.engine.emit({ type: 'time', position, duration: 60, buffered: 60 });
        await jest.advanceTimersByTimeAsync(1_000);
      }
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      // The reloaded hls.js source: loading at 59.89, its first frame, then nothing (V2's recorded state).
      harness.engine.emit({ type: 'time', position: 59.89, duration: 60, buffered: 60 });
      harness.engine.emit({ type: 'firstFrame' });
      expect(harness.engine.getSnapshot().state).toBe('loading');
      await jest.advanceTimersByTimeAsync(3_000);
      expect(c.status.spinner).toBe(true);
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(harness.server.sent('versions')).toHaveLength(1);
      await c.stop();
    }
  );

  row(
    'C12',
    'any engine: the first frame while the engine still loads and the clock stands is a stall with its budget (V2 blocking 3)',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('start', reply.ok(harness.server.playback({})));
      const c = newController();
      await c.start();
      harness.engine.emit({ type: 'time', position: 0, duration: 600 });
      harness.engine.emit({ type: 'firstFrame' });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(false);
      await jest.advanceTimersByTimeAsync(2_500);
      expect(c.status.spinner).toBe(true);
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(
        harness.engine.load.mock.calls.length + harness.server.sent('switch').length
      ).toBeGreaterThan(1);
      await c.stop();
    }
  );
});

describe("matrix C — S4y: a step's new source on VLC shows the spinner until its frames run (V2 VLC step-down black frame)", () => {
  row(
    'C32',
    "VLC: the reload's clock starts over a black picture: the spinner stays until the frame counter moves (or 4 s), never black without a spinner",
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing({}, { method: 'direct', engine: 'vlc' } as never, 40);
      expect(harness.engine.kind).toBe('vlc');
      harness.engine.setHealth({ framesPresented: 900 });
      harness.engine.fail('vlc_error: libVLC playback failed');
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      // libVLC's "first frame" is its clock: it runs while the picture is still black, the counter stands.
      harness.engine.setHealth({ framesPresented: 0 });
      harness.engine.started();
      harness.engine.time(40.5);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(true);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(true);
      harness.engine.setHealth({ framesPresented: 24 });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(false);
      await c.stop();
    }
  );

  row(
    'C32',
    'a frame counter that never moves: the spinner holds every second until the watchdog says "no picture" — no black gap (review 10 P3-2)',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing({}, { method: 'direct', engine: 'vlc' } as never, 40);
      harness.engine.fail('vlc_error: libVLC playback failed');
      await settle();
      harness.engine.setHealth({ framesPresented: 0 });
      harness.engine.started();
      let second = 1;
      for (; second <= 15 && c.status.hint?.key !== 'noPicture'; second++) {
        harness.engine.time(40 + second);
        await jest.advanceTimersByTimeAsync(1_000);
        expect(c.status.spinner).toBe(true);
      }
      expect(c.status.hint?.key).toBe('noPicture');
      await c.stop();
    }
  );

  row('C32', 'Exo/AVPlayer report a rendered first frame: no extra spinner after it', async () => {
    jest.useFakeTimers();
    harness.features.probe = true;
    const c = await playing({}, {}, 40);
    harness.engine.fail('ERROR_CODE_DECODER_INIT_FAILED: video/avc');
    await settle();
    harness.engine.setHealth({ framesPresented: 0 });
    harness.engine.started();
    expect(c.status.spinner).toBe(false);
    await c.stop();
  });
});

describe('matrix C — S4y: forced subtitles follow the audio language on every engine (PLAN.md § 2, V2 turn 1)', () => {
  const audioTracks = [
    { index: 1, language: 'ger', deliveredAs: 'original', selected: true },
    { index: 2, language: 'eng', deliveredAs: 'original', selected: false },
  ];
  const subtitleTracks = [
    { index: 5, language: 'ger', forced: true, deliveredAs: 'webvtt', selected: true },
    { index: 6, language: 'ger', forced: false, deliveredAs: 'webvtt', selected: false },
  ];
  const tracks = (audio: number, subtitle: string | null) => ({
    audio: [
      { id: 'a0', label: 'de', language: 'de', selected: audio === 0 },
      { id: 'a1', label: 'en', language: 'en', selected: audio === 1 },
    ],
    subtitles: [
      { id: 's0', label: 'de', language: 'de', forced: true, selected: subtitle === 's0' },
      { id: 's1', label: 'de', language: 'de', selected: subtitle === 's1' },
    ],
  });

  it.each([
    ['web (hls.js)', 'web', 'remux'],
    ['iPhone / Apple TV (AVPlayer)', 'expo-video', 'remux'],
    ['Google TV / Apple TV (VLC)', 'vlc', 'direct'],
  ] as const)(
    '%s: English audio turns the forced German subtitle off, and it stays off when the engine lists it again',
    async (_name, engine, method) => {
      jest.useFakeTimers();
      const os = jest.replaceProperty(Platform, 'OS', engine === 'web' ? 'web' : 'ios');
      const c = await playing(
        engine === 'web' ? ({ nativeEngine: 'web' } as never) : {},
        {
          method,
          ...(engine === 'vlc' ? { engine: 'vlc' } : null),
          mediaInfo: { durationTicks: 600 * TICKS, audioTracks, subtitleTracks },
        } as never,
        24
      );
      expect(harness.engine.kind).toBe(engine);
      harness.engine.emit({ type: 'tracks', tracks: tracks(0, 's0') });
      expect(c.currentSubtitle()).toBe(5);
      await c.selectAudio(audioTracks[1] as never);
      harness.engine.emit({ type: 'tracks', tracks: tracks(1, null) });
      expect(c.currentAudio()).toBe(2);
      expect(c.currentSubtitle()).toBeNull();
      // The engine shows the forced track of the file again by itself (AVPlayer's auto selection, hls.js on reload).
      harness.engine.emit({ type: 'tracks', tracks: tracks(1, 's0') });
      await playOn(2);
      expect(c.currentSubtitle()).toBeNull();
      expect(
        harness.engine.commands.filter((command) => command.startsWith('subtitle:')).at(-1)
      ).toBe('subtitle:null');
      os.restore();
      await c.stop();
    }
  );

  it('a full subtitle the viewer picked stays with English audio', async () => {
    jest.useFakeTimers();
    const c = await playing(
      { nativeEngine: 'web' } as never,
      {
        method: 'remux',
        mediaInfo: { durationTicks: 600 * TICKS, audioTracks, subtitleTracks },
      } as never,
      24
    );
    harness.engine.emit({ type: 'tracks', tracks: tracks(0, 's0') });
    await c.selectSubtitle(subtitleTracks[1] as never);
    await c.selectAudio(audioTracks[1] as never);
    harness.engine.emit({ type: 'tracks', tracks: tracks(1, 's1') });
    expect(c.currentSubtitle()).toBe(6);
    await c.stop();
  });
});

describe('matrix C — S4z: the starved rule stays out of the end, a step and a fresh picture (review 9 M08, M09, M10, M40)', () => {
  row(
    'C12',
    'a stall in the last 12 s ends the title while the engine still says "buffering": no spinner or stall over the end card (M08)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 590);
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      await jest.advanceTimersByTimeAsync(5_000);
      expect(c.ended).toBe(true);
      await jest.advanceTimersByTimeAsync(20_000);
      expect(c.status).toMatchObject({ spinner: false, hint: null });
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );

  row(
    'C12',
    "while a reload waits out the server's 503 (its 5 s backoff) the engine still buffers: no second stall is armed or counted (M09)",
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, hls, 100);
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      for (let second = 0; second < 16; second++) {
        if (second % 2 === 0) harness.engine.emit({ type: 'loadRetry', status: 503, audio: false });
        await jest.advanceTimersByTimeAsync(1_000);
      }
      await settle();
      expect(c.status.hint?.key).toBe('serverError');
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(3_000);
      // The server's hint stays: no stall timeline of its own over the waiting step.
      expect(c.status.hint?.key).toBe('serverError');
      await c.stop();
    }
  );

  row(
    'C12',
    'the first frame after a long load on an engine that still loads: the stall comes 2 s later, not at once (M10)',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('start', reply.ok(harness.server.playback({})));
      const c = newController();
      await c.start();
      await jest.advanceTimersByTimeAsync(8_000);
      // expo-video renders its first frame without a time event.
      harness.engine.emit({ type: 'firstFrame' });
      await jest.advanceTimersByTimeAsync(1_200);
      expect(c.status.spinner).toBe(false);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(c.status.spinner).toBe(true);
      await c.stop();
    }
  );

  row(
    'C12',
    'a clock that only steps back under a waiting engine (an hls.js nudge, a keyframe snap) is no progress: the stall is armed (M40)',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('start', reply.ok(harness.server.playback({})));
      const c = newController();
      await c.start();
      harness.engine.emit({ type: 'time', position: 10, duration: 600 });
      harness.engine.emit({ type: 'firstFrame' });
      for (const position of [9.6, 9.3, 9.0, 8.7]) {
        await jest.advanceTimersByTimeAsync(1_000);
        harness.engine.emit({ type: 'time', position, duration: 600 });
      }
      await jest.advanceTimersByTimeAsync(1_500);
      expect(c.status.spinner).toBe(true);
      await c.stop();
    }
  );

  row(
    'C12',
    'a stall that ended with "playing" and the clock: the next stall starts without that mark — one 0.3 s step does not end it (review 9 M39)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 47);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(3_000);
      harness.engine.emit({ type: 'buffering', buffering: false });
      harness.engine.time(47.3);
      expect(c.status.spinner).toBe(false);
      await jest.advanceTimersByTimeAsync(2_000);
      harness.engine.time(49.3);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(2_000);
      harness.engine.time(49.6);
      expect(c.status.spinner).toBe(true);
      await c.stop();
    }
  );

  row(
    'C12',
    'AVPlayer snaps back to a keyframe inside a stall, then plays: the first 0.3 s from there ends the stall (review 9 M13)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 47);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(3_000);
      harness.engine.time(46.5);
      harness.engine.emit({ type: 'buffering', buffering: false });
      harness.engine.time(46.8);
      expect(c.status.spinner).toBe(false);
      await c.stop();
    }
  );

  row(
    'C33',
    'VLC playing an HLS remux of a .ts source runs longer than announced: its length wins, the MPEG guess rule is for direct files only (M30)',
    async () => {
      const c = await playing(
        {},
        {
          method: 'remux',
          engine: 'vlc',
          mediaInfo: {
            durationTicks: 180 * TICKS,
            container: 'ts',
            audioTracks: [],
            subtitleTracks: [],
          },
        } as never,
        10
      );
      expect(harness.engine.kind).toBe('vlc');
      harness.engine.time(12, 200);
      expect(c.duration).toBe(200);
      await c.stop();
    }
  );
});

describe('matrix C — S4z2: a seek inside a stall and the confirm spinner, pinned (review 10 P3-3, P3-4)', () => {
  const uhd = {
    method: 'remux',
    mediaInfo: {
      durationTicks: 600 * TICKS,
      audioTracks: [],
      subtitleTracks: [],
      video: { height: 2160 },
    },
  } as never;
  const laddered = () =>
    harness.engine.load.mock.calls.length + harness.server.sent('switch').length > 1;

  row(
    'C03',
    'a seek 10 s into a stall: the budget starts at the seek — no step 15 s after the stall began, one 15 s after the seek (Z05)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, uhd, 100);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(10_000);
      c.seekTo(200);
      await jest.advanceTimersByTimeAsync(12_000);
      await settle();
      expect(laddered()).toBe(false);
      expect(c.status.spinner).toBe(true);
      await jest.advanceTimersByTimeAsync(4_000);
      await settle();
      expect(laddered()).toBe(true);
      await c.stop();
    }
  );

  row(
    'C03',
    '"buffering over" without the clock, then a seek, then one 0.3 s step at the target: the stall goes on (Z06)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, uhd, 100);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(3_000);
      harness.engine.emit({ type: 'buffering', buffering: false });
      c.seekTo(200);
      harness.engine.time(200);
      harness.engine.time(200.3);
      await jest.advanceTimersByTimeAsync(2_500);
      expect(c.status.spinner).toBe(true);
      await c.stop();
    }
  );

  row(
    'C03',
    'a seek back inside a stall, then the picture runs at the new place: the stall ends after a second of clock there (Z03)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, uhd, 100);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(3_000);
      c.seekTo(50);
      for (let step = 1; step <= 6; step++) {
        harness.engine.time(50 + step * 0.5);
        await jest.advanceTimersByTimeAsync(500);
      }
      expect(c.status.spinner).toBe(false);
      await c.stop();
    }
  );

  row(
    'C08',
    "a transcode: one long rebuffer, then a stall the viewer seeks out of at once: the seek's wait is no second long rebuffer, no quality drop (Z04)",
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        {
          method: 'transcode',
          mediaInfo: {
            durationTicks: 600 * TICKS,
            audioTracks: [],
            subtitleTracks: [],
            video: { height: 2160 },
          },
        } as never,
        100
      );
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(6_000);
      harness.engine.emit({ type: 'buffering', buffering: false });
      for (let second = 1; second <= 20; second++) {
        harness.engine.time(100 + second);
        await jest.advanceTimersByTimeAsync(1_000);
      }
      harness.engine.emit({ type: 'buffering', buffering: true });
      c.seekTo(300);
      await jest.advanceTimersByTimeAsync(8_000);
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(c.status.hint?.key).not.toBe('lowering');
      await c.stop();
    }
  );

  row(
    'C03',
    'two counted stalls, then a seek whose clock never comes while the engine already reads "buffering": its wait is the seek\'s own, never a third counted stall (Z07)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, uhd, 100);
      const at = { now: 100 };
      for (let stall = 0; stall < 2; stall++) {
        harness.engine.emit({ type: 'buffering', buffering: true });
        await jest.advanceTimersByTimeAsync(3_000);
        harness.engine.emit({ type: 'buffering', buffering: false });
        for (let second = 1; second <= 10; second++) {
          at.now += 1;
          harness.engine.time(at.now);
          await jest.advanceTimersByTimeAsync(1_000);
        }
      }
      // The last clock step comes with the seek; the engine then reads "buffering" without an event.
      harness.engine.time(at.now + 0.5);
      harness.engine.snapshot = { ...harness.engine.snapshot, state: 'buffering' };
      c.seekTo(300);
      await jest.advanceTimersByTimeAsync(8_000);
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );

  /** A VLC (or any probed) playback whose reload step's frames do not run yet. */
  async function reloadWithStuckFrames(over: object = { method: 'direct', engine: 'vlc' }) {
    jest.useFakeTimers();
    harness.features.probe = true;
    const c = await playing({}, over as never, 40);
    harness.engine.setHealth({ framesPresented: 900 });
    harness.engine.fail('vlc_error: libVLC playback failed');
    await settle();
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    harness.engine.setHealth({ framesPresented: 0 });
    return c;
  }

  row(
    'C32',
    'AVPlayer/Exo: a reload whose start is only read from the clock (no rendered-frame event) waits for the frame counter too (Y05)',
    async () => {
      const c = await reloadWithStuckFrames({ method: 'remux' });
      harness.engine.state('playing');
      harness.engine.time(40.5);
      harness.engine.time(41);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(true);
      harness.engine.setHealth({ framesPresented: 24 });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(false);
      await c.stop();
    }
  );

  row('C32', "VLC's first start (no recovery step) gets no confirm spinner (Y09)", async () => {
    jest.useFakeTimers();
    harness.features.probe = true;
    const c = await playing({}, { method: 'direct', engine: 'vlc' } as never, 40);
    harness.engine.setHealth({ framesPresented: 0 });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(c.status.spinner).toBe(false);
    await c.stop();
  });

  row(
    'C32',
    'paused during the confirm window: no spinner over the paused picture (Y20)',
    async () => {
      const c = await reloadWithStuckFrames();
      harness.engine.started();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.spinner).toBe(true);
      c.setPaused(true);
      expect(c.status.spinner).toBe(false);
      await c.stop();
    }
  );

  row(
    'C32',
    'a stall during the confirm window gets its own timeline: "Buffering…" after 4 s, not a bare spinner (Y21)',
    async () => {
      const c = await reloadWithStuckFrames();
      harness.engine.started();
      await jest.advanceTimersByTimeAsync(500);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(4_500);
      expect(c.status.hint?.key).toBe('buffering');
      await c.stop();
    }
  );
});

describe("matrix C — S4z3: the reload at a short playlist's end waits there again (V2 turn 5 C12, Chrome)", () => {
  const endless = {
    method: 'remux',
    mediaInfo: { durationTicks: 888 * TICKS, audioTracks: [], subtitleTracks: [] },
  } as never;
  /** hls.js on Sintel from 0:40: the playlist knows 1:00 of 14:48, plays to 0:59, waits, the stall ladder reloads at 0:59. */
  async function reloadedAt59() {
    jest.useFakeTimers();
    harness.server.answer('poll', reply.ok(harness.server.playback(endless)));
    const c = await playing({ nativeEngine: 'web' }, endless, 40);
    for (let position = 41; position <= 59; position++) {
      harness.engine.emit({ type: 'time', position, duration: 60, buffered: 60 });
      await jest.advanceTimersByTimeAsync(1_000);
    }
    harness.engine.emit({ type: 'buffering', buffering: true });
    harness.engine.state('buffering');
    await jest.advanceTimersByTimeAsync(16_000);
    await settle();
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    expect(harness.engine.source?.startPosition).toBe(59);
    return c;
  }
  const steppedDown = () => JSON.stringify(harness.server.sent('switch')).includes('stepDown');

  row(
    'C12',
    'the reload lands in "loading" at 0:59 and never shows a picture: another version within the start budget — never a step-down, never "no picture"',
    async () => {
      const c = await reloadedAt59();
      harness.engine.emit({ type: 'time', position: 59, duration: 60, buffered: 60 });
      await jest.advanceTimersByTimeAsync(31_000);
      await settle();
      expect(harness.server.sent('versions')).toHaveLength(1);
      expect(steppedDown()).toBe(false);
      expect(c.failure?.code).not.toBe('picture_timeout');
      expect((c.failure?.tried ?? []).map((attempt) => attempt.code)).not.toContain(
        'media_damaged'
      );
      await c.stop();
    }
  );

  row(
    'C12',
    'the reload shows its first frame at 0:59 and the clock stands (the watchdog arms a stall): another version, never "damaged data"',
    async () => {
      const c = await reloadedAt59();
      harness.engine.emit({ type: 'time', position: 59, duration: 60, buffered: 60 });
      harness.engine.emit({ type: 'firstFrame' });
      await jest.advanceTimersByTimeAsync(20_000);
      await settle();
      expect(harness.server.sent('versions')).toHaveLength(1);
      expect(steppedDown()).toBe(false);
      expect(c.status.hint?.key).not.toBe('steppingDown');
      await c.stop();
    }
  );

  row(
    'C32',
    'a direct file that stops at the same place after its reload is still damaged data there (S9c seg_corrupt, unchanged)',
    async () => {
      jest.useFakeTimers();
      const media = { durationTicks: 180 * TICKS, audioTracks: [], subtitleTracks: [] };
      const c = await playing(
        {},
        { method: 'direct', engine: 'vlc', mediaInfo: media } as never,
        80
      );
      harness.engine.time(88, 180);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started(180);
      harness.engine.time(88, 180);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      await c.stop();
    }
  );
});

describe('matrix C — S4z3: the last way to play fails: another version before the card', () => {
  row(
    'C12',
    'no picture after the step-downs (picture_timeout on the last method) with versions left: another version, then the card',
    () => {
      const incident = new Incident(0);
      const context = {
        attached: false,
        online: true,
        canLowerQuality: false,
        revision: 2,
        audioFallback: false,
      };
      for (const step of ['R', 'S'] as const)
        incident.record({
          step,
          category: 'T7',
          code: 'picture_timeout',
          position: 59,
          at: 0,
          revision: 1,
        } as never);
      expect(nextStep(incident, { category: 'T7', code: 'picture_timeout' }, context)).toEqual({
        step: 'V',
        delayMs: 0,
      });
      incident.record({
        step: 'V',
        category: 'T7',
        code: 'picture_timeout',
        position: 59,
        at: 0,
        revision: 2,
      } as never);
      expect(nextStep(incident, { category: 'T7', code: 'picture_timeout' }, context).step).toBe(
        'G'
      );
    }
  );
});
