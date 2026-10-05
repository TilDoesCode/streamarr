import { harness, reply } from '@/../jest/player/harness';
import { pending, row } from '@/../jest/player/matrix';
import { playFor, playing, settle, starts, TICKS } from '@/../jest/player/play';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());

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
  pending(
    'C03',
    'direct play on native engines: throughput probe (Exo bandwidthMeter, AVP access log)',
    'S6'
  );
  pending(
    'C04',
    'Direct play stalls on a Usenet hole (repair wait up to 90 s, RepairAwareStream.cs:67-12…',
    'S5'
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
      expect(c.status.spinner).toBe(false);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );
  pending(
    'C06',
    'Remux/transcode fails to start (TranscodeException at create)',
    'regression test, S3+'
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
    'a transcode slower than real time: "The server converts slower than playback", then lower quality',
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
      expect(c.status.hint?.key).toBe('serverSlow');
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
  pending(
    'C19',
    'Audio rendition 404 unknown_audio_rendition / 500 rendition_split_failed during an in-s…',
    'regression test, S3+'
  );
  row(
    'C20',
    'an audio rendition that dies mid-play: "No sound", reload (re-selects the rendition), then another way',
    async () => {
      const c = await probed(hls);
      await playFor(7, silentFrom);
      expect(c.status.hint?.key).toBe('noAudio');
      await playFor(4, silentFrom, 7);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started();
      await playFor(12, silentFrom, 0);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      await c.stop();
    }
  );
  pending(
    'C20',
    'AVPlayer has no audio counter (heuristic D21); /switch same audio when the server flag exists',
    'S6'
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
  pending('C22', 'Subtitle playlist or .vtt 404 (unknown_subtitle_stream) / 5xx', 'S8');
  pending('C23', 'Subtitle parse error (malformed WebVTT)', 'S8');
  pending(
    'C24',
    'Forced/selected subtitle not deliverable (subtitle_not_deliverable, deliveredAs: none)',
    'S8'
  );
  pending(
    'C25',
    'Wrong content type (playlist not application/vnd.apple.mpegurl, segment not video/mp4)',
    'S6'
  );
  pending('C26', 'HDR → SDR tag mismatch (AVPlayer -12927)', 'S6');
  row(
    'C27',
    'web: an audio codec the browser cannot decode (counter stands): "No sound", then another way to play',
    async () => {
      const c = await probed();
      await playFor(11, silentFrom);
      harness.engine.started();
      await playFor(12, silentFrom, 0);
      await settle();
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      await c.stop();
    }
  );
  pending(
    'C27',
    'native: Exo audio counters / AVP heuristic; server audio fallback flag (A)',
    'S6'
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
  pending('C28', 'native: Exo rendered-buffer counter, AVP isReadyForDisplay / video output', 'S6');
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
  pending('C30', 'Encrypted content without DRM', 'S8');
  pending('C31', 'Zero-length or very short file (< 1 segment, duration 0)', 'S8');
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
  pending('C33', 'Announced duration shorter than the media', 'regression test, S3+');
  pending(
    'C34',
    'Image subtitle needs burn-in / VLC (subtitle_burned_in, image_subtitle_vlc)',
    'regression test, S3+'
  );
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
