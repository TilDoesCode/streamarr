import { categoryOf } from '@/api/error-categories';
import { describeError } from '@/api/error-text';
import i18n from '@/i18n';
import { harness, newController, reply } from '@/../jest/player/harness';
import { row } from '@/../jest/player/matrix';
import {
  fakeNetwork,
  playFor,
  playing,
  playOn,
  settle,
  starts,
  TICKS,
} from '@/../jest/player/play';
import { ProgressQueue } from '@/player/progress-queue';
import { failureReason } from '@/screens/player/card-actions';

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

describe('matrix B — code review S1-S4 (S4b)', () => {
  const exo = (status: number) =>
    `Source error: InvalidResponseCodeException: Response code: ${status}`;

  row(
    'B25',
    'a new start refused once while the server warms up is retried as a new start, never a reload of the dead playback (review P6)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      const dead = harness.engine.source?.uri;
      harness.server.answer('start', reply.error(503, 'server_starting'));
      harness.engine.fail(exo(404));
      await settle();
      expect(starts()).toHaveLength(2);
      expect(c.status.hint).toMatchObject({ key: 'serverBusy' });
      await jest.advanceTimersByTimeAsync(5_000);
      expect(starts()).toHaveLength(3);
      expect(starts().at(-1)?.position).toBe(100);
      expect(harness.engine.sources.filter((source) => source.uri === dead)).toHaveLength(1);
      harness.engine.started();
      expect(c.phase).toBe('playing');
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );

  row(
    'B25',
    'after a new start the reports carry the new playbackId, starting with "start"; the old one is stopped (review M16)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      const old = c.playback!.playbackId;
      harness.engine.fail(exo(404));
      await settle();
      harness.engine.started();
      const fresh = c.playback!.playbackId;
      expect(fresh).not.toBe(old);
      const reports = harness.server.sent('progress').map((request) => request.body);
      expect(reports).toContainEqual(
        expect.objectContaining({ event: 'start', playbackId: fresh })
      );
      expect(harness.server.sent('stop').map((request) => request.playbackId)).toContain(old);
      await c.stop();
    }
  );

  row(
    'B25',
    'an incident and its budgets end after 2 minutes without failures (review M18)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      harness.engine.fail(exo(404));
      await settle();
      harness.engine.started();
      await playOn(130);
      harness.engine.fail(exo(404));
      await settle();
      harness.engine.started();
      expect(c.phase).toBe('playing');
      expect(starts()).toHaveLength(3);
      await playOn(30);
      harness.engine.fail(exo(404));
      await settle();
      // Within 2 minutes it is the same incident, and session loss gets one new start per incident.
      expect(c.phase).toBe('failed');
      expect(starts()).toHaveLength(3);
    }
  );

  row(
    'B25',
    'reports never go below the start position while a restarted source has not reached it (review M17)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 300);
      harness.engine.fail(exo(404));
      await settle();
      // The new source plays, but its clock still reads 0 before the start seek lands.
      harness.engine.emit({ type: 'firstFrame' });
      harness.engine.state('playing');
      harness.engine.time(0);
      await jest.advanceTimersByTimeAsync(10_000);
      const last = harness.server.sent('progress').at(-1)?.body;
      expect(Number(last?.positionTicks)).toBe(300 * TICKS);
      await c.stop();
    }
  );

  row(
    'B06',
    'no method of this version plays: the best other version starts at the same position (review 15)',
    async () => {
      jest.useFakeTimers();
      const server = harness.server;
      const c = await playing({}, { version: { releaseId: 'r1' } } as never, 120);
      server.answer(
        'versions',
        reply.ok({
          versions: [
            { releaseId: 'r1', rank: 1, predictedMethod: 'direct' },
            { releaseId: 'r3', rank: 3, predictedMethod: 'transcode' },
            { releaseId: 'r2', rank: 2, predictedMethod: 'unknown' },
            { releaseId: 'r4', rank: 2, predictedMethod: 'remux' },
          ],
        })
      );
      server.answer(
        'switch',
        reply.ok(
          server.playback({
            playbackId: c.playback!.playbackId!,
            state: 'failed',
            revision: 1,
            error: { code: 'no_more_methods' },
          } as never)
        )
      );
      server.answer('start', reply.ok(server.playback({ version: { releaseId: 'r4' } } as never)));
      harness.engine.fail('CoreMediaErrorDomain error -12927');
      await settle();
      harness.engine.fail('CoreMediaErrorDomain error -12927');
      await settle();
      expect(starts().at(-1)).toMatchObject({ releaseId: 'r4', position: 120 });
      expect(starts().at(-1)?.body).not.toHaveProperty('audioStreamIndex');
      expect(c.phase).toBe('playing');
      expect(c.notice?.kind).toBe('otherVersion');
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );

  row(
    'B06',
    'no other playable version: the card, and the empty search is not listed as tried',
    async () => {
      jest.useFakeTimers();
      const server = harness.server;
      const c = await playing({}, {}, 120);
      server.answer(
        'switch',
        reply.ok(
          server.playback({
            playbackId: c.playback!.playbackId!,
            state: 'failed',
            revision: 1,
            error: { code: 'no_more_methods' },
          } as never)
        )
      );
      harness.engine.fail('CoreMediaErrorDomain error -12927');
      await settle();
      harness.engine.fail('CoreMediaErrorDomain error -12927');
      await settle();
      expect(server.sent('versions')).toHaveLength(1);
      expect(c.failure?.code).toBe('no_more_methods');
      expect(c.failure?.tried?.map((attempt) => attempt.step)).toEqual(['R', 'S']);
    }
  );
});

