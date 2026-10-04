import { harness, newController, reply } from '@/../jest/player/harness';
import { pending, row } from '@/../jest/player/matrix';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());

beforeEach(() => harness.reset());

// State matrix layer D (docs/client/player/state-matrix.md § 1): one test per row id.

describe('matrix D — Engine and decoder', () => {
  pending(
    'D01',
    'hls.js fatal NETWORK_ERROR (manifestLoadError/TimeOut, levelLoadError, fragLoadError/Ti…',
    'S5'
  );
  pending(
    'D02',
    'hls.js fatal MEDIA_ERROR (bufferAppendError, fragParsingError, bufferStalledError fatal…',
    'S5'
  );
  pending('D03', 'hls.js fatal MUX_ERROR / OTHER_ERROR / KEY_SYSTEM_ERROR', 'S5');
  pending('D04', 'hls.js non-fatal bufferStalledError / bufferNudgeOnStall', 'S5');
  pending('D05', 'MSE QuotaExceededError (bufferFullError)', 'regression test, S3+');
  pending('D06', 'hls.js chunk fails to load (hlsjs:load, stale deploy, offline)', 'S5');
  pending('D07', 'Autoplay blocked (no user gesture)', 'S3');
  pending('D08', 'Muted autoplay also blocked (Safari Low Power, strict policies)', 'S3');
  pending(
    'D09',
    'Safari/<video> MediaError 1–4 (ABORTED, NETWORK, DECODE, SRC_NOT_SUPPORTED)',
    'S5'
  );
  pending('D10', 'Safari stalled/suspend/waiting', 'S5');
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
  pending(
    'D13',
    'Exo audio sink errors (AUDIO_TRACK_INIT_FAILED, AUDIO_TRACK_WRITE_FAILED, passthrough r…',
    'S6'
  );
  pending('D14', 'Exo BEHIND_LIVE_WINDOW', 'regression test, S3+');
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
  pending('D26', 'VLC end reached early (Stopped before the duration)', 'S4');
  pending('D27', 'VLC dialog request (onDialogDisplay: certificate, login, codec question)', 'S7');
  pending('D28', 'VLC stop hangs (ANR risk on release)', 'regression test, S3+');
  pending(
    'D29',
    'Seek into unbuffered media (any engine; transcode restarts ffmpeg at the target)',
    'S5'
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
  pending('D33', 'Black picture with running clock (generic, all engines)', 'S5');
  pending('D34', 'Frozen picture with running clock (generic)', 'S5');
  pending(
    'D35',
    'Running picture with frozen clock (time events stop; JS thread starved, Q1-25)',
    'S5'
  );
  pending('D36', 'No audio with running picture (generic)', 'S5');
  pending('D37', 'Audio/video drift', 'S5');
  pending('D38', 'Heavy frame drops (slideshow)', 'S5');
  pending(
    'D39',
    'Engine never reaches the first frame (load hangs: replaceAsync never settles, manifest…',
    'S5'
  );
  pending('D40', 'replaceAsync rejects', 'S6');
  row('D41', 'a second engine error while a step-down runs does not start another', async () => {
    const server = harness.server;
    const controller = newController();
    await controller.start();
    harness.engine.started();
    server.answer('switch', (request) =>
      reply.ok(server.playback({ playbackId: request.playbackId, method: 'remux', revision: 1 }))
    );
    harness.engine.fail('first');
    expect(controller.phase).toBe('switching');
    harness.engine.fail('again');
    await new Promise((resolve) => setImmediate(resolve));
    expect(server.sent('switch')).toHaveLength(1);
    expect(controller.phase).toBe('playing');
    expect(controller.notice?.kind).toBe('stepDown');
    await controller.stop();
  });
});
