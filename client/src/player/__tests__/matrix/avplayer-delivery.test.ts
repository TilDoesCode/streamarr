import { Platform } from 'react-native';

import { harness, newController, reply } from '@/../jest/player/harness';
import { expoPlaying } from '@/../jest/player/native';
import { fakeNetwork, playing, playOn, settle, starts, TICKS } from '@/../jest/player/play';
import { failureReason, isFailedLoad } from '@/player/engines/native-probe';
import { stepDownReasonKey } from '@/player/overlay-labels';
import { classify } from '@/player/recovery/classify';
import {
  deliveryFailure,
  deliveryIssuesOf,
  recentIssue,
  issuesFor,
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
  it('C10 a video segment 404 (status, no URI, trackType other) of a playback the server lost: a new start at once', async () => {
    jest.useFakeTimers();
    const c = await playing({}, converting, 36);
    harness.server.answer('poll', reply.error(404, 'playback_not_found'));
    harness.engine.emit({ type: 'buffering', buffering: true });
    const events = await fromAVPlayer(RECORDED.segment404);
    expect(events).toEqual([{ type: 'loadRetry', status: 404, audio: false }]);
    await settle();
    expect(starts()).toHaveLength(2);
    expect(starts().at(-1)?.position).toBe(36);
    expect(harness.server.sent('switch')).toHaveLength(0);
    await c.stop();
  });

  it('C10 the server still has the playback (seg_status fault): no new start per retry; the stall ladder starts anew once, bounded (S4p)', async () => {
    jest.useFakeTimers();
    const c = await playing({}, converting, 36);
    harness.engine.emit({ type: 'buffering', buffering: true });
    for (let second = 0; second < 14; second++) {
      if (second % 2 === 0) await fromAVPlayer(RECORDED.segment404);
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(starts()).toHaveLength(1);
    for (let second = 0; second < 4; second++) {
      await fromAVPlayer(RECORDED.segment404);
      await jest.advanceTimersByTimeAsync(1_000);
    }
    await settle();
    expect(starts()).toHaveLength(2);
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
      { type: 'loadRetry', status: 0, audio: false, brokeOff: true },
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
          {
            kind: 'subtitleRendition',
            subtitleStreamIndex: 3,
            code: 'unknown_subtitle_stream',
            at: Date.now(),
          },
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
    for (const code of ['playback_stalled', 'segment_unavailable'])
      expect(
        deliveryFailure(
          { category: code === 'playback_stalled' ? 'T5' : 'T6', code },
          { ...base, online: true }
        ).code
      ).toBe('audio_rendition_failed');
    // A load failure of the app's own engine is no stall: a server issue never renames it (S4q R4).
    expect(
      deliveryFailure({ category: 'T11', code: 'player_load_failed' }, { ...base, online: true })
        .code
    ).toBe('player_load_failed');
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
            subtitleStreamIndex: 7,
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
            subtitleStreamIndex: 3,
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

  it('an unexplained stall drops them quietly; the picture back says they blocked, back after a healthy minute; a second stall of the track keeps them off for this video (S4p R1)', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await stalledWithSubtitles();
    await jest.advanceTimersByTimeAsync(16_000);
    expect(subtitleCommands().at(-1)).toBe('subtitle:null');
    expect(c.notice).toBeNull();
    // Playback runs again with them off: they blocked AVPlayer; after a healthy minute the viewer's subtitles are back.
    harness.engine.emit({ type: 'tracks', tracks: shown(false) });
    harness.engine.state('playing');
    harness.engine.emit({ type: 'buffering', buffering: false });
    harness.engine.time(harness.engine.getSnapshot().position + 0.5);
    expect(c.notice).toMatchObject({ kind: 'subtitleFailed', params: { retry: 'later' } });
    for (let second = 0; second < 62; second++) {
      harness.engine.time(46 + second);
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(subtitleCommands().at(-1)).toBe('subtitle:s0');
    // A second stall of the same track in this playback: off for this video, with the way to turn them on (S4p R1).
    harness.engine.emit({ type: 'tracks', tracks: shown(true) });
    harness.engine.emit({ type: 'buffering', buffering: true });
    harness.engine.state('buffering');
    await jest.advanceTimersByTimeAsync(16_000);
    expect(subtitleCommands().at(-1)).toBe('subtitle:null');
    harness.engine.emit({ type: 'tracks', tracks: shown(false) });
    harness.engine.state('playing');
    harness.engine.emit({ type: 'buffering', buffering: false });
    harness.engine.time(harness.engine.getSnapshot().position + 0.5);
    expect(c.notice).toMatchObject({ kind: 'subtitleFailed', params: { retry: '' } });
    for (let second = 0; second < 180; second++) {
      harness.engine.time(130 + second);
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(subtitleCommands().at(-1)).toBe('subtitle:null');
    os.restore();
    await c.stop();
  });
});

describe('S4o: the native live rows of S6t, S6u and S6v', () => {
  const subtitledAVPlayer = {
    method: 'remux',
    mediaInfo: {
      durationTicks: 600 * TICKS,
      audioTracks: [],
      subtitleTracks: [{ index: 5, language: 'de', deliveredAs: 'webvtt', selected: true }],
    },
  } as never;
  const shownSubtitles = {
    audio: [],
    subtitles: [{ id: 's0', label: 'de', language: 'de', selected: true }],
  };
  /** S6u, Apple TV: a 404 on a selected WebVTT segment arrives without a URI (only the playlist carries one). */
  const subtitleSegment404 = {
    domain: 'CoreMediaErrorDomain',
    code: -12938,
    comment: 'CoreMediaErrorDomain -12938 - HTTP 404: File Not Found',
    status: 404,
    uri: null,
  };

  it('S6t: an AVPlayer -12318 note ("segment exceeds the bandwidth") is no failure: no event, no status-0 retry', async () => {
    const events = await fromAVPlayer({
      domain: 'CoreMediaErrorDomain',
      code: -12318,
      comment: 'Segment exceeds specified bandwidth for variant',
      uri: 'http://server/api/v1/transcode/tok/video/0.m4s',
      status: null,
    });
    expect(events).toEqual([]);
  });

  it('V2 Apple TV: a URI-less 404 while picture, clock and the forced subtitle run (AVPlayer reading video ahead) blames nobody: the subtitle stays on, no notice, no new start; the stall decides', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await playing({}, subtitledAVPlayer, 30);
    harness.engine.emit({ type: 'tracks', tracks: shownSubtitles });
    await playOn(3);
    const events = await fromAVPlayer(subtitleSegment404);
    expect(events).toEqual([{ type: 'loadRetry', status: 404, audio: false }]);
    // The server is asked first (one status read): it still has the playback, so nothing is decided yet.
    await settle();
    expect(harness.server.sent('poll')).toHaveLength(1);
    expect(harness.engine.commands).not.toContain('subtitle:null');
    expect(c.notice?.kind).not.toBe('subtitleFailed');
    expect(c.currentSubtitle()).toBe(5);
    expect(starts()).toHaveLength(1);
    // The video segments 404 too: once the buffer runs dry the stall ladder takes it (the quiet subtitle try first).
    await playOn(3);
    harness.engine.emit({ type: 'buffering', buffering: true });
    harness.engine.state('buffering');
    await jest.advanceTimersByTimeAsync(16_000);
    expect(c.notice?.kind).not.toBe('subtitleFailed');
    os.restore();
    await c.stop();
  });

  it('S6u control: the same 404 during a stall, the server still has the playback: no new start per retry, no subtitle notice; the stall ladder decides (S4p)', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await playing({}, subtitledAVPlayer, 30);
    harness.engine.emit({ type: 'tracks', tracks: shownSubtitles });
    await playOn(3);
    harness.engine.emit({ type: 'buffering', buffering: true });
    for (let retry = 0; retry < 5; retry++) {
      await fromAVPlayer(subtitleSegment404);
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(starts()).toHaveLength(1);
    expect(c.notice?.kind).not.toBe('subtitleFailed');
    // One status read for the whole retry run (an "alive" answer holds 10 s).
    expect(harness.server.sent('poll')).toHaveLength(1);
    os.restore();
    await c.stop();
  });

  it('S6u control: subtitles shown but the clock stands (no time event for 2 s), server alive: not the subtitles, no restart either', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await playing({}, subtitledAVPlayer, 30);
    harness.engine.emit({ type: 'tracks', tracks: shownSubtitles });
    await playOn(3);
    await jest.advanceTimersByTimeAsync(2_500);
    await fromAVPlayer(subtitleSegment404);
    await settle();
    expect(starts()).toHaveLength(1);
    expect(c.notice?.kind).not.toBe('subtitleFailed');
    os.restore();
    await c.stop();
  });

  it('S6u: a stall on a playback the server lost restarts first: "Restarting at …", never a stall hint before it', async () => {
    jest.useFakeTimers();
    const c = await playing({}, subtitledAVPlayer, 30);
    harness.server.answer('poll', reply.error(404, 'playback_not_found'));
    harness.engine.emit({ type: 'buffering', buffering: true });
    const hints: (string | undefined)[] = [];
    for (let step = 0; step < 12; step++) {
      await jest.advanceTimersByTimeAsync(250);
      hints.push(c.status.hint?.key);
    }
    expect(starts()).toHaveLength(2);
    expect(starts().at(-1)?.position).toBe(30);
    expect(hints.filter(Boolean).every((key) => key === 'restarting')).toBe(true);
    expect(hints).toContain('restarting');
    await c.stop();
  });

  it('S6u control: a playback the server still has stalls as before (one status read, no new start)', async () => {
    jest.useFakeTimers();
    const c = await playing({}, subtitledAVPlayer, 30);
    harness.engine.emit({ type: 'buffering', buffering: true });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(harness.server.sent('poll')).toHaveLength(1);
    expect(starts()).toHaveLength(1);
    expect(c.status.hint?.key).toBe('buffering');
    await c.stop();
  });

  it("S6u: behind the failure card the AVPlayer source is unloaded and stays quiet; the card's Retry loads it again", async () => {
    const expo = await expoPlaying();
    await expo.engine.shutdown?.();
    expect(expo.player.calls).toContain('pause');
    expect(expo.player.replaced.at(-1)).toBeNull();
    expo.events.length = 0;
    expo.player.setStatus('loading');
    expo.player.fire('timeUpdate', { currentTime: 12, bufferedPosition: 20 });
    expect(expo.events).toEqual([]);
    expo.engine.load({ uri: 'http://server/media.m3u8', kind: 'hls' });
    expect(expo.player.replaced.at(-1)).toMatchObject({ uri: 'http://server/media.m3u8' });
    // The reloaded source talks again.
    expo.events.length = 0;
    expo.player.setStatus('readyToPlay');
    expect(expo.events.some((event) => event.type === 'state')).toBe(true);
    expo.engine.release();
  });

  it('S6v: a burst of native state, buffering and time events reaches the listeners once per real change', async () => {
    jest.useFakeTimers();
    const c = await playing({}, subtitledAVPlayer, 30);
    let heard = 0;
    const off = c.subscribe(() => (heard += 1));
    for (let i = 0; i < 100; i++) harness.engine.emit({ type: 'state', state: 'playing' });
    expect(heard).toBe(0);
    harness.engine.emit({ type: 'state', state: 'buffering' });
    expect(heard).toBe(1);
    for (let i = 0; i < 100; i++) {
      harness.engine.emit({ type: 'state', state: 'buffering' });
      harness.engine.emit({ type: 'buffering', buffering: true });
    }
    expect(heard).toBe(1);
    harness.engine.emit({ type: 'tracks', tracks: shownSubtitles });
    expect(heard).toBe(2);
    // Playing again ends the stall and the state in one event: one notification, not one per change.
    harness.engine.emit({ type: 'state', state: 'playing' });
    expect(heard).toBe(3);
    off();
    await c.stop();
  });

  it('S6v: back online the offline hint goes at once, even when the NetInfo event is late (the state is read again)', async () => {
    jest.useFakeTimers();
    let reachable = false;
    const network = Object.assign(fakeNetwork(), { refresh: jest.fn(async () => reachable) });
    const c = await playing({ network }, subtitledAVPlayer, 30);
    network.set(false);
    expect(c.status.hint).toMatchObject({ key: 'offline' });
    await jest.advanceTimersByTimeAsync(6_000);
    expect(c.status.hint).toMatchObject({ key: 'offline' });
    reachable = true;
    await jest.advanceTimersByTimeAsync(3_000);
    expect(c.offline).toBe(false);
    expect(c.status.hint).toBeNull();
    const reads = network.refresh.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(network.refresh.mock.calls.length).toBe(reads);
    await c.stop();
  });
});

describe('S4p: code review S4n/S4o/S6t-S6v — the reviewer probes P1-P6 and the test gaps', () => {
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
  const off = { audio: [], subtitles: [{ ...shown.subtitles[0]!, selected: false }] };
  const segment404 = {
    domain: 'CoreMediaErrorDomain',
    code: -12938,
    comment: 'CoreMediaErrorDomain -12938 - HTTP 404: File Not Found',
    status: 404,
    uri: null,
  };

  it('P1 (B2) an Exo HLS manifest parse error (captive portal HTML) is the network, never "damaged media"', () => {
    const portal = failureReason(
      {
        errorCodeName: 'ERROR_CODE_PARSING_MANIFEST_MALFORMED',
        message:
          'Source error: androidx.media3.common.ParserException: Input does not start with the #EXTM3U header.',
      } as never,
      false,
      true
    );
    expect(classify({ kind: 'engine', engine: 'expo-video', reason: portal })).toMatchObject({
      category: 'T1',
      code: 'network_intercepted',
    });
    const container = failureReason(
      {
        errorCodeName: 'ERROR_CODE_PARSING_CONTAINER_MALFORMED',
        message: 'Source error: ParserException: Skipping atom with length > 2147483647',
      } as never,
      true,
      true
    );
    expect(classify({ kind: 'engine', engine: 'expo-video', reason: container }).code).toBe(
      'media_damaged'
    );
    const otherManifest = failureReason(
      { errorCodeName: 'ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED', message: 'bad tag' } as never,
      false,
      true
    );
    expect(classify({ kind: 'engine', engine: 'expo-video', reason: otherManifest }).code).toBe(
      'unexpected_format'
    );
  });

  it('P2 (B3) a URI-less 404 while paused starts no new playback and asks nothing until play', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await playing({}, subtitled, 30);
    harness.engine.emit({ type: 'tracks', tracks: shown });
    await playOn(3);
    c.setPaused(true);
    harness.engine.emit({ type: 'state', state: 'paused' });
    for (let i = 0; i < 4; i++) {
      await fromAVPlayer(segment404);
      await jest.advanceTimersByTimeAsync(3_000);
    }
    expect(starts()).toHaveLength(1);
    expect(harness.server.sent('poll')).toHaveLength(0);
    os.restore();
    await c.stop();
  });

  it('T1 a URI-less 404 before the first picture is no subtitle failure (server alive)', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    harness.server.answer('start', reply.ok(harness.server.playback(subtitled)));
    const c = newController();
    await c.start();
    harness.engine.state('playing');
    harness.engine.emit({ type: 'tracks', tracks: shown });
    harness.engine.time(0.3);
    await fromAVPlayer(segment404);
    await settle();
    expect(c.notice?.kind).not.toBe('subtitleFailed');
    expect(starts()).toHaveLength(1);
    os.restore();
    await c.stop();
  });

  it('P3 (B4) a URI-less 404 of a playback the server LOST is a new start at once, never "subtitles failed"', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await playing({}, subtitled, 30);
    harness.engine.emit({ type: 'tracks', tracks: shown });
    await playOn(3);
    harness.server.answer('poll', reply.error(404, 'playback_not_found'));
    await fromAVPlayer(segment404);
    await settle();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(c.notice?.kind).not.toBe('subtitleFailed');
    expect(starts().length).toBeGreaterThan(1);
    // The viewer's subtitles go along to the new start.
    expect(starts().at(-1)?.body.subtitleStreamIndex).toBe(5);
    os.restore();
    await c.stop();
  });

  it('P6 (B5) the in-flight retry of the same subtitle segment after the subtitles went off is no new start', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await playing({}, subtitled, 30);
    harness.engine.emit({ type: 'tracks', tracks: shown });
    await playOn(3);
    harness.engine.emit({ type: 'subtitleError', code: 'unknown_subtitle_stream' });
    await settle();
    expect(c.notice).toMatchObject({ kind: 'subtitleFailed' });
    harness.engine.emit({ type: 'tracks', tracks: off });
    harness.engine.time(34);
    await fromAVPlayer(segment404);
    await settle();
    expect(starts()).toHaveLength(1);
    os.restore();
    await c.stop();
  });

  it('P4 (R1) a subtitle rendition that blocks AVPlayer each time it is shown ends after two stalls, never a loop', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const sub = (selected: boolean) => ({
      audio: [],
      subtitles: [{ id: 's0', label: 'en', language: 'en', selected }],
    });
    const c = await playing(
      {},
      {
        method: 'transcode',
        mediaInfo: {
          durationTicks: 6000 * TICKS,
          audioTracks: [],
          subtitleTracks: [{ index: 2, language: 'en', deliveredAs: 'webvtt', selected: true }],
        },
      } as never,
      45
    );
    let drops = 0;
    let at = 46;
    for (let cycle = 0; cycle < 5; cycle++) {
      harness.engine.commands.length = 0;
      // Whatever the engine was told, the track comes back only if the player shows it again.
      if (cycle === 0 || harness.engine.getSnapshot().tracks.subtitles[0]?.selected)
        harness.engine.emit({ type: 'tracks', tracks: sub(true) });
      if (!harness.engine.getSnapshot().tracks.subtitles[0]?.selected) break;
      harness.engine.emit({ type: 'buffering', buffering: true });
      harness.engine.state('buffering');
      await jest.advanceTimersByTimeAsync(16_000);
      if (harness.engine.commands.includes('subtitle:null')) drops += 1;
      harness.engine.emit({ type: 'tracks', tracks: sub(false) });
      harness.engine.state('playing');
      harness.engine.emit({ type: 'buffering', buffering: false });
      for (let second = 0; second < 62; second++) {
        harness.engine.time(at++);
        await jest.advanceTimersByTimeAsync(1_000);
        // The player shows the subtitles again: the engine echoes the selection.
        if (
          harness.engine.commands.at(-1) === 'subtitle:s0' &&
          !harness.engine.getSnapshot().tracks.subtitles[0]?.selected
        )
          harness.engine.emit({ type: 'tracks', tracks: sub(true) });
      }
    }
    expect(drops).toBe(2);
    expect(c.notice).toMatchObject({ kind: 'subtitleFailed', params: { retry: '' } });
    os.restore();
    await c.stop();
  });

  it('R1 a dropped subtitle comes back only after a whole healthy minute, not at a stall that just ended', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await playing({}, subtitled, 30);
    harness.engine.emit({ type: 'tracks', tracks: shown });
    await playOn(3);
    harness.engine.emit({ type: 'subtitleError', code: 'subtitle_unavailable' });
    harness.engine.emit({ type: 'tracks', tracks: off });
    // 50 s of play, a 12 s stall, then playing again: the minute starts over at the stall's END, not its start.
    await playOn(50);
    harness.engine.emit({ type: 'buffering', buffering: true });
    await jest.advanceTimersByTimeAsync(12_000);
    harness.engine.emit({ type: 'buffering', buffering: false });
    await playOn(59);
    expect(harness.engine.commands.at(-1)).toBe('subtitle:null');
    await playOn(3);
    expect(harness.engine.commands.at(-1)).toBe('subtitle:s0');
    os.restore();
    await c.stop();
  });

  it("R3 only network errors and HTTP 4xx/5xx of AVPlayer's error log are failed requests; other CoreMedia notes are not", () => {
    const notes = [-12318, -12889, -12971, -12645].map((code) => ({
      domain: 'CoreMediaErrorDomain',
      code,
      status: null,
      uri: null,
    }));
    for (const note of notes) expect(isFailedLoad(note)).toBe(false);
    // T2: a -12318 entry that does carry an HTTP status is a failure.
    expect(isFailedLoad({ domain: 'CoreMediaErrorDomain', code: -12318, status: 503 })).toBe(true);
    expect(isFailedLoad({ domain: 'CoreMediaErrorDomain', code: -12938, status: 404 })).toBe(true);
    expect(isFailedLoad({ domain: 'NSURLErrorDomain', code: -1005, status: null })).toBe(true);
    // Exo names no domain: every load error is a failed request.
    expect(isFailedLoad({ uri: 'http://server/x/0.m4s', status: null })).toBe(true);
  });

  it('T3 the stall probe: never while offline, never while a step runs, and once per stall again for the next stall', async () => {
    jest.useFakeTimers();
    const network = fakeNetwork();
    const c = await playing({ network }, subtitled, 30);
    network.set(false);
    harness.engine.emit({ type: 'buffering', buffering: true });
    await jest.advanceTimersByTimeAsync(3_000);
    expect(harness.server.sent('poll')).toHaveLength(0);
    network.set(true);
    harness.engine.emit({ type: 'buffering', buffering: false });
    await playOn(12);
    // Back online the player checks the playback once (revalidate); then a stall asks once more.
    const base = harness.server.sent('poll').length;
    harness.engine.emit({ type: 'buffering', buffering: true });
    await jest.advanceTimersByTimeAsync(3_000);
    expect(harness.server.sent('poll')).toHaveLength(base + 1);
    harness.engine.emit({ type: 'buffering', buffering: false });
    // A second stall later asks again (the "alive" answer is no longer fresh).
    await playOn(12);
    harness.engine.emit({ type: 'buffering', buffering: true });
    await jest.advanceTimersByTimeAsync(3_000);
    expect(harness.server.sent('poll')).toHaveLength(base + 2);
    harness.engine.emit({ type: 'buffering', buffering: false });
    await playOn(2);
    // A step already running (the server ended the playback; its quiet new start hangs): the stall asks nothing.
    harness.server.answer('progress', reply.ok({ playbackAlive: false }));
    harness.server.answer('start', reply.hang());
    await playOn(10);
    harness.engine.emit({ type: 'buffering', buffering: true });
    await jest.advanceTimersByTimeAsync(3_000);
    expect(harness.server.sent('poll')).toHaveLength(base + 2);
    await c.stop();
  });

  it('T4 stop() while offline ends the network re-read', async () => {
    jest.useFakeTimers();
    const network = Object.assign(fakeNetwork(), { refresh: jest.fn(async () => false) });
    const c = await playing({ network }, subtitled, 30);
    network.set(false);
    await jest.advanceTimersByTimeAsync(6_000);
    expect(network.refresh).toHaveBeenCalled();
    await c.stop();
    const reads = network.refresh.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(network.refresh.mock.calls.length).toBe(reads);
  });

  it('T5 an AVPlayer stall while the device is offline keeps the subtitles on (offline explains it)', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const network = fakeNetwork();
    const c = await playing({ network }, subtitled, 30);
    harness.engine.emit({ type: 'tracks', tracks: shown });
    await playOn(3);
    network.set(false);
    harness.engine.emit({ type: 'buffering', buffering: true });
    harness.engine.state('buffering');
    await jest.advanceTimersByTimeAsync(16_000);
    expect(harness.engine.commands).not.toContain('subtitle:null');
    os.restore();
    await c.stop();
  });

  it('T6 a reported issue never refines a network that answers with its own page (network_intercepted)', () => {
    const now = Date.now();
    const issue = stampIssues([], [{ kind: 'audioRendition', code: 'x', at: now }], now)[0]!;
    expect(
      deliveryFailure(
        { category: 'T1', code: 'network_intercepted' },
        { online: true, serverOkAt: now, brokeAt: now - 1, now, issue }
      ).code
    ).toBe('network_intercepted');
  });

  it('T7 issues of a playback that is no longer the playing one explain nothing', () => {
    const now = Date.now();
    const issues = stampIssues(
      [],
      [{ kind: 'audioRendition', renditionId: '1', code: 'x', at: now }],
      now
    );
    expect(issuesFor(issues, { current: false, audioRendition: '1', subtitleIndex: null })).toEqual(
      []
    );
    expect(
      issuesFor(issues, { current: true, audioRendition: '1', subtitleIndex: null })
    ).toHaveLength(1);
  });

  it('T9 the scripted engine, like EngineBase, never repeats a state', async () => {
    jest.useFakeTimers();
    const c = await playing({}, subtitled, 30);
    const seen: string[] = [];
    const off = harness.engine.subscribe((event) => {
      if (event.type === 'state') seen.push(event.state);
    });
    harness.engine.state('playing');
    harness.engine.state('playing');
    harness.engine.state('buffering');
    harness.engine.state('buffering');
    expect(seen).toEqual(['buffering']);
    off();
    await c.stop();
  });
});