describe('matrix B — playbackAlive from the progress answer (S4c, B13)', () => {
  const audioTracks = [
    { index: 1, language: 'en', deliveredAs: 'original', selected: true },
    { index: 2, language: 'de', deliveredAs: 'original', selected: false },
  ];
  const engineAudio = (selected: number) => ({
    audio: [
      { id: 'a0', label: 'en', language: 'en', selected: selected === 0 },
      { id: 'a1', label: 'de', language: 'de', selected: selected === 1 },
    ],
    subtitles: [],
  });

  row(
    'B25',
    'a heartbeat answered playbackAlive false: a silent new start at the position with the viewer audio; no hint, no notice',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        { mediaInfo: { durationTicks: 6e9, audioTracks, subtitleTracks: [] } } as never,
        100
      );
      harness.engine.emit({ type: 'tracks', tracks: engineAudio(0) });
      await c.selectAudio(audioTracks[1] as never);
      harness.engine.emit({ type: 'tracks', tracks: engineAudio(1) });
      harness.engine.time(120);
      const old = c.playback!.playbackId;
      harness.server.answer('progress', reply.ok({ playbackAlive: false }));
      await jest.advanceTimersByTimeAsync(10_000);
      expect(starts()).toHaveLength(2);
      expect(starts().at(-1)).toMatchObject({ position: 120, body: { audioStreamIndex: 2 } });
      expect(c.playback!.playbackId).not.toBe(old);
      expect(c.status).toEqual({ spinner: true, hint: null, actions: [] });
      harness.engine.started();
      expect(c.status.hint).toBeNull();
      expect(c.notice).toBeNull();
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );

  row(
    'B25',
    'playbackAlive true or null, or false for an older playback, changes nothing',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      harness.server.answer('progress', reply.ok({ playbackAlive: true }), reply.ok({}));
      await jest.advanceTimersByTimeAsync(20_000);
      expect(starts()).toHaveLength(1);
      const engine = harness.engine;
      c.progress.onAnswer?.({
        report: {
          event: 'progress',
          workId: 'w1',
          playbackId: 'p-old',
          positionTicks: 0,
          durationTicks: null,
        },
        playbackAlive: false,
      });
      await settle();
      expect(starts()).toHaveLength(1);
      expect(engine.load).toHaveBeenCalledTimes(1);
      await c.stop();
    }
  );

  row(
    'B25',
    'the silent restart that fails is no longer silent: the busy hint, then playback',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      harness.server.answer('progress', reply.ok({ playbackAlive: false }));
      harness.server.answer('start', reply.error(503, 'capacity_reached'));
      await jest.advanceTimersByTimeAsync(10_000);
      expect(c.status.hint).toMatchObject({ key: 'serverBusy' });
      await jest.advanceTimersByTimeAsync(5_000);
      expect(starts()).toHaveLength(3);
      harness.engine.started();
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );
});

