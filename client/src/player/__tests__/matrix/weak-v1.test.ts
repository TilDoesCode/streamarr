import { createApiClient } from '@/api/client';
import { describeError } from '@/api/error-text';
import i18n from '@/i18n';
import { harness, newController, reply } from '@/../jest/player/harness';
import { row } from '@/../jest/player/matrix';
import { playing, playOn, settle, starts, TICKS } from '@/../jest/player/play';
import { lostOnServer, serverLength, engineEnd } from '@/player/recovery/early-end';
import { audioEvidenceOf } from '@/player/recovery/lost-request';
import { hintText } from '@/player/recovery/hints';
import { stallFailure } from '@/player/recovery/stall';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());

// The WEAK rows of verify V1 (runs/driver/F10-verify1-V1.md): each test kills the mutant named in its title.

beforeEach(() => {
  harness.reset();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

const hls = {
  method: 'remux',
  mediaInfo: { durationTicks: 600 * TICKS, audioTracks: [], subtitleTracks: [] },
} as never;
const fail = (reason: string, status?: number) =>
  harness.engine.emit({ type: 'error', reason, ...(status === undefined ? null : { status }) });
const early = {
  position: 0,
  duration: 600,
  engineDuration: 600,
  loadPosition: 0,
  blank: false,
  pictured: true,
  startFloor: 0,
};
const pt = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key as never, { ...options, ns: 'player' } as never) as unknown as string;

describe('verify V1 WEAK rows — auth, network, Playback API', () => {
  row(
    'A01',
    'an access token that expires mid-play: the 401 heartbeat is refreshed and replayed (V01)',
    async () => {
      const playback = harness.server.playback();
      const json = (status: number, body?: unknown) =>
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      let valid = 'sva_1';
      const seen: { path: string; auth: string | null; status: number }[] = [];
      const fetch = jest.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        const auth = request.headers.get('Authorization');
        const answer =
          auth !== `Bearer ${valid}`
            ? json(401, { error: { code: 'unauthorized', message: 'expired' } })
            : path.endsWith('/watch/progress') || path.endsWith('/stop')
              ? json(204)
              : json(200, playback);
        seen.push({ path, auth, status: answer.status });
        return answer;
      });
      let token = 'sva_1';
      const session = {
        accessToken: async () => token,
        refreshAfter: jest.fn(async () => (token = 'sva_2')),
        passwordChangeRequired: jest.fn(),
      };
      const client = createApiClient({ baseUrl: 'http://server', session, fetch: fetch as never });
      const c = newController({ client });
      await c.start();
      harness.engine.started();
      harness.engine.time(30);
      // The server lets the access token expire while the video plays.
      valid = 'sva_2';
      await playOn(25);
      const heartbeats = seen.filter((request) => request.path.endsWith('/watch/progress'));
      expect(heartbeats[0]).toMatchObject({ auth: 'Bearer sva_1', status: 401 });
      expect(heartbeats[1]).toMatchObject({ auth: 'Bearer sva_2', status: 204 });
      expect(session.refreshAfter).toHaveBeenCalledWith('sva_1');
      expect(session.refreshAfter).toHaveBeenCalledTimes(1);
      expect(c.failure).toBeNull();
      expect(c.paused).toBe(false);
      expect(c.status.hint).toBeNull();
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      await c.stop();
    }
  );

  row(
    'A26',
    'a sign-in page instead of a playlist mid-play: the network card at once, no reload into the portal (V06)',
    async () => {
      await i18n.changeLanguage('en');
      const c = await playing({}, hls, 0);
      harness.engine.time(40);
      fail(
        'ERROR_CODE_PARSING_MANIFEST_MALFORMED: Source error: androidx.media3.common.ParserException: Input does not start with the #EXTM3U header.'
      );
      await settle();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(c.failure).toMatchObject({
        category: 'T1',
        code: 'network_intercepted',
        actions: ['retry'],
      });
      expect(describeError(i18n.t, c.failure!).title).toBe('The network intercepts the connection');
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(harness.server.sent('start')).toHaveLength(1);
      await c.stop();
    }
  );

  row(
    'B04',
    'too_many_streams polls every 10 s for two minutes, then the card (V09 together with the attempt cap R2)',
    async () => {
      const busy = () => reply.error(409, 'too_many_streams', { device: 'Living room TV' });
      harness.server.answer('start', ...Array.from({ length: 30 }, busy));
      const c = newController();
      await c.start();
      await jest.advanceTimersByTimeAsync(110_000);
      expect(harness.server.sent('start')).toHaveLength(12);
      expect(c.phase).not.toBe('failed');
      expect(c.status.hint?.key).toBe('waitingForStream');
      await jest.advanceTimersByTimeAsync(15_000);
      expect(harness.server.sent('start')).toHaveLength(13);
      expect(c.failure).toMatchObject({
        code: 'too_many_streams',
        params: { device: 'Living room TV' },
      });
      await jest.advanceTimersByTimeAsync(120_000);
      expect(harness.server.sent('start')).toHaveLength(13);
      await c.stop();
    }
  );

  it('B04 the wait names the release the other device plays (params.releaseName)', async () => {
    await i18n.changeLanguage('en');
    harness.server.answer(
      'start',
      reply.error(409, 'too_many_streams', {
        device: 'Living room TV',
        releaseName: 'Sintel 2160p',
      })
    );
    const c = newController();
    await c.start();
    const hint = c.status.hint!;
    await c.stop();
    expect(hintText(pt as never, hint.key, hint.params)).toContain('Sintel 2160p');
  });
});

