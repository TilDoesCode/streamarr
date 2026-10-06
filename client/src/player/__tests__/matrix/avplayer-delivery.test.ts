import { Platform } from 'react-native';

import { harness, reply } from '@/../jest/player/harness';
import { expoPlaying } from '@/../jest/player/native';
import { fakeNetwork, playing, playOn, settle, starts, TICKS } from '@/../jest/player/play';
import { stepDownReasonKey } from '@/player/overlay-labels';
import {
  deliveryFailure,
  deliveryIssuesOf,
  recentIssue,
  stampIssues,
} from '@/player/recovery/delivery';

// Rows of layer C/D for S4m, in their own file: the native builder appends to C/D in parallel (S6t).
jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());
jest.mock('expo-video', () =>
  jest.requireActual('@/../jest/player/library-fakes').expoVideoModule()
);

beforeEach(() => harness.reset());
afterEach(() => jest.useRealTimers());

/** The AVPlayer `loadError` payloads recorded live in S6t (iPhone 18 Pro, B12 faults). */
const RECORDED = {
  segment404: {
    domain: 'CoreMediaErrorDomain',
    code: -12938,
    comment: 'CoreMediaErrorDomain -12938 - HTTP 404: File Not Found',
    status: 404,
    uri: null,
    trackType: 'other',
  },
  segment503: {
    code: -16849,
    comment: 'CoreMediaErrorDomain -16849 - HTTP 503: Service Unavailable',
    status: 503,
    uri: null,
  },
  subtitlePlaylist404: {
    code: -12938,
    status: 404,
    uri: 'http://server/api/v1/transcode/tok/subtitles/4/main.m3u8',
  },
  audioAbort: {
    domain: 'NSURLErrorDomain',
    code: -1005,
    comment: 'Die Netzwerkverbindung wurde unterbrochen.',
    status: null,
    uri: null,
  },
};

/** The real ExpoVideoEngine turns the recorded payload into its engine event; the controller gets that event. */
async function fromAVPlayer(payload: object, times = 1) {
  const expo = await expoPlaying();
  for (let i = 0; i < times; i++) expo.player.loadError(payload as never);
  const events = expo.events.slice();
  expo.replay();
  expo.engine.release();
  return events;
}

const converting = {
  method: 'transcode',
  mediaInfo: { durationTicks: 600 * TICKS, audioTracks: [], subtitleTracks: [] },
} as never;

describe('AVPlayer delivery failures as recorded in S6t (S4m)', () => {
  it('C10 a video segment 404 (status, no URI, trackType other) is the server losing the playback: a new start at once', async () => {
    jest.useFakeTimers();
    const c = await playing({}, converting, 36);
    harness.engine.emit({ type: 'buffering', buffering: true });
    const events = await fromAVPlayer(RECORDED.segment404);
    expect(events).toEqual([{ type: 'loadRetry', status: 404, audio: false }]);
    await settle();
    expect(starts()).toHaveLength(2);
    expect(starts().at(-1)?.position).toBe(36);
    expect(harness.server.sent('switch')).toHaveLength(0);
    await c.stop();
  });

  it('C11 video segment 503s: "server problem, retrying" at once, then a reload; never "converts slower", never Q', async () => {
    jest.useFakeTimers();
    const c = await playing({}, converting, 30);
    harness.engine.emit({ type: 'buffering', buffering: true });
    for (let second = 0; second < 16; second++) {
      if (second % 2 === 0) await fromAVPlayer(RECORDED.segment503);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.status.hint?.key).not.toBe('serverSlow');
    }
    expect(c.status.hint?.key).toMatch(/^(serverRetrying|serverError|reloading)$/);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    expect(harness.server.sent('switch')).toHaveLength(0);
    await c.stop();
  });

  it('C22 a subtitle playlist 404 (status with URI) is the subtitle path: subtitles off with the notice, no stall, no ladder', async () => {
    jest.useFakeTimers();
    const c = await playing(
      {},
      {
        method: 'transcode',
        mediaInfo: {
          durationTicks: 180 * TICKS,
          audioTracks: [],
          subtitleTracks: [{ index: 4, language: 'en', deliveredAs: 'webvtt', selected: true }],
        },
      } as never,
      20
    );
    harness.engine.emit({
      type: 'tracks',
      tracks: { audio: [], subtitles: [{ id: 's0', label: 'en', language: 'en', selected: true }] },
    });
    const events = await fromAVPlayer(RECORDED.subtitlePlaylist404);
    expect(events).toEqual([{ type: 'subtitleError', code: 'unknown_subtitle_stream' }]);
    expect(c.notice).toMatchObject({ kind: 'subtitleFailed' });
    expect(c.status.hint).toBeNull();
    expect(harness.engine.load).toHaveBeenCalledTimes(1);
    await c.stop();
  });
});