describe('matrix B — code review S5 + S4b (S4d)', () => {
  const exo = (status: number) =>
    `Source error: InvalidResponseCodeException: Response code: ${status}`;
  const starting = (id = 'slow') =>
    reply.ok(
      harness.server.playback({ playbackId: id, state: 'starting', pollAfterMs: 1000 } as never)
    );

  row(
    'B25',
    'a new start that never gets ready ends on the card after a minute with its own code (review X2, K10, K36)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      harness.server.answer('start', starting(), starting(), starting());
      harness.server.answer('poll', ...Array.from({ length: 400 }, () => starting()));
      harness.engine.fail(exo(404));
      await settle();
      await jest.advanceTimersByTimeAsync(59_000);
      expect(c.phase).toBe('playing');
      expect(c.status.hint?.key).toBe('restarting');
      await jest.advanceTimersByTimeAsync(2_000);
      await settle();
      expect(c.phase).toBe('failed');
      expect(c.failure).toMatchObject({ code: 'step_timeout', category: 'T6' });
    }
  );

  row(
    'B25',
    'a new start whose server keeps reporting progress gets the time it needs (budget extended per state)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      const state = (s: string) =>
        reply.ok(
          harness.server.playback({ playbackId: 'p9', state: s, pollAfterMs: 1000 } as never)
        );
      const polls = [
        ...Array.from({ length: 50 }, () => state('resolving')),
        ...Array.from({ length: 50 }, () => state('repairing')),
        state('ready'),
      ];
      harness.server.answer('start', state('queued'));
      harness.server.answer('poll', ...polls);
      harness.engine.fail(exo(404));
      await settle();
      await jest.advanceTimersByTimeAsync(110_000);
      expect(c.failure).toBeNull();
      expect(harness.engine.source?.uri).toContain('p9');
      harness.engine.started();
      expect(c.phase).toBe('playing');
      await c.stop();
    }
  );

  row(
    'B06',
    'other version: one 503 on its start retries that version, never the stopped old playback (review B5)',
    async () => {
      jest.useFakeTimers();
      const server = harness.server;
      const c = await playing({}, { version: { releaseId: 'r1' } } as never, 0);
      const p1 = c.playback!.playbackId!;
      server.answer(
        'versions',
        reply.ok({ versions: [{ releaseId: 'r2', rank: 1, predictedMethod: 'direct' }] })
      );
      harness.engine.time(300, 600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      server.answer('start', reply.error(503, 'server_busy'));
      harness.engine.emit({ type: 'firstFrame' });
      harness.engine.emit({ type: 'ended' });
      await settle();
      await jest.advanceTimersByTimeAsync(6_000);
      await settle();
      expect(harness.engine.sources.map((source) => source.uri).at(-1)).not.toContain(`/${p1}`);
      expect(starts().map((start) => start.releaseId)).toEqual([undefined, 'r2', 'r2']);
      await c.stop();
    }
  );

  row('B06', 'while the other version starts the hint says so (review K35)', async () => {
    jest.useFakeTimers();
    const server = harness.server;
    const c = await playing({}, { version: { releaseId: 'r1' } } as never, 0);
    server.answer(
      'versions',
      reply.ok({ versions: [{ releaseId: 'r2', rank: 1, predictedMethod: 'direct' }] })
    );
    server.answer('start', starting('p2'));
    server.answer('poll', ...Array.from({ length: 20 }, () => starting('p2')));
    harness.engine.time(300, 600);
    harness.engine.emit({ type: 'ended' });
    await settle();
    harness.engine.emit({ type: 'firstFrame' });
    harness.engine.emit({ type: 'ended' });
    await settle();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(c.status.hint).toMatchObject({ key: 'switchingVersion' });
    await c.stop();
  });

  row(
    'B25',
    'the watchdog does not judge the old picture while a silent new start runs (review K31)',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing({}, {}, 0);
      await playFor(5, (second) => ({
        position: second,
        health: { framesPresented: second * 24, audioProgress: second * 1000 },
      }));
      harness.server.answer('start', starting('p2'));
      harness.server.answer('poll', ...Array.from({ length: 30 }, () => starting('p2')));
      harness.server.answer('progress', reply.ok({ playbackAlive: false }));
      await playFor(
        10,
        (second) => ({
          position: second,
          health: { framesPresented: 120, audioProgress: second * 1000 },
        }),
        5
      );
      expect(starts()).toHaveLength(2);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(c.failure).toBeNull();
      expect(c.status.hint).toBeNull();
      await c.stop();
    }
  );
});

describe('matrix B — step budget against a request that never answers (S4d)', () => {
  row(
    'B25',
    'a new start whose request never answers ends with step_timeout, not "aborted" (review D24)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      harness.server.answer('start', reply.hang(), reply.hang(), reply.hang());
      harness.engine.fail('Source error: InvalidResponseCodeException: Response code: 404');
      await settle();
      await jest.advanceTimersByTimeAsync(61_000);
      await settle();
      expect(c.failure).toMatchObject({ code: 'step_timeout' });
    }
  );
});