describe('verify V1 WEAK rows — delivery', () => {
  row(
    'C16',
    'a parse error mid-play reloads the same source at the position, no other way to play (V10)',
    async () => {
      const c = await playing({}, hls, 0);
      const uri = harness.engine.source?.uri;
      harness.engine.time(50);
      fail('mediaError:fragParsingError');
      expect(c.status.hint).toMatchObject({ key: 'reloading' });
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source).toMatchObject({ uri, startPosition: 50 });
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );

  row(
    'C17',
    'a corrupt segment: the first media error is a reload, only the second steps down (V10)',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(80);
      fail('mediaError:bufferAppendError');
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(c.failure?.tried ?? []).toEqual([]);
      harness.engine.started();
      fail('mediaError:bufferAppendError');
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(1);
      expect(harness.server.sent('switch')[0]?.body).toMatchObject({ stepDown: true });
      await c.stop();
    }
  );

  row(
    'C20',
    'a long stall while hls.js retries the audio rendition is the audio, not the server (A2)',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(100);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(10_000);
      harness.engine.emit({ type: 'loadRetry', status: 503, audio: true });
      await jest.advanceTimersByTimeAsync(6_000);
      expect(c.status.hint?.key).toBe('noAudio');
      expect(harness.engine.source?.startPosition).toBe(100);
      await c.stop();
    }
  );

  row(
    'C20',
    'stallFailure: an audio retry inside the window is audio_rendition_failed (A2)',
    () => {
      const now = 1_000_000;
      expect(
        stallFailure({ status: 503, audio: true, at: now - 1_000 }, now, false, 'web')
      ).toEqual({
        category: 'T7',
        code: 'audio_rendition_failed',
      });
      expect(
        stallFailure({ status: 503, audio: false, at: now - 1_000 }, now, false, 'web').code
      ).not.toBe('audio_rendition_failed');
    }
  );

  row(
    'C25',
    'a stream format the device rejects (proxy): reload twice, then a new start, then another way (V11)',
    async () => {
      const format =
        'ERROR_CODE_PARSING_MANIFEST_MALFORMED: Source error: ParserException: unexpected tag';
      const c = await playing({}, hls, 0);
      harness.engine.time(30);
      fail(format);
      expect(c.status.hint?.key).toBe('serverError');
      await jest.advanceTimersByTimeAsync(5_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      harness.engine.started();
      fail(format);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(3);
      harness.engine.started();
      fail(format);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(starts()).toHaveLength(2);
      expect(starts()[1]?.position).toBe(30);
      harness.engine.started();
      fail(format);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({ stepDown: true });
      await c.stop();
    }
  );

  row(
    'C32',
    'an end 10 s before the duration is early: reload there (E1, 3 s tolerance)',
    async () => {
      const c = await playing({}, hls, 0);
      harness.engine.time(590, 600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.ended).toBe(false);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(590);
      await c.stop();
    }
  );

  row('C32', 'an end within 3 s of the duration is the end', async () => {
    const c = await playing({}, hls, 0);
    harness.engine.time(598, 600);
    harness.engine.emit({ type: 'ended' });
    await settle();
    expect(c.ended).toBe(true);
    expect(harness.engine.load).toHaveBeenCalledTimes(1);
    await c.stop();
  });

  row('C32', 'engineEnd: the tolerance is 3 s (E1)', () => {
    const at = (position: number) => engineEnd({ ...early, position });
    expect(at(597)).toEqual({ kind: 'end' });
    expect(at(596)).toEqual({ kind: 'early', endAt: 596 });
    expect(at(580)).toEqual({ kind: 'early', endAt: 580 });
  });
});