describe('a stream that keeps breaking off while the server answers (S4m)', () => {
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
  ];
  const avplayer = {
    method: 'remux',
    audioRenditions: renditions,
    mediaInfo: {
      durationTicks: 600 * TICKS,
      audioTracks: [
        { index: 1, language: 'de', selected: true, deliveredAs: 'remux', renditionId: '1' },
      ],
      subtitleTracks: [],
    },
  } as never;

  /** -1005 retries every 2 s while the picture stands; the heartbeat keeps answering (or not). */
  async function breaking(seconds: number) {
    for (let second = 0; second < seconds; second++) {
      if (second % 2 === 0) await fromAVPlayer(RECORDED.audioAbort);
      await jest.advanceTimersByTimeAsync(1_000);
    }
  }

  it('D36 online and the heartbeat answers: "the stream keeps breaking off", one reload, then the converted audio (A) before any step-down', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await playing({}, avplayer, 40);
    harness.engine.emit({ type: 'buffering', buffering: true });
    expect(await fromAVPlayer(RECORDED.audioAbort)).toEqual([
      { type: 'loadRetry', status: 0, audio: false },
    ]);
    await breaking(16);
    expect(harness.server.sent('progress').length).toBeGreaterThan(0);
    expect(c.status.hint).toMatchObject({ key: 'streamBreaks' });
    expect(c.status.hint?.key).not.toBe('reconnecting');
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    harness.engine.started();
    harness.engine.emit({ type: 'buffering', buffering: true });
    await breaking(18);
    expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ audioFallback: true });
    expect(harness.server.sent('switch').some((request) => request.body?.stepDown)).toBe(false);
    os.restore();
    await c.stop();
  });

  it("D36 the same breaks while the app's own requests fail too: the connection (T1), not the stream", async () => {
    jest.useFakeTimers();
    const c = await playing({}, avplayer, 40);
    harness.server.answer('progress', ...Array.from({ length: 10 }, () => reply.offline()));
    harness.engine.emit({ type: 'buffering', buffering: true });
    await breaking(18);
    // The connection's ladder (reconnect, reload), never the delivery's wording.
    expect(c.status.hint?.key).toMatch(/^(reconnecting|reloading)$/);
    await c.stop();
  });

  it('D36 web keeps its rules: a status-less hls.js retry is never reclassified by this path', async () => {
    jest.useFakeTimers();
    const c = await playing({ nativeEngine: 'web' } as never, avplayer, 40);
    harness.engine.emit({ type: 'buffering', buffering: true });
    for (let second = 0; second < 18; second++) {
      if (second % 2 === 0) harness.engine.emit({ type: 'loadRetry', status: 0, audio: false });
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(c.status.hint?.key).not.toBe('streamBreaks');
    await c.stop();
  });
});