describe('S6w: native follow-ups of the sixth review (R2, R10)', () => {
  const subtitled = {
    method: 'transcode',
    mediaInfo: {
      durationTicks: 180 * TICKS,
      audioTracks: [],
      subtitleTracks: [{ index: 4, language: 'en', deliveredAs: 'webvtt', selected: true }],
    },
  } as never;

  it('R2 two error-log entries back to back (video 404 without URI, then the subtitle playlist 404 with URI) both reach the engine, once each, in order', async () => {
    const expo = await expoPlaying();
    expo.player.logErrors(RECORDED.segment404, RECORDED.subtitlePlaylist404);
    expect(expo.events).toEqual([
      { type: 'loadRetry', status: 404, audio: false },
      { type: 'subtitleError', code: 'unknown_subtitle_stream' },
    ]);
    // A later notification of the same item reports only what is new.
    expo.player.logErrors(RECORDED.segment503);
    expect(expo.events.slice(2)).toEqual([{ type: 'loadRetry', status: 503, audio: false }]);
    expo.engine.release();
  });

  it('R2 the review order (subtitle playlist 404 with URI, then a URI-less 404) keeps the URI evidence: subtitles off with the notice, no new start', async () => {
    jest.useFakeTimers();
    const c = await playing({}, subtitled, 20);
    harness.engine.emit({
      type: 'tracks',
      tracks: { audio: [], subtitles: [{ id: 's0', label: 'en', language: 'en', selected: true }] },
    });
    const expo = await expoPlaying();
    expo.player.logErrors(RECORDED.subtitlePlaylist404, RECORDED.segment404);
    expo.replay();
    expo.engine.release();
    await settle();
    expect(c.notice).toMatchObject({ kind: 'subtitleFailed' });
    expect(starts()).toHaveLength(1);
    expect(harness.engine.load).toHaveBeenCalledTimes(1);
    await c.stop();
  });

  it('R10 behind the failure card the unloaded source reports no load error and no end (Android has no current-item check); the next load does', async () => {
    const expo = await expoPlaying();
    await expo.engine.shutdown?.();
    expo.events.length = 0;
    expo.player.loadError({ uri: 'http://server/media.m3u8', trackType: 'video', status: 404 });
    expo.player.toEnd();
    expect(expo.events).toEqual([]);
    expect(expo.engine.getSnapshot().state).not.toBe('ended');
    expo.engine.load({ uri: 'http://server/media.m3u8', kind: 'hls' });
    expo.events.length = 0;
    expo.player.loadError({ uri: 'http://server/media.m3u8', trackType: 'video', status: 404 });
    expo.player.toEnd();
    expect(expo.events.map((event) => event.type)).toEqual(['loadRetry', 'state', 'ended']);
    expo.engine.release();
  });
});