describe('verify V1 WEAK rows — engine', () => {
  row(
    'D29',
    'a seek that has not arrived after half a second shows the spinner (V12)',
    async () => {
      const c = await playing({}, {}, 30);
      c.seekTo(300);
      await jest.advanceTimersByTimeAsync(400);
      expect(c.status.spinner).toBe(false);
      await jest.advanceTimersByTimeAsync(300);
      expect(c.status).toMatchObject({ spinner: true, hint: null });
      await c.stop();
    }
  );

  row('D36', 'silence the watchdog measured is evidence for the sound (A1)', () => {
    const now = 1_000_000;
    expect(audioEvidenceOf(0, null, 'audio-silent', now)).toBe(true);
    expect(audioEvidenceOf(0, null, 'picture-black', now)).toBe(false);
    expect(audioEvidenceOf(0, null, undefined, now)).toBe(false);
    expect(audioEvidenceOf(now - 1_000, null, undefined, now)).toBe(true);
    expect(audioEvidenceOf(0, { kind: 'audioRendition' }, undefined, now)).toBe(true);
  });
});

describe('verify V1 notes — G4 a playback the server answers 410 for is gone', () => {
  const signal = () => new AbortController().signal;

  it('G4 lostOnServer: 410 playback_gone is a lost playback, like 404', async () => {
    harness.server.answer('poll', reply.error(410, 'playback_gone'), reply.error(404, 'not_found'));
    const gone = await lostOnServer(harness.server.client, 'p1', signal());
    expect(gone).toMatchObject({ extra: { status: 410 } });
    expect(gone?.failure.category).toBe('T2');
    expect(await lostOnServer(harness.server.client, 'p1', signal())).toMatchObject({
      extra: { status: 404 },
    });
  });

  it('G4 lostOnServer: a playback the server still has, or a busy server, is not lost', async () => {
    harness.server.answer(
      'poll',
      reply.ok(harness.server.playback()),
      reply.error(503, 'server_busy')
    );
    expect(await lostOnServer(harness.server.client, 'p1', signal())).toBeNull();
    expect(await lostOnServer(harness.server.client, 'p1', signal())).toBeNull();
  });

  it('G4 serverLength: a 410 on the early-end check is a lost playback', async () => {
    harness.server.answer('poll', reply.error(410, 'playback_gone'));
    const result = await serverLength(harness.server.client, harness.server.playback(), signal());
    expect(result).toHaveProperty('lost');
  });
});