describe('matrix B — every conversion of this version fails (S9a B06)', () => {
  row(
    'B06',
    'transcode_failed on every new start: one more start, then another version at the position, never three starts and a card',
    async () => {
      jest.useFakeTimers();
      const server = harness.server;
      const c = await playing({}, { method: 'remux', version: { releaseId: 'r1' } } as never, 30);
      const failed = () =>
        reply.ok(
          server.playback({
            state: 'failed',
            version: { releaseId: 'r1' },
            error: { code: 'transcode_failed' },
          } as never)
        );
      server.answer('start', failed(), failed());
      server.answer(
        'versions',
        reply.ok({
          versions: [
            { releaseId: 'r1', rank: 1, predictedMethod: 'remux' },
            { releaseId: 'r4', rank: 2, predictedMethod: 'direct' },
          ],
        })
      );
      harness.engine.fail('Source error: InvalidResponseCodeException: Response code: 404');
      await settle();
      for (let second = 0; second < 30; second += 1) await jest.advanceTimersByTimeAsync(1_000);
      expect(starts().at(-1)).toMatchObject({ releaseId: 'r4', position: 30 });
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );
});

describe('matrix B — the server bounds a start or switch at 60 s: start_timeout (B13b)', () => {
  const timedOut = (id?: string) =>
    reply.ok(
      harness.server.playback({
        ...(id ? { playbackId: id } : null),
        state: 'failed',
        revision: 1,
        error: { code: 'start_timeout' },
        suggestedActions: ['retry', 'lowerQuality'],
      } as never)
    );

  row(
    'B19',
    'a viewer switch the server gave up on keeps the old source playing, with a notice why',
    async () => {
      jest.useFakeTimers();
      await i18n.changeLanguage('en');
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
        41
      );
      const before = c.playback;
      harness.server.answer('switch', timedOut(c.playback!.playbackId!));
      expect(await c.setQuality(720)).toBe(false);
      expect(c.phase).toBe('playing');
      expect(c.playback).toBe(before);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(starts()).toHaveLength(1);
      expect(c.notice).toMatchObject({ kind: 'switchFailed', params: { code: 'start_timeout' } });
      expect(describeError(i18n.t, { code: 'start_timeout' }).title).toBe(
        'The server took too long to start'
      );
      await c.stop();
    }
  );

  row(
    'B16',
    'a start the server gave up on: one fresh start, then another version, then the card with retry and lower quality',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('start', timedOut(), timedOut());
      const c = newController();
      await c.start();
      await settle();
      expect(starts()).toHaveLength(2);
      expect(harness.server.sent('versions')).toHaveLength(1);
      expect(c.phase).toBe('failed');
      expect(c.failure).toMatchObject({ code: 'start_timeout', category: 'T5' });
      expect(c.failure?.actions).toEqual(expect.arrayContaining(['retry', 'lowerQuality']));
    }
  );

  row(
    'B16',
    'a recovery switch the server gave up on: the next step is a fresh start at the position',
    async () => {
      jest.useFakeTimers();
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
        70
      );
      harness.server.answer('switch', timedOut(c.playback!.playbackId!));
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(16_000);
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(1);
      expect(starts()).toHaveLength(2);
      expect(starts().at(-1)?.position).toBe(70);
      await c.stop();
    }
  );
});