describe('the server says which part failed: progress deliveryIssues (B15, S4m)', () => {
  it('reads only well-formed issues; everything else is ignored (works before the server ships it)', () => {
    expect(deliveryIssuesOf({ playbackAlive: true })).toEqual([]);
    expect(deliveryIssuesOf({ deliveryIssues: 'x' })).toEqual([]);
    expect(
      deliveryIssuesOf({
        deliveryIssues: [
          {
            kind: 'audioRendition',
            renditionId: '2',
            code: 'segment_unavailable',
            at: '2026-10-06T14:00:00Z',
          },
          { kind: 'video', code: 'x', at: 1 },
          { kind: 'segment', code: 3, at: 1 },
          { kind: 'segment', code: 'segment_unavailable', at: 'yesterday' },
          null,
        ],
      })
    ).toEqual([
      {
        kind: 'audioRendition',
        renditionId: '2',
        code: 'segment_unavailable',
        at: Date.parse('2026-10-06T14:00:00Z'),
      },
    ]);
  });

  const german = {
    method: 'remux',
    mediaInfo: {
      durationTicks: 600 * TICKS,
      audioTracks: [
        { index: 1, language: 'de', selected: true, deliveredAs: 'remux', renditionId: '1' },
        { index: 2, language: 'en', selected: false, deliveredAs: 'remux', renditionId: '2' },
      ],
      subtitleTracks: [],
    },
  } as never;

  it('D36 an audio rendition the server reports while playback is stuck takes the audio path at once', async () => {
    jest.useFakeTimers();
    const c = await playing({}, german, 40);
    harness.engine.emit({ type: 'buffering', buffering: true });
    harness.server.answer(
      'progress',
      reply.ok({
        playbackAlive: true,
        deliveryIssues: [
          { kind: 'audioRendition', renditionId: '1', code: 'segment_unavailable', at: Date.now() },
        ],
      })
    );
    await jest.advanceTimersByTimeAsync(10_500);
    await settle();
    expect(c.status.hint).toMatchObject({ key: 'noAudio' });
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    await c.stop();
  });

  it('C22 a subtitle rendition the server reports turns the subtitles off with the notice', async () => {
    jest.useFakeTimers();
    const c = await playing(
      {},
      {
        method: 'remux',
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: [],
          subtitleTracks: [{ index: 3, language: 'de', deliveredAs: 'webvtt', selected: true }],
        },
      } as never,
      40
    );
    harness.engine.emit({
      type: 'tracks',
      tracks: { audio: [], subtitles: [{ id: 's0', label: 'de', language: 'de', selected: true }] },
    });
    harness.server.answer(
      'progress',
      reply.ok({
        playbackAlive: true,
        deliveryIssues: [
          { kind: 'subtitleRendition', code: 'unknown_subtitle_stream', at: Date.now() },
        ],
      })
    );
    await jest.advanceTimersByTimeAsync(10_500);
    expect(c.notice).toMatchObject({ kind: 'subtitleFailed' });
    expect(c.phase).toBe('playing');
    await c.stop();
  });

  it('an old issue (over a minute on the server clock, which runs 10 min ahead) explains nothing (verify P6)', async () => {
    jest.useFakeTimers();
    const c = await playing({}, german, 40);
    harness.engine.emit({ type: 'buffering', buffering: true });
    const serverNow = Date.now() + 600_000;
    harness.server.answer(
      'progress',
      reply.okAt(
        {
          playbackAlive: true,
          deliveryIssues: [{ kind: 'audioRendition', code: 'x', at: serverNow - 300_000 }],
        },
        serverNow + 10_500
      )
    );
    await jest.advanceTimersByTimeAsync(10_500);
    expect(c.status.hint?.key).not.toBe('noAudio');
    expect(harness.engine.load).toHaveBeenCalledTimes(1);
    await c.stop();
  });
});

describe('a corrupt segment AVPlayer drops without any error: only a stall (S4m)', () => {
  it('D41 the stall wording stays neutral and a later step-down never claims "this device can\'t decode"', async () => {
    jest.useFakeTimers();
    const c = await playing({}, converting, 50);
    harness.engine.emit({ type: 'buffering', buffering: true });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(c.status.hint).toMatchObject({ key: 'buffering' });
    for (const reason of ['playback_stalled', 'seek_stalled', 'picture_frozen', 'video_stalled'])
      expect(stepDownReasonKey({ reason })).toBe('notice.because.stalled');
    expect(stepDownReasonKey({ reason: 'decode_error' })).toBe('notice.because.T7');
    await c.stop();
  });
});

