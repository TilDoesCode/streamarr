import { harness } from '@/../jest/player/harness';
import { pending, row } from '@/../jest/player/matrix';
import { playing, settle, starts, TICKS } from '@/../jest/player/play';

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
  pending(
    'C03',
    'Direct play throughput below the bitrate (Usenet slow, 6 MiB/s pacing StreamarrOptions.…',
    'S5'
  );
  pending(
    'C04',
    'Direct play stalls on a Usenet hole (repair wait up to 90 s, RepairAwareStream.cs:67-12…',
    'S5'
  );
  pending('C05', 'Connection reset mid-transfer (progressive or segment)', 'S5');
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
  pending('C08', 'ffmpeg slower than real time (4K, weak server, software tone mapping)', 'S5');
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
  pending(
    'C10',
    'hls.js: status of a failed playlist request (today classified as transport)',
    'S5'
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
  pending('C12', 'Endless / stale playlist (no ENDLIST, no new segments)', 'S5');
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
  pending('C16', 'Segment truncated (connection closes early, wrong Content-Length)', 'S5');
  pending('C17', 'Corrupt segment (bad fMP4 box / bitstream)', 'S5');
  pending('C18', 'Timestamp discontinuity between ffmpeg runs', 'S5');
  pending(
    'C19',
    'Audio rendition 404 unknown_audio_rendition / 500 rendition_split_failed during an in-s…',
    'regression test, S3+'
  );
  pending(
    'C20',
    'Audio rendition fails during normal playback (split aborted after headers TranscodeStre…',
    'S5'
  );
  pending('C21', 'Video media playlist / init missing (500, 503 init_unavailable)', 'S5');
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
  pending(
    'C27',
    'Audio codec unsupported although declared (E-AC-3 on a browser, DTS passthrough with th…',
    'S5'
  );
  pending(
    'C28',
    'Video codec unsupported although declared (HEVC/AV1/DV profile without decoder)',
    'S5'
  );
  pending('C29', 'Resolution/level beyond the decoder (4K on a 1080p SoC, H.264 level 5.2)', 'S5');
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