describe('matrix B — failed playbacks, stuck starts, switches, heartbeats (S4f)', () => {
  const tr = (key: string, options?: Record<string, unknown>) =>
    (i18n.t as unknown as (key: string, options?: Record<string, unknown>) => string)(key, options);
  const known = (reason: string) => i18n.exists(`errors.reasons.${reason}`);

  row(
    'B06',
    'a dead release: reload is pointless, another version is tried, else the card keeps "Other version" (the API has no suggestedReleaseId)',
    async () => {
      jest.useFakeTimers();
      harness.server.answer('start', failedWith('release_dead'));
      const c = newController();
      await c.start();
      await settle();
      expect(harness.server.sent('versions')).toHaveLength(1);
      expect(c.failure).toMatchObject({ code: 'release_dead', category: 'T8' });
      expect(c.failure?.actions).toContain('otherVersion');
    }
  );

  row(
    'B07',
    'transcoding_unavailable with params.reason: the card says why in words (ffmpeg not installed)',
    async () => {
      jest.useFakeTimers();
      await i18n.changeLanguage('en');
      harness.server.answer(
        'start',
        ...Array.from({ length: 5 }, () =>
          failedWith('transcoding_unavailable', { params: { reason: 'ffmpeg_unavailable' } })
        )
      );
      const c = newController();
      await c.start();
      await settle();
      await jest.advanceTimersByTimeAsync(60_000);
      // The server cannot convert at all: one more start, then a version that needs no conversion, then the card.
      expect(harness.server.sent('versions')).toHaveLength(1);
      expect(c.failure).toMatchObject({
        code: 'transcoding_unavailable',
        params: { reason: 'ffmpeg_unavailable' },
      });
      expect(failureReason(tr, c.failure!.params, known)).toBe(
        'ffmpeg is not installed on the server.'
      );
    }
  );

  row(
    'B10',
    'playback_failed with an unknown params.reason: the card shows the reason code',
    async () => {
      jest.useFakeTimers();
      await i18n.changeLanguage('en');
      harness.server.answer(
        'start',
        ...Array.from({ length: 5 }, () =>
          failedWith('playback_failed', { params: { reason: 'start_timeout' } })
        )
      );
      const c = newController();
      await c.start();
      await settle();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(c.failure).toMatchObject({
        code: 'playback_failed',
        category: 'T6',
        params: { reason: 'start_timeout' },
      });
      expect(failureReason(tr, c.failure!.params, known)).toBe('Reason: start_timeout');
      expect(failureReason(tr, undefined, known)).toBeNull();
    }
  );

  row(
    'B09',
    'transcode_failed at the start (reason init_unavailable): one more start, then another version, then the card',
    async () => {
      jest.useFakeTimers();
      const failed = () =>
        failedWith('transcode_failed', { params: { reason: 'init_unavailable' } });
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
    'B16',
    'a server stuck in one start state: the hint after the budget, the card with Retry and Other version after twice the budget; no late attach',
    async () => {
      jest.useFakeTimers();
      const server = harness.server;
      const stuck = server.playback({ state: 'planning', pollAfterMs: 1_000 } as never);
      server.answer('start', reply.ok(stuck));
      server.answer('poll', ...Array.from({ length: 200 }, () => reply.ok({ ...stuck })));
      const c = newController();
      void c.start();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(c.status.hint).toEqual({ key: 'startSlow', params: { cause: 'preparing' } });
      expect(c.phase).toBe('starting');
      await jest.advanceTimersByTimeAsync(31_000);
      expect(c.phase).toBe('failed');
      expect(c.failure).toMatchObject({ code: 'start_stuck', actions: ['retry', 'otherVersion'] });
      const polls = server.sent('poll').length;
      await jest.advanceTimersByTimeAsync(10_000);
      expect(server.sent('poll')).toHaveLength(polls);
      expect(harness.engines).toHaveLength(0);
    }
  );

  row(
    'B19',
    'a viewer switch that ends failed (transcode_capacity): the old source plays on, no new start, a notice',
    async () => {
      jest.useFakeTimers();
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
        41
      );
      const before = c.playback;
      harness.server.answer(
        'switch',
        reply.ok(
          harness.server.playback({
            playbackId: c.playback!.playbackId!,
            state: 'failed',
            revision: 1,
            error: { code: 'transcode_capacity' },
          } as never)
        )
      );
      expect(await c.setQuality(720)).toBe(false);
      expect(c.playback).toBe(before);
      expect(c.phase).toBe('playing');
      expect(starts()).toHaveLength(1);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(c.notice).toMatchObject({
        kind: 'switchFailed',
        params: { code: 'transcode_capacity' },
      });
      await c.stop();
    }
  );

  row(
    'B19',
    'a switch that failed while the old source no longer plays: a new start at the position (restore)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 41);
      harness.engine.state('error');
      harness.server.answer(
        'switch',
        reply.ok(
          harness.server.playback({
            playbackId: c.playback!.playbackId!,
            state: 'failed',
            revision: 1,
            error: { code: 'transcode_capacity' },
          } as never)
        )
      );
      await c.setQuality(720);
      await settle();
      expect(starts()).toHaveLength(2);
      expect(starts().at(-1)?.position).toBe(41);
      await c.stop();
    }
  );

  row(
    'B22',
    'a heartbeat that fails for a while is queued and sent later; the playback never notices',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 30);
      harness.server.answer(
        'progress',
        reply.error(503, 'server_error'),
        reply.error(503, 'server_error')
      );
      await playOn(12);
      expect(c.progress.pending).toBeGreaterThan(0);
      await playOn(30);
      expect(c.progress.pending).toBe(0);
      expect(c.status.hint).toBeNull();
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );

  row(
    'B26',
    'the server unreachable while the media is buffered: playback goes on, reports wait, nothing is restarted',
    async () => {
      jest.useFakeTimers();
      const network = fakeNetwork();
      const c = await playing({ network }, {}, 30);
      harness.server.answer('progress', ...Array.from({ length: 40 }, () => reply.offline()));
      harness.server.answer('poll', reply.offline());
      await playOn(40);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(starts()).toHaveLength(1);
      expect(c.status.hint).toBeNull();
      expect(c.progress.pending).toBeGreaterThan(0);
      await c.stop();
    }
  );
});