describe('S4q: the B15 contract and what a server issue may refine', () => {
  /** The three issues B15 reported live on 39310 (journal B15 Evidence), as the progress answer carries them. */
  const B15 = {
    deliveryIssues: [
      {
        kind: 'audioRendition',
        renditionId: '1',
        subtitleStreamIndex: null,
        code: 'rendition_split_failed',
        status: 500,
        at: '2026-10-06T15:40:01.123+00:00',
      },
      {
        kind: 'subtitleRendition',
        renditionId: null,
        subtitleStreamIndex: 3,
        code: 'unknown_subtitle_stream',
        status: 404,
        at: '2026-10-06T15:40:02Z',
      },
      {
        kind: 'segment',
        renditionId: null,
        subtitleStreamIndex: null,
        code: 'segment_unavailable',
        status: 503,
        at: '2026-10-06T15:40:03Z',
      },
    ],
  };

  it('R5 reads the B15 fields: renditionId for audio, subtitleStreamIndex for subtitles, the status', () => {
    expect(deliveryIssuesOf(B15)).toEqual([
      expect.objectContaining({ kind: 'audioRendition', renditionId: '1', status: 500 }),
      expect.objectContaining({ kind: 'subtitleRendition', subtitleStreamIndex: 3, status: 404 }),
      expect.objectContaining({ kind: 'segment', code: 'segment_unavailable', status: 503 }),
    ]);
    expect(deliveryIssuesOf({ deliveryIssues: null })).toEqual([]);
    // A kind B15 may send as null in its schema, or a subtitle issue without a numeric index: not an issue.
    const malformed = [
      { kind: null, code: 'x', status: 500, at: '2026-10-06T15:40:01Z' },
      {
        kind: 'subtitleRendition',
        subtitleStreamIndex: '3',
        code: 'x',
        status: 404,
        at: '2026-10-06T15:40:01Z',
      },
    ];
    expect(deliveryIssuesOf({ deliveryIssues: malformed })).toEqual([]);
  });

  it('R5 a subtitle issue concerns the shown subtitle by its stream index; another index leaves it alone', () => {
    const issues = stampIssues([], deliveryIssuesOf(B15), Date.now());
    const shown3 = issuesFor(issues, { current: true, audioRendition: '1', subtitleIndex: 3 });
    expect(shown3.map((issue) => issue.kind)).toEqual([
      'audioRendition',
      'subtitleRendition',
      'segment',
    ]);
    const shown4 = issuesFor(issues, { current: true, audioRendition: '2', subtitleIndex: 4 });
    expect(shown4.map((issue) => issue.kind)).toEqual(['segment']);
  });

  it('R4 an issue refines only the stall and delivery-break codes; any other code, now or future, stays itself', () => {
    const issue = recentIssue(
      stampIssues([], deliveryIssuesOf({ deliveryIssues: [B15.deliveryIssues[0]] }), Date.now()),
      Date.now()
    );
    const context = { online: true, serverOkAt: 0, brokeAt: Date.now(), now: Date.now(), issue };
    for (const code of [
      'playback_stalled',
      'seek_stalled',
      'segment_timeout',
      'segment_unavailable',
      'server_error',
      'delivery_interrupted',
      'stream_interrupted',
      'network_unreachable',
    ]) {
      const category = classify({ kind: 'api', code }).category;
      expect([code, deliveryFailure({ category, code }, context).code]).toEqual([
        code,
        'audio_rendition_failed',
      ]);
    }
    for (const failure of [
      { category: 'T6' as const, code: 'a_future_server_code' },
      { category: 'T5' as const, code: 'playback_slideshow' },
      { category: 'T6' as const, code: 'decoder_reclaimed' },
      { category: 'T6' as const, code: 'unexpected_format' },
      { category: 'T11' as const, code: 'player_load_failed' },
      { category: 'T1' as const, code: 'a_future_network_code' },
    ])
      expect(deliveryFailure(failure, context)).toEqual(failure);
  });

  it('R4 an unknown online T1 code is no delivery break either (only the break codes are)', () => {
    const now = Date.now();
    const context = { online: true, serverOkAt: now, brokeAt: now - 1_000, now, issue: null };
    expect(deliveryFailure({ category: 'T1', code: 'stream_interrupted' }, context).code).toBe(
      'delivery_interrupted'
    );
    expect(deliveryFailure({ category: 'T1', code: 'a_future_network_code' }, context).code).toBe(
      'a_future_network_code'
    );
  });
});

