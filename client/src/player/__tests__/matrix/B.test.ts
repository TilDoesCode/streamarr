import { categoryOf } from '@/api/error-categories';
import { describeError } from '@/api/error-text';
import i18n from '@/i18n';
import { harness, newController, reply } from '@/../jest/player/harness';
import { pending, row } from '@/../jest/player/matrix';
import { fakeNetwork, playing, settle, starts, TICKS } from '@/../jest/player/play';
import { ProgressQueue } from '@/player/progress-queue';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());

const text = (key: string) => ({
  title: i18n.t(`errors.categories.${key}.title` as 'errors.categories.T1.title'),
  message: i18n.t(`errors.categories.${key}.message` as 'errors.categories.T1.message'),
});

beforeEach(() => harness.reset());
afterEach(() => jest.useRealTimers());

const failedWith = (code: string, extra: Record<string, unknown> = {}) =>
  reply.ok(harness.server.playback({ state: 'failed', error: { code, ...extra } } as never));

// State matrix layer B (docs/client/player/state-matrix.md § 1): one test per row id.

describe('matrix B — Playback API', () => {
  row(
    'B01',
    'an invalid start request is a client bug: no Retry, the code stays visible',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('start', reply.error(400, 'invalid_playback_request'));
      const c = newController();
      await c.start();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(harness.server.sent('start')).toHaveLength(1);
      expect(c.failure).toMatchObject({
        code: 'invalid_playback_request',
        category: 'T11',
        actions: [],
      });
    }
  );
  row('B02', 'age_restricted is policy: a card without Retry, no automatic retry', async () => {
    jest.useFakeTimers();
    harness.server.answer(
      'start',
      reply.error(403, 'age_restricted', { reason: 'above_age_limit' })
    );
    const c = newController();
    await c.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.server.sent('start')).toHaveLength(1);
    expect(c.failure).toMatchObject({ code: 'age_restricted', category: 'T9', actions: [] });
    expect(c.failure?.params).toEqual({ reason: 'above_age_limit' });
  });
  row('B03', "a missing title fails at once with the server's actions only", async () => {
    jest.useFakeTimers();
    harness.server.answer('start', failedWith('title_not_found'));
    const c = newController();
    await c.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.server.sent('start')).toHaveLength(1);
    expect(c.failure).toMatchObject({ code: 'title_not_found', category: 'T9', actions: [] });
  });
  row('B04', 'too_many_streams waits for the other device, polling every 10 s', async () => {
    jest.useFakeTimers();
    harness.server.answer(
      'start',
      reply.error(409, 'too_many_streams', { device: 'Living room TV' }),
      reply.error(409, 'too_many_streams', { device: 'Living room TV' })
    );
    const c = newController();
    await c.start();
    expect(c.status.hint).toEqual({
      key: 'waitingForStream',
      params: { device: 'Living room TV', seconds: 10, time: '0:00' },
    });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(harness.server.sent('start')).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(harness.server.sent('start')).toHaveLength(3);
    expect(c.phase).toBe('playing');
    await c.stop();
  });
  row('B05', 'too_many_playbacks retries after Retry-After with a countdown', async () => {
    jest.useFakeTimers();
    harness.server.answer('start', reply.error(429, 'too_many_playbacks', undefined, 3));
    const c = newController();
    await c.start();
    expect(c.status.hint).toMatchObject({ key: 'serverBusy', params: { seconds: 3 } });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(c.status.hint).toMatchObject({ key: 'serverBusy', params: { seconds: 2 } });
    await jest.advanceTimersByTimeAsync(2_000);
    expect(harness.server.sent('start')).toHaveLength(2);
    expect(c.phase).toBe('playing');
    await c.stop();
  });
  row('B06', 'stream_expired while starting is retried once automatically', async () => {
    jest.useFakeTimers();
    harness.server.answer('start', failedWith('stream_expired'));
    const c = newController();
    await c.start();
    await settle();
    expect(harness.server.sent('start')).toHaveLength(2);
    expect(c.phase).toBe('playing');
    await c.stop();
  });
  pending(
    'B06',
    'Other version preselects suggestedReleaseId; content failures keep their card',
    'S8'
  );
  pending(
    'B07',
    'Failed transcoding_not_allowed, transcoding_unavailable (params.reason), no_playable_me…',
    'S4'
  );
  row('B08', 'capacity failures retry 3× (5/10/20 s); a full disk does not', async () => {
    jest.useFakeTimers();
    harness.server.answer('start', ...[1, 2, 3, 4].map(() => failedWith('capacity_reached')));
    const c = newController();
    await c.start();
    await jest.advanceTimersByTimeAsync(4_999);
    expect(harness.server.sent('start')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1 + 10_000 + 20_000);
    expect(harness.server.sent('start')).toHaveLength(4);
    expect(c.failure).toMatchObject({
      code: 'capacity_reached',
      category: 'T4',
      actions: ['retry'],
    });
    harness.reset();
    harness.server.answer(
      'start',
      failedWith('transcode_capacity', { params: { reason: 'insufficient_disk' } })
    );
    const disk = newController();
    await disk.start();
    expect(disk.failure).toMatchObject({
      code: 'transcode_capacity',
      params: { reason: 'insufficient_disk' },
    });
  });
  pending(
    'B09',
    'Failed transcode_failed, segment_timeout at start (params.reason init_unavailable/segme…',
    'regression test, S3+'
  );
  pending('B10', 'Failed playback_failed (params.reason)', 'S4');
  row(
    'B11',
    "no_more_methods: the card keeps the server's actions and every step that was tried",
    async () => {
      jest.useFakeTimers();
      const server = harness.server;
      const c = await playing({}, {}, 90);
      server.answer(
        'switch',
        reply.ok(
          server.playback({
            playbackId: c.playback!.playbackId!,
            state: 'failed',
            revision: 1,
            error: { code: 'no_more_methods' },
            suggestedActions: ['otherVersion'],
          } as never)
        )
      );
      harness.engine.fail('CoreMediaErrorDomain error -12927');
      await settle();
      harness.engine.fail('CoreMediaErrorDomain error -12927');
      await settle();
      expect(c.failure).toMatchObject({
        code: 'no_more_methods',
        actions: ['otherVersion', 'useVlc'],
      });
      expect(c.failure?.tried).toEqual([
        expect.objectContaining({ step: 'R', code: 'decode_error', position: 90 }),
        expect.objectContaining({ step: 'S', code: 'decode_error', position: 90 }),
      ]);
    }
  );
  row('B12', 'an unknown code shows its category text by HTTP status, plus the code', async () => {
    await i18n.changeLanguage('en');
    jest.useFakeTimers();
    harness.server.answer('start', ...[1, 2, 3].map(() => reply.error(500, 'brand_new_code')));
    const controller = newController();
    await controller.start();
    expect(controller.phase).toBe('starting');
    await jest.advanceTimersByTimeAsync(20_000);
    expect(harness.server.sent('start')).toHaveLength(3);
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
  row(
    'B13',
    'a start answered by a proxy (5xx HTML) retries twice with backoff, then the card',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('start', reply.html(502), reply.html(502), reply.html(502));
      const c = newController();
      await c.start();
      expect(c.status.hint).toMatchObject({ key: 'serverError', params: { seconds: 5 } });
      await jest.advanceTimersByTimeAsync(5_000 + 15_000);
      expect(harness.server.sent('start')).toHaveLength(3);
      expect(c.failure).toMatchObject({
        code: 'server_error',
        category: 'T6',
        actions: ['retry', 'otherVersion'],
      });
    }
  );
  row('B14', 'a start that times out is sent again', async () => {
    jest.useFakeTimers();
    harness.server.answer('start', reply.offline('Network request timed out'));
    const c = newController();
    await c.start();
    expect(c.status.hint).toMatchObject({ key: 'reconnecting', params: { seconds: 2 } });
    await jest.advanceTimersByTimeAsync(2_000);
    expect(harness.server.sent('start')).toHaveLength(2);
    expect(c.phase).toBe('playing');
    await c.stop();
  });
  row('B15', 'one failed poll while starting is retried, not fatal', async () => {
    jest.useFakeTimers();
    const server = harness.server;
    const resolving = server.playback({ state: 'resolving', pollAfterMs: 500 } as never);
    server.answer('start', reply.ok(resolving));
    server.answer(
      'poll',
      reply.offline(),
      reply.error(503, 'server_busy'),
      reply.ok({ ...resolving, state: 'ready' })
    );
    const c = newController();
    const started = c.start();
    await jest.advanceTimersByTimeAsync(10_000);
    await started;
    expect(server.sent('poll')).toHaveLength(3);
    expect(c.phase).toBe('playing');
    await c.stop();
  });
  pending('B16', 'Playback hangs in one state (server stuck in starting/resolving)', 'S4');
  row('B17', 'playback_not_found while starting (server restarted) starts once more', async () => {
    jest.useFakeTimers();
    const server = harness.server;
    server.answer(
      'start',
      reply.ok(server.playback({ state: 'resolving', pollAfterMs: 500 } as never))
    );
    server.answer('poll', reply.error(404, 'playback_not_found'));
    const c = newController();
    const started = c.start();
    await jest.advanceTimersByTimeAsync(1_000);
    await started;
    expect(server.sent('start')).toHaveLength(2);
    expect(c.phase).toBe('playing');
    await c.stop();
  });
  row('B18', 'a refused switch (400) keeps the running source and says why', async () => {
    jest.useFakeTimers();
    const c = await playing({}, {}, 70);
    harness.server.answer('switch', reply.error(400, 'unknown_audio_stream'));
    expect(await c.setQuality(720)).toBe(false);
    expect(c.phase).toBe('playing');
    expect(c.notice).toMatchObject({
      kind: 'switchFailed',
      params: { code: 'unknown_audio_stream' },
    });
    expect(harness.server.sent('start')).toHaveLength(1);
    expect(harness.engine.load).toHaveBeenCalledTimes(1);
    expect(c.preferences.maxHeight).toBeUndefined();
    await c.stop();
  });
  pending(
    'B19',
    '/switch → failed (user switch: quality/version/engine, e.g. transcode_capacity)',
    'S4'
  );
  row('B20', 'a switch without network keeps the running source', async () => {
    jest.useFakeTimers();
    const c = await playing({}, {}, 70);
    harness.server.answer('switch', reply.offline());
    expect(await c.selectVersion('r2')).toBe(false);
    expect(c.phase).toBe('playing');
    expect(c.notice).toMatchObject({
      kind: 'switchFailed',
      params: { code: 'network_unreachable' },
    });
    expect(harness.server.sent('start')).toHaveLength(1);
    expect(harness.engine.load).toHaveBeenCalledTimes(1);
    await c.stop();
  });
  row(
    'B21',
    'a step-down switch without network goes to the transport ladder, not the card',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 70);
      harness.server.answer('switch', reply.offline());
      harness.engine.fail('decode failed');
      await settle();
      harness.engine.fail('decode failed');
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(1);
      expect(c.phase).toBe('playing');
      expect(c.status.hint).toMatchObject({ key: 'reconnecting', params: { seconds: 2 } });
      await jest.advanceTimersByTimeAsync(2_000);
      expect(harness.engine.source?.startPosition).toBe(70);
      await c.stop();
    }
  );
  pending('B22', 'Progress heartbeat fails transiently', 'regression test, S3+');
  row(
    'B23',
    'progress refused with 401/403 is kept per account until it signs in again (24 h cap)',
    async () => {
      jest.useFakeTimers();
      const account = `b23-${Date.now()}`;
      const report = {
        event: 'progress' as const,
        workId: 'w1',
        playbackId: 'p1',
        positionTicks: 90 * TICKS,
        durationTicks: null,
      };
      harness.server.answer('progress', reply.error(401, 'unauthorized'));
      const signedOut = new ProgressQueue(account, harness.server.client);
      await signedOut.report(report);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(harness.server.sent('progress')).toHaveLength(1);
      expect(signedOut.pending).toBe(1);
      const signedIn = new ProgressQueue(account, harness.server.client);
      await signedIn.flush();
      expect(harness.server.sent('progress').map((request) => request.body?.positionTicks)).toEqual(
        [90 * TICKS, 90 * TICKS]
      );
      expect(signedIn.pending).toBe(0);
      harness.server.answer('progress', reply.error(403, 'password_change_required'));
      await signedIn.report(report);
      expect(signedIn.pending).toBe(1);
      jest.setSystemTime(Date.now() + 25 * 3_600_000);
      expect(signedIn.pending).toBe(0);
    }
  );
  row(
    'B24',
    'back online, a playback the server ended meanwhile starts anew at the position',
    async () => {
      jest.useFakeTimers();
      const network = fakeNetwork();
      const c = await playing({ network }, {}, 0);
      harness.engine.time(420);
      network.set(false);
      harness.server.answer('poll', reply.error(404, 'playback_not_found'));
      network.set(true);
      await settle();
      expect(harness.server.sent('poll')).toHaveLength(1);
      expect(starts().at(-1)?.position).toBe(420);
      await c.stop();
    }
  );
  row(
    'B25',
    'server restart mid-play: a new start at the position with the same release and tracks',
    async () => {
      jest.useFakeTimers();
      const server = harness.server;
      const c = await playing(
        {},
        {
          method: 'remux',
          version: { releaseId: 'r1' },
          mediaInfo: {
            durationTicks: 600 * TICKS,
            audioTracks: [{ index: 2, selected: true }],
            subtitleTracks: [],
          },
        } as never,
        0
      );
      harness.engine.time(300);
      const oldId = c.playback!.playbackId;
      harness.engine.fail('Source error … Response code: 404');
      expect(c.status).toMatchObject({
        spinner: true,
        hint: { key: 'restarting', params: { time: '5:00' } },
      });
      await settle();
      expect(server.sent('stop').map((request) => request.playbackId)).toEqual([oldId]);
      expect(starts().at(-1)).toMatchObject({ releaseId: 'r1', position: 300 });
      expect(starts().at(-1)?.body).toMatchObject({ audioStreamIndex: 2, subtitleStreamIndex: -1 });
      expect(c.phase).toBe('playing');
      expect(c.playback!.playbackId).not.toBe(oldId);
      expect(harness.engine.source?.startPosition).toBe(300);
      harness.engine.started();
      expect(c.status.hint).toBeNull();
      await jest.advanceTimersByTimeAsync(10_000);
      const reports = server.sent('progress').map((request) => request.body);
      expect(reports.at(-1)).toMatchObject({ playbackId: c.playback!.playbackId });
      expect(reports.every((report) => Number(report?.positionTicks) >= 0)).toBe(true);
      expect(c.notice).toBeNull();
      await c.stop();
    }
  );
  row('B25', 'a late error of the replaced source while the restart runs is ignored', async () => {
    jest.useFakeTimers();
    const c = await playing({}, {}, 0);
    harness.engine.time(300);
    harness.engine.fail('Source error … Response code: 404');
    harness.engine.fail('Source error … Response code: 404');
    await settle();
    expect(c.failure).toBeNull();
    expect(c.phase).toBe('playing');
    expect(starts()).toHaveLength(2);
    expect(starts().at(-1)?.position).toBe(300);
    await c.stop();
  });
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
