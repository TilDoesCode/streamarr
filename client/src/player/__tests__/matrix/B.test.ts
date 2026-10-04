import { categoryOf } from '@/api/error-categories';
import { describeError } from '@/api/error-text';
import i18n from '@/i18n';
import { harness, newController, reply } from '@/../jest/player/harness';
import { pending, row } from '@/../jest/player/matrix';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());

const text = (key: string) => ({
  title: i18n.t(`errors.categories.${key}.title` as 'errors.categories.T1.title'),
  message: i18n.t(`errors.categories.${key}.message` as 'errors.categories.T1.message'),
});

beforeEach(() => harness.reset());

// State matrix layer B (docs/client/player/state-matrix.md § 1): one test per row id.

describe('matrix B — Playback API', () => {
  pending(
    'B01',
    'Start 400 invalid_device_profile / invalid_playback_request / invalid_work_id',
    'S4'
  );
  pending('B02', 'Start/switch 403 age_restricted', 'S4');
  pending(
    'B03',
    '404 title_not_found / season_not_found / episode_not_found (failed state, no actions)',
    'S4'
  );
  pending('B04', '409 too_many_streams (params.device, limit, releaseName)', 'S4');
  pending('B05', '429 too_many_playbacks (Retry-After)', 'S4');
  pending(
    'B06',
    'Failed release_dead, repair_failed, no_versions, release_not_found, no_playable_file, i…',
    'S4'
  );
  pending(
    'B07',
    'Failed transcoding_not_allowed, transcoding_unavailable (params.reason), no_playable_me…',
    'S4'
  );
  pending(
    'B08',
    'Failed capacity_reached, transcode_capacity, remux_capacity (params.reason too_many_ses…',
    'S4'
  );
  pending(
    'B09',
    'Failed transcode_failed, segment_timeout at start (params.reason init_unavailable/segme…',
    'regression test, S3+'
  );
  pending('B10', 'Failed playback_failed (params.reason)', 'S4');
  pending('B11', 'Failed no_more_methods after step-downs', 'S4');
  row('B12', 'an unknown code shows its category text by HTTP status, plus the code', async () => {
    await i18n.changeLanguage('en');
    harness.server.answer('start', reply.error(500, 'brand_new_code'));
    const controller = newController();
    await controller.start();
    expect(controller.phase).toBe('failed');
    expect(controller.failure).toMatchObject({ code: 'brand_new_code', status: 500 });
    const shown = describeError(i18n.t, controller.failure!);
    expect(shown).toEqual(text('T6'));
    expect(shown).not.toEqual(describeError(i18n.t, { code: 'unknown' }));
    expect(i18n.t('errors.codeLabel', { code: 'brand_new_code' })).toContain('brand_new_code');
    const cases: [number | undefined, string, string][] = [
      [0, 'brand_new_code', 'T1'],
      [401, 'brand_new_code', 'T3'],
      [403, 'brand_new_code', 'T9'],
      [404, 'brand_new_code', 'T2'],
      [410, 'brand_new_code', 'T2'],
      [422, 'brand_new_code', 'T8'],
      [429, 'brand_new_code', 'T4'],
      [503, 'brand_new_code', 'T4'],
      [504, 'brand_new_code', 'T5'],
      [400, 'brand_new_code', 'T11'],
      [undefined, 'stream_capacity_v2', 'T4'],
      [undefined, 'brand_new_code', 'T11'],
    ];
    for (const [status, code, category] of cases) {
      expect(categoryOf(code, status)).toBe(category);
      expect(describeError(i18n.t, { code, status })).toEqual(text(category));
    }
    await controller.stop();
  });
  pending('B13', 'Start returns 5xx without envelope / HTML', 'S4');
  pending('B14', 'Start POST times out (20 s)', 'S4');
  pending('B15', 'One poll GET …/playback/{id} fails (network/5xx) during start', 'S4');
  pending('B16', 'Playback hangs in one state (server stuck in starting/resolving)', 'S4');
  pending('B17', '404 playback_not_found while starting (server restarted)', 'S4');
  pending(
    'B18',
    '/switch 400 unknown_audio_stream / unknown_subtitle_stream (playback keeps its state)',
    'S4'
  );
  pending(
    'B19',
    '/switch → failed (user switch: quality/version/engine, e.g. transcode_capacity)',
    'S4'
  );
  pending('B20', '/switch network failure (user switch)', 'S4');
  pending('B21', '/switch with stepDown fails (network/5xx)', 'S4');
  pending('B22', 'Progress heartbeat fails transiently', 'regression test, S3+');
  pending('B23', 'Progress 401/403/404', 'S4');
  pending('B24', 'Heartbeat for a dead playbackId (idle-ended, server restarted)', 'S4');
  pending('B25', 'Server restart mid-play (or Dev World restart)', 'S4');
  pending('B26', 'Server unreachable for a while, media still buffered', 'regression test, S3+');
  row('B27', 'a failing stop call is swallowed', async () => {
    const server = harness.server;
    server.answer('start', reply.ok(server.playback({ resumePositionTicks: 120 * 10_000_000 })));
    const controller = newController({ startSeconds: undefined });
    const started = controller.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(controller.phase).toBe('resume');
    server.answer('stop', reply.offline());
    await expect(controller.stop()).resolves.toBeUndefined();
    await started;
    expect(server.sent('stop')).toHaveLength(1);
    expect(controller.phase).toBe('stopped');
  });
});