describe('S4r: the live audit S9c turn 1 timelines', () => {
  const twoAudio = {
    method: 'remux',
    mediaInfo: {
      durationTicks: 180 * TICKS,
      audioTracks: [
        { index: 1, language: 'de', selected: true, deliveredAs: 'original' },
        { index: 2, language: 'en', selected: false, deliveredAs: 'original' },
      ],
      subtitleTracks: [],
    },
  } as never;

  it('D36 Exo: the dead audio rendition answers 500: the audio path, never "the server had a problem"', () => {
    const reason = failureReason(
      {
        errorCodeName: 'ERROR_CODE_IO_BAD_HTTP_STATUS',
        message: 'Source error: InvalidResponseCodeException: Response code: 500',
        httpStatus: 500,
        uri: 'http://server/api/v1/transcode/tok/audio/1/12.m4s',
      },
      true,
      true
    );
    expect(classify({ kind: 'engine', engine: 'expo-video', reason, status: 500 })).toMatchObject({
      category: 'T7',
      code: 'audio_rendition_failed',
    });
    // A 404 there still means the playback is gone.
    const gone = failureReason(
      {
        message: 'Response code: 404',
        httpStatus: 404,
        uri: 'http://server/api/v1/transcode/tok/audio/1/12.m4s',
      },
      true,
      true
    );
    expect(
      classify({ kind: 'engine', engine: 'expo-video', reason: gone, status: 404 }).category
    ).toBe('T2');
  });

  it('D36 Exo ladder: "No sound" reload, the converted audio, another audio track, only then the card', async () => {
    jest.useFakeTimers();
    const c = await playing({}, twoAudio, 20);
    const dead = 'audioRendition:ERROR_CODE_IO_BAD_HTTP_STATUS: Response code: 500';
    harness.engine.fail(dead);
    await settle();
    expect(c.status.hint?.key).toBe('noAudio');
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    harness.engine.started();
    harness.server.answer(
      'switch',
      reply.ok(
        harness.server.playback({
          ...(twoAudio as object),
          playbackId: 'p1',
          revision: 1,
          audioFallback: true,
        } as never)
      )
    );
    harness.engine.fail(dead);
    await settle();
    expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ audioFallback: true });
    harness.engine.started();
    harness.engine.fail(dead);
    await settle();
    expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ audioStreamIndex: 2 });
    expect(c.notice).toMatchObject({ kind: 'otherAudioTrack', params: { language: 'en' } });
    for (const hint of [c.status.hint?.key]) expect(hint).not.toBe('serverError');
    expect(c.failure).toBeNull();
    await c.stop();
  });

  it('D36 iPhone: broken-off audio transfers (-1005), the reload shows no picture: the converted audio, never the card', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const avplayer = {
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
    const c = await playing({}, avplayer, 11);
    harness.engine.emit({ type: 'buffering', buffering: true });
    for (let second = 0; second < 16; second++) {
      if (second % 2 === 0) await fromAVPlayer(RECORDED.audioAbort);
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(c.status.hint).toMatchObject({ key: 'streamBreaks' });
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    // The reload stays black (AVPlayer waits for the sound): the start budget runs out.
    await jest.advanceTimersByTimeAsync(31_000);
    await settle();
    expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ audioFallback: true });
    expect(c.failure).toBeNull();
    os.restore();
    await c.stop();
  });

  it('D36 iPhone (S4v): the reload stays black while its sound requests break off again: the converted audio within ~15 s of the reload, a hint all the time', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const avplayer = {
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
    const c = await playing({}, avplayer, 20);
    harness.engine.emit({ type: 'buffering', buffering: true });
    let reloadAt = 0;
    let second = 0;
    for (; second < 40 && !harness.server.sent('switch').length; second++) {
      if (second % 2 === 0) await fromAVPlayer(RECORDED.audioAbort);
      await jest.advanceTimersByTimeAsync(1_000);
      if (!reloadAt && harness.engine.load.mock.calls.length === 2) reloadAt = second;
      if (reloadAt) expect(c.status.hint).not.toBeNull();
    }
    expect(reloadAt).toBeGreaterThan(0);
    // The old rule waited for the 30 s start budget on the black reload.
    expect(second - reloadAt).toBeLessThanOrEqual(15);
    expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ audioFallback: true });
    expect(c.failure).toBeNull();
    os.restore();
    await c.stop();
  });

  it('D19 iPhone: a video segment that never answers (timeouts, -1001) is no audio problem: no step A; a fresh start at once', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const avplayer = {
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
    // Assumed payload (S9c recorded the steps, not the raw entry): AVPlayer's own request timeout.
    const timeout = {
      domain: 'NSURLErrorDomain',
      code: -1001,
      comment: 'The request timed out.',
      status: null,
      uri: null,
    };
    const c = await playing({}, avplayer, 48);
    const stuck = async () => {
      harness.engine.emit({ type: 'buffering', buffering: true });
      for (let second = 0; second < 16; second++) {
        if (second % 2 === 0) await fromAVPlayer(timeout);
        await jest.advanceTimersByTimeAsync(1_000);
      }
    };
    await stuck();
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    harness.engine.started();
    await stuck();
    expect(harness.server.sent('switch').some((request) => request.body?.audioFallback)).toBe(
      false
    );
    expect(starts()).toHaveLength(2);
    expect(starts().at(-1)?.position).toBe(48);
    os.restore();
    await c.stop();
  });

  it('seg_corrupt iPhone: an end at 0:48, the reload stalls there: damaged data, another way to play with that reason; never a lower quality', async () => {
    jest.useFakeTimers();
    const remux = {
      method: 'remux',
      mediaInfo: {
        durationTicks: 180 * TICKS,
        audioTracks: [],
        subtitleTracks: [],
        video: { height: 1080 },
      },
    } as never;
    const c = await playing({}, remux, 40);
    harness.engine.time(48, 180);
    harness.engine.emit({ type: 'ended' });
    await settle();
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    expect(harness.engine.source?.startPosition).toBe(48);
    harness.engine.started(180);
    harness.engine.time(48, 180);
    harness.engine.emit({ type: 'buffering', buffering: true });
    await jest.advanceTimersByTimeAsync(16_000);
    await settle();
    const switches = harness.server.sent('switch');
    expect(
      switches.some((request) => (request.body?.preferences as { maxHeight?: number })?.maxHeight)
    ).toBe(false);
    expect(switches.at(-1)?.body).toMatchObject({ stepDown: true });
    expect(c.notice).toMatchObject({ kind: 'stepDown', params: { reason: 'media_damaged' } });
    await c.stop();
  });

  it('VLC: a direct play the server answers 404 ("unable to open the MRL") is the server losing it (T2), not a certificate or component', () => {
    // libVLC's standard input dialog (the S9c run showed the vlc_dialog hint; the native builder records the raw text).
    const dialog = `vlc_dialog error: Your input can't be opened VLC is unable to open the MRL 'https://dev.test:39300/api/v1/stream/tok'. Check the log for details.`;
    expect(classify({ kind: 'engine', engine: 'vlc', reason: dialog })).toMatchObject({
      category: 'T2',
    });
    // Control: a codec question stays "VLC cannot play this"; a plain EncounteredError stays vlc_error (D22).
    expect(
      classify({
        kind: 'engine',
        engine: 'vlc',
        reason: 'vlc_dialog error: Codec not supported VLC could not decode the format "dts "',
      }).code
    ).toBe('vlc_dialog');
    expect(
      classify({ kind: 'engine', engine: 'vlc', reason: "Your input can't be opened" }).code
    ).toBe('vlc_error');
  });
});
describe('S4x: a black reload is judged by its own sound only while the player can judge it (review 8 P2-3, P3-1, R11)', () => {
  const avplayer = {
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
  const hints: string[] = [];
  const watch = (c: {
    subscribe(listener: () => void): () => void;
    status: { hint: { key: string } | null };
  }) => {
    hints.length = 0;
    c.subscribe(() => {
      const key = c.status.hint?.key;
      if (key && hints.at(-1) !== key) hints.push(key);
    });
  };

  it('PROBE-8: the network drops during a black reload and AVPlayer\'s audio requests fail with it: "offline", then a normal reload — never "Converting the audio"', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const network = fakeNetwork();
    const c = await playing({ network }, avplayer, 20);
    watch(c);
    harness.engine.emit({
      type: 'error',
      reason: 'CoreMediaErrorDomain -16849 - HTTP 503',
      status: 503,
    });
    await jest.advanceTimersByTimeAsync(6_000);
    await settle();
    const loads = harness.engine.load.mock.calls.length;
    expect(loads).toBeGreaterThan(1);
    network.set(false);
    for (let second = 0; second < 12; second++) {
      await fromAVPlayer(RECORDED.audioAbort);
      await jest.advanceTimersByTimeAsync(1_000);
    }
    network.set(true);
    await jest.advanceTimersByTimeAsync(40_000);
    await settle();
    expect(hints).toContain('offline');
    expect(hints).not.toContain('convertingAudio');
    expect(JSON.stringify(harness.server.sent('switch'))).not.toContain('audioFallback');
    os.restore();
    await c.stop();
  });

  it('an outage right after the reload\'s own audio failures: the reload\'s clock starts over online, never "Converting the audio" for the outage', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const network = fakeNetwork();
    const c = await playing({ network }, avplayer, 20);
    watch(c);
    harness.engine.emit({
      type: 'error',
      reason: 'CoreMediaErrorDomain -16849 - HTTP 503',
      status: 503,
    });
    await jest.advanceTimersByTimeAsync(6_000);
    await settle();
    await fromAVPlayer(RECORDED.audioAbort);
    await jest.advanceTimersByTimeAsync(1_000);
    network.set(false);
    await jest.advanceTimersByTimeAsync(2_000);
    network.set(true);
    await jest.advanceTimersByTimeAsync(8_000);
    await settle();
    expect(hints).not.toContain('convertingAudio');
    expect(JSON.stringify(harness.server.sent('switch'))).not.toContain('audioFallback');
    os.restore();
    await c.stop();
  });

  it('PROBE-6: an audio sign of an earlier reload never judges the new start that followed it', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await playing({}, avplayer, 20);
    watch(c);
    harness.engine.emit({
      type: 'error',
      reason: 'CoreMediaErrorDomain -16849 - HTTP 503',
      status: 503,
    });
    await jest.advanceTimersByTimeAsync(6_000);
    await settle();
    await fromAVPlayer(RECORDED.audioAbort);
    // The reload fails another way: the server lost the playback, a new start.
    harness.engine.emit({
      type: 'error',
      reason: 'CoreMediaErrorDomain -12938 - HTTP 404',
      status: 404,
    });
    await settle();
    expect(starts().length).toBeGreaterThan(1);
    await jest.advanceTimersByTimeAsync(9_000);
    await settle();
    expect(hints).not.toContain('convertingAudio');
    expect(JSON.stringify(harness.server.sent('switch'))).not.toContain('audioFallback');
    os.restore();
    await c.stop();
  });

  it('R11: the audio sign that came before the reload does not judge it: no "Converting the audio" 10 s after a reload without new audio failures', async () => {
    jest.useFakeTimers();
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const c = await playing({}, avplayer, 20);
    watch(c);
    await fromAVPlayer(RECORDED.audioAbort);
    harness.engine.emit({
      type: 'error',
      reason: 'CoreMediaErrorDomain -16849 - HTTP 503',
      status: 503,
    });
    await jest.advanceTimersByTimeAsync(6_000);
    await settle();
    expect(harness.engine.load.mock.calls.length).toBeGreaterThan(1);
    await jest.advanceTimersByTimeAsync(14_000);
    await settle();
    expect(hints).not.toContain('convertingAudio');
    expect(JSON.stringify(harness.server.sent('switch'))).not.toContain('audioFallback');
    os.restore();
    await c.stop();
  });
});