/** AVPlayer with one German audio rendition (S4n rows). */
const avplayerMedia = {
  method: 'remux',
  audioRenditions: [
    {
      id: '1',
      streamIndex: 1,
      language: 'de',
      label: 'Deutsch',
      channels: 2,
      codec: 'aac',
      default: true,
    },
  ],
  mediaInfo: {
    durationTicks: 600 * TICKS,
    audioTracks: [
      { index: 1, language: 'de', selected: true, deliveredAs: 'remux', renditionId: '1' },
    ],
    subtitleTracks: [],
  },
} as never;
/** German plays (rendition 1), English (rendition 2) is the other track. */
const germanAudio = {
  method: 'remux',
  mediaInfo: {
    durationTicks: 600 * TICKS,
    audioTracks: [
      { index: 1, language: 'de', selected: true, deliveredAs: 'remux', renditionId: '1' },
      { index: 2, language: 'en', selected: false, deliveredAs: 'remux', renditionId: '2' },
    ],
    subtitleTracks: [],
  },
} as never;

/** The codes the recovery ladder acted on in the current incident. */
const attempted = (c: object) =>
  (c as { runner: { attempts: { code: string }[] } }).runner.attempts.map(
    (attempt) => attempt.code
  );

describe('verify F11/F12/S4l/S4m: delivery and issue rules (S4n)', () => {
  const now = () => Date.now();
  const audioIssue = (at = now()) =>
    stampIssues([], [{ kind: 'audioRendition', code: 'x', at }], now())[0]!;

  it('a reported issue refines a stall or a delivery break, never offline, TLS or a real decoder failure (P5)', () => {
    const base = { serverOkAt: 0, brokeAt: now(), now: now(), issue: audioIssue() };
    const offline = deliveryFailure(
      { category: 'T1', code: 'stream_interrupted' },
      { ...base, online: false }
    );
    expect(offline.category).toBe('T1');
    expect(
      deliveryFailure({ category: 'T1', code: 'tls_error' }, { ...base, online: true }).code
    ).toBe('tls_error');
    expect(
      deliveryFailure({ category: 'T7', code: 'decode_error' }, { ...base, online: true }).code
    ).toBe('decode_error');
    for (const code of ['playback_stalled', 'segment_unavailable', 'player_load_failed'])
      expect(
        deliveryFailure(
          {
            category:
              code === 'playback_stalled' ? 'T5' : code === 'segment_unavailable' ? 'T6' : 'T11',
            code,
          },
          { ...base, online: true }
        ).code
      ).toBe('audio_rendition_failed');
    expect(
      deliveryFailure({ category: 'T1', code: 'stream_interrupted' }, { ...base, online: true })
        .code
    ).toBe('audio_rendition_failed');
  });

  it('only a request SENT after the break began proves the server: an answer already in flight does not (R-1)', () => {
    const t0 = now();
    const failure = { category: 'T1' as const, code: 'stream_interrupted' };
    const context = { online: true, brokeAt: t0, now: t0 + 5_000, issue: null };
    expect(deliveryFailure(failure, { ...context, serverOkAt: t0 - 500 }).category).toBe('T1');
    expect(deliveryFailure(failure, { ...context, serverOkAt: t0 + 1_000 }).code).toBe(
      'delivery_interrupted'
    );
  });

  it('a network handover (Wi-Fi to cellular) close to the break is the connection, even when the heartbeat answers (R-1)', () => {
    const t0 = now();
    const failure = { category: 'T1' as const, code: 'stream_interrupted' };
    const context = {
      online: true,
      brokeAt: t0,
      now: t0 + 5_000,
      serverOkAt: t0 + 1_000,
      issue: null,
    };
    expect(deliveryFailure(failure, { ...context, networkChangedAt: t0 + 500 }).category).toBe(
      'T1'
    );
    expect(deliveryFailure(failure, { ...context, networkChangedAt: t0 - 60_000 }).code).toBe(
      'delivery_interrupted'
    );
  });

  it('issue age is the server clock (Date header) or the first answer that named it, never the device clock (P6)', () => {
    const serverNow = now() + 600_000;
    const answer = {
      deliveryIssues: [{ kind: 'segment', code: 'x', at: serverNow - 300_000 }],
    };
    const old = stampIssues([], deliveryIssuesOf(answer, serverNow), now());
    expect(recentIssue(old, now())).toBeNull();
    // No server time: the first answer that named it starts its age; the same issue later keeps that start.
    const first = stampIssues([], deliveryIssuesOf(answer), now());
    expect(recentIssue(first, now())).not.toBeNull();
    const again = stampIssues(first, deliveryIssuesOf(answer), now() + 70_000);
    expect(recentIssue(again, now() + 70_000)).toBeNull();
  });

  it('an ISO time without a zone is rejected (a local-time reading would shift it)', () => {
    expect(
      deliveryIssuesOf({
        deliveryIssues: [{ kind: 'segment', code: 'x', at: '2026-10-06T14:00:00' }],
      })
    ).toEqual([]);
    expect(
      deliveryIssuesOf({
        deliveryIssues: [{ kind: 'segment', code: 'x', at: '2026-10-06T14:00:00+02:00' }],
      })
    ).toHaveLength(1);
  });

  it('C3 a break while the device reports offline stays the connection (T1), even with answering heartbeats', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const network = fakeNetwork();
    const c = await playing({ network }, avplayerMedia, 40);
    harness.engine.emit({ type: 'buffering', buffering: true });
    network.set(false);
    for (let second = 0; second < 18; second++) {
      if (second % 2 === 0) harness.engine.emit({ type: 'loadRetry', status: 0, audio: false });
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(c.status.hint?.key).not.toBe('streamBreaks');
    expect(c.status.hint).toMatchObject({ key: 'offline' });
    expect(attempted(c)).not.toContain('delivery_interrupted');
    os.restore();
    await c.stop();
  });

  it('a heartbeat sent before the break and answered after it is no proof: still the connection', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await playing({}, avplayerMedia, 40);
    let answer: (value: ReturnType<typeof reply.ok>) => void = () => undefined;
    harness.server.answer(
      'progress',
      () => new Promise((resolve) => (answer = resolve)),
      ...Array.from({ length: 10 }, () => reply.offline())
    );
    // The heartbeat goes out at 0:10, the media break begins half a second later, the answer lands a second after that.
    await jest.advanceTimersByTimeAsync(10_000);
    await jest.advanceTimersByTimeAsync(500);
    harness.engine.emit({ type: 'buffering', buffering: true });
    harness.engine.emit({ type: 'loadRetry', status: 0, audio: false });
    await jest.advanceTimersByTimeAsync(1_000);
    answer(reply.ok({ playbackAlive: true }));
    for (let second = 0; second < 18; second++) {
      if (second % 2 === 0) harness.engine.emit({ type: 'loadRetry', status: 0, audio: false });
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(c.status.hint?.key).not.toBe('streamBreaks');
    expect(attempted(c)).toContain('stream_interrupted');
    expect(attempted(c)).not.toContain('delivery_interrupted');
    os.restore();
    await c.stop();
  });

  it('a Wi-Fi to cellular handover during the break keeps the connection wording (no audio fallback)', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const network = fakeNetwork();
    const c = await playing({ network }, avplayerMedia, 40);
    network.set(true, 'wifi');
    await playOn(30);
    harness.engine.emit({ type: 'buffering', buffering: true });
    harness.engine.emit({ type: 'loadRetry', status: 0, audio: false });
    network.set(true, 'cellular');
    for (let second = 0; second < 18; second++) {
      if (second % 2 === 0) harness.engine.emit({ type: 'loadRetry', status: 0, audio: false });
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(c.status.hint?.key).not.toBe('streamBreaks');
    expect(attempted(c)).toContain('stream_interrupted');
    expect(attempted(c)).not.toContain('delivery_interrupted');
    os.restore();
    await c.stop();
  });

  it('C7 issues of another playback are ignored, and a new start of another playback forgets the old ones', async () => {
    jest.useFakeTimers();
    const c = await playing({}, germanAudio, 40);
    const issue = { kind: 'audioRendition', renditionId: '1', code: 'x', at: Date.now() };
    // An answer to a report of an older playback (queued, sent late) names an issue: not this playback's.
    const answer = (
      c as unknown as { onProgressAnswer(value: object): void }
    ).onProgressAnswer.bind(c);
    harness.engine.emit({ type: 'buffering', buffering: true });
    answer({
      report: { playbackId: 'elsewhere', event: 'progress' },
      playbackAlive: true,
      deliveryIssues: deliveryIssuesOf({ deliveryIssues: [issue] }),
      sentAt: Date.now(),
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(c.status.hint?.key).not.toBe('noAudio');
    expect(harness.engine.load).toHaveBeenCalledTimes(1);
    // This playback's issue is stored (no stall now) …
    harness.engine.emit({ type: 'buffering', buffering: false });
    harness.engine.time(41);
    answer({
      report: { playbackId: c.playback!.playbackId, event: 'progress' },
      playbackAlive: true,
      deliveryIssues: deliveryIssuesOf({ deliveryIssues: [issue] }),
      sentAt: Date.now(),
    });
    // … then the server loses the playback and a new one starts: the old playback's issue explains nothing there.
    harness.server.answer(
      'start',
      reply.ok(harness.server.playback({ ...(germanAudio as object), playbackId: 'new' } as never))
    );
    harness.server.answer('progress', ...Array.from({ length: 10 }, () => reply.offline()));
    harness.engine.fail('Source error: InvalidResponseCodeException: Response code: 410');
    await settle();
    harness.engine.started();
    harness.engine.time(42);
    harness.engine.emit({ type: 'buffering', buffering: true });
    await jest.advanceTimersByTimeAsync(16_000);
    expect(c.playback?.playbackId).toBe('new');
    expect(harness.server.sent('switch').some((request) => request.body?.audioFallback)).toBe(
      false
    );
    expect(c.status.hint?.key).not.toBe('noAudio');
    await c.stop();
  });

  it('S4m-2 an issue of another audio rendition leaves the playing one alone', async () => {
    jest.useFakeTimers();
    const c = await playing({}, germanAudio, 40);
    harness.engine.emit({ type: 'buffering', buffering: true });
    harness.server.answer(
      'progress',
      reply.ok({
        playbackAlive: true,
        deliveryIssues: [{ kind: 'audioRendition', renditionId: '2', code: 'x', at: Date.now() }],
      })
    );
    await jest.advanceTimersByTimeAsync(10_500);
    expect(c.status.hint?.key).not.toBe('noAudio');
    expect(harness.engine.load).toHaveBeenCalledTimes(1);
    await c.stop();
  });

  it('S4m-2 an issue of another subtitle rendition leaves the shown one on (P7)', async () => {
    jest.useFakeTimers();
    const c = await playing(
      {},
      {
        method: 'remux',
        mediaInfo: {
          durationTicks: 600 * TICKS,
          audioTracks: [],
          subtitleTracks: [{ index: 3, language: 'de', deliveredAs: 'webvtt', selected: true }],
        },
      } as never,
      40
    );
    harness.engine.emit({
      type: 'tracks',
      tracks: { audio: [], subtitles: [{ id: 's0', label: 'de', language: 'de', selected: true }] },
    });
    harness.server.answer(
      'progress',
      reply.ok({
        playbackAlive: true,
        deliveryIssues: [
          {
            kind: 'subtitleRendition',
            renditionId: '7',
            code: 'unknown_subtitle_stream',
            at: Date.now(),
          },
        ],
      })
    );
    await jest.advanceTimersByTimeAsync(10_500);
    expect(c.notice?.kind).not.toBe('subtitleFailed');
    harness.server.answer(
      'progress',
      reply.ok({
        playbackAlive: true,
        deliveryIssues: [
          {
            kind: 'subtitleRendition',
            renditionId: '3',
            code: 'unknown_subtitle_stream',
            at: Date.now(),
          },
        ],
      })
    );
    await jest.advanceTimersByTimeAsync(10_000);
    expect(c.notice).toMatchObject({ kind: 'subtitleFailed' });
    await c.stop();
  });
});

describe('AVPlayer turns the subtitles off for a stall only when nothing else explains it (S4n, verify P2)', () => {
  const subtitled = {
    method: 'transcode',
    mediaInfo: {
      durationTicks: 600 * TICKS,
      audioTracks: [],
      subtitleTracks: [{ index: 2, language: 'en', deliveredAs: 'webvtt', selected: true }],
    },
  } as never;
  const shown = (selected: boolean) => ({
    audio: [],
    subtitles: [{ id: 's0', label: 'en', language: 'en', selected }],
  });
  async function stalledWithSubtitles() {
    const c = await playing({}, subtitled, 45);
    harness.engine.emit({ type: 'tracks', tracks: shown(true) });
    harness.engine.emit({ type: 'buffering', buffering: true });
    harness.engine.state('buffering');
    return c;
  }
  const subtitleCommands = () =>
    harness.engine.commands.filter((command) => command.startsWith('subtitle:'));

  it('a stall explained by a 503 retry run keeps the subtitles on: the server hint, not "subtitles failed"', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await stalledWithSubtitles();
    for (let second = 0; second < 16; second++) {
      if (second % 3 === 0) harness.engine.emit({ type: 'loadRetry', status: 503, audio: false });
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(subtitleCommands()).not.toContain('subtitle:null');
    expect(c.notice?.kind).not.toBe('subtitleFailed');
    os.restore();
    await c.stop();
  });

  it('a stall explained by a status-0 run (-1005) or offline keeps the subtitles on too', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await stalledWithSubtitles();
    for (let second = 0; second < 16; second++) {
      if (second % 2 === 0) harness.engine.emit({ type: 'loadRetry', status: 0, audio: false });
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(subtitleCommands()).not.toContain('subtitle:null');
    os.restore();
    await c.stop();
  });

  it('an unexplained stall drops them, and they come back once playback runs again; a second stall is never "off for good"', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await stalledWithSubtitles();
    await jest.advanceTimersByTimeAsync(16_000);
    expect(subtitleCommands().at(-1)).toBe('subtitle:null');
    expect(c.notice).toMatchObject({ kind: 'subtitleFailed', params: { retry: 'later' } });
    // Still stuck a minute later (the ladder reloads, no picture yet): the subtitles stay off meanwhile.
    harness.engine.emit({ type: 'tracks', tracks: shown(false) });
    await jest.advanceTimersByTimeAsync(61_000);
    expect(subtitleCommands().at(-1)).toBe('subtitle:null');
    harness.engine.started();
    // Playback runs again: after the retry interval of healthy play the viewer's subtitles are back.
    harness.engine.emit({ type: 'tracks', tracks: shown(false) });
    harness.engine.state('playing');
    harness.engine.emit({ type: 'buffering', buffering: false });
    for (let second = 0; second < 62; second++) {
      harness.engine.time(46 + second);
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(subtitleCommands().at(-1)).toBe('subtitle:s0');
    // A second unexplained stall within two minutes: dropped again, and again only until playback runs.
    harness.engine.emit({ type: 'tracks', tracks: shown(true) });
    harness.engine.emit({ type: 'buffering', buffering: true });
    harness.engine.state('buffering');
    await jest.advanceTimersByTimeAsync(16_000);
    expect(subtitleCommands().at(-1)).toBe('subtitle:null');
    expect(c.notice).toMatchObject({ kind: 'subtitleFailed', params: { retry: 'later' } });
    harness.engine.emit({ type: 'tracks', tracks: shown(false) });
    harness.engine.state('playing');
    harness.engine.emit({ type: 'buffering', buffering: false });
    for (let second = 0; second < 62; second++) {
      harness.engine.time(130 + second);
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(subtitleCommands().at(-1)).toBe('subtitle:s0');
    // A stall drop is no subtitle failure: a real one afterwards is still the first, retried later (never off for good).
    harness.engine.emit({ type: 'tracks', tracks: shown(true) });
    harness.engine.emit({ type: 'subtitleError', code: 'subtitle_unavailable' });
    expect(c.notice).toMatchObject({ kind: 'subtitleFailed', params: { retry: 'later' } });
    os.restore();
    await c.stop();
  });
});
