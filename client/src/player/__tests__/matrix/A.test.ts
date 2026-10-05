import { AppState } from 'react-native';

import { categoryOf } from '@/api/error-categories';
import { describeError } from '@/api/error-text';
import i18n from '@/i18n';
import { harness, reply } from '@/../jest/player/harness';
import { pending, row } from '@/../jest/player/matrix';
import { fakeNetwork, playing, settle, starts } from '@/../jest/player/play';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());

beforeEach(() => harness.reset());
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const offline = 'Source error: ERROR_CODE_IO_NETWORK_CONNECTION_FAILED';

const generic = () => describeError(i18n.t, { code: 'unknown' });

// State matrix layer A (docs/client/player/state-matrix.md § 1): one test per row id.

describe('matrix A — App, auth, device and OS', () => {
  pending('A01', 'Access token expires mid-play', 'regression test, S3+');
  row(
    'A02',
    'failing heartbeats (refresh or network outage) never touch the running source',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(15);
      harness.server.answer('progress', ...Array.from({ length: 10 }, () => reply.offline()));
      await jest.advanceTimersByTimeAsync(60_000);
      expect(harness.server.sent('progress').length).toBeGreaterThan(1);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(c.phase).toBe('playing');
      expect(c.status.hint).toBeNull();
      await c.stop();
    }
  );
  pending('A03', 'Refresh refused: refresh_session_expired', 'S4');
  row('A04', 'refresh refused with revoked/unknown session codes is never the generic text', () => {
    for (const code of ['refresh_session_revoked', 'refresh_token_unknown']) {
      expect(categoryOf(code)).toBe('T3');
      const text = describeError(i18n.t, {
        code,
        params: { reason: 'session_limit' },
        status: 401,
      });
      expect(text.title).not.toBe(generic().title);
      expect(text.title).not.toMatch(/errors\./);
    }
  });
  pending(
    'A04',
    'player card H.signedOut names the reason; F8 adds the code texts',
    'S4 + F8 merge'
  );
  pending('A05', 'Refresh refused: refresh_token_reused', 'S4');
  row(
    'A06',
    'account disabled mid-play: the refused refresh reads as signed out, not generic',
    () => {
      const code = 'refresh_session_revoked';
      expect(categoryOf(code, 401)).toBe('T3');
      expect(describeError(i18n.t, { code, params: { reason: 'account_disabled' } })).toEqual(
        expect.objectContaining({ title: expect.not.stringMatching(generic().title) })
      );
      expect(describeError(i18n.t, { code: 'account_disabled' }).title).not.toBe(generic().title);
    }
  );
  pending('A06', 'player pauses, keeps the position, card H.signedOut "Account disabled"', 'S4');
  pending('A07', 'password_change_required (403) mid-play', 'S4');
  pending('A08', 'App backgrounded, no PiP (TV, web tab, VLC, paused)', 'regression test, S3+');
  row(
    'A09',
    'back in the foreground, a playback the server ended starts anew at the position',
    async () => {
      jest.useFakeTimers();
      const handlers: ((state: string) => void)[] = [];
      jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
        handlers.push(handler as (state: string) => void);
        return { remove: () => undefined };
      });
      const c = await playing({}, {}, 0);
      harness.engine.time(500);
      harness.server.answer('poll', reply.error(404, 'playback_not_found'));
      handlers.forEach((handler) => handler('active'));
      await settle();
      expect(harness.server.sent('poll')).toHaveLength(1);
      expect(starts().at(-1)?.position).toBe(500);
      await c.stop();
    }
  );
  pending('A10', 'Backgrounded with PiP (phones, expo-video)', 'regression test, S3+');
  pending('A11', 'OS kills the app (background or memory)', 'regression test, S3+');
  pending('A12', 'Device lock / sleep while playing (phone, no PiP)', 'S6');
  pending('A13', 'Audio focus lost (phone call, Siri, alarm, other app plays audio)', 'S6');
  pending('A14', 'Headphones / Bluetooth disconnected ("becoming noisy")', 'S6');
  pending('A15', 'PiP start / stop via button or leaving the app', 'regression test, S3+');
  pending('A16', 'PiP window closed by the viewer (✕)', 'S6');
  pending('A17', 'Failure while in PiP', 'S4');
  pending('A18', 'AirPlay start (iPhone/iPad)', 'S6');
  pending('A19', 'AirPlay receiver lost / turned off', 'S6');
  pending('A20', 'Chromecast / Remote Playback API', 'regression test, S3+');
  row(
    'A21',
    'a reclaimed decoder (low memory) retries the same source first, no step-down',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(33);
      harness.engine.fail('ERROR_CODE_DECODING_RESOURCES_RECLAIMED');
      await jest.advanceTimersByTimeAsync(5_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(33);
      expect(starts()).toHaveLength(1);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await c.stop();
    }
  );
  pending('A22', 'Rotation (phone)', 'regression test, S3+');
  row(
    'A23',
    'a network error mid-play reloads at the position with backoff and never steps down',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(100);
      for (const wait of [2, 4, 8, 16]) {
        harness.engine.fail(offline);
        expect(c.status.hint).toMatchObject({ key: 'reconnecting', params: { seconds: wait } });
        await jest.advanceTimersByTimeAsync(wait * 1000);
        expect(harness.engine.source?.startPosition).toBe(100);
      }
      harness.engine.fail(offline);
      await settle();
      expect(starts().at(-1)?.position).toBe(100);
      harness.engine.fail(offline);
      await settle();
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(c.failure).toMatchObject({
        code: 'network_unreachable',
        category: 'T1',
        actions: ['retry'],
      });
      await c.stop();
    }
  );
  row(
    'A24',
    'offline mid-play: banner at once, the engine stays, a failure waits for the network',
    async () => {
      jest.useFakeTimers();
      const network = fakeNetwork();
      const c = await playing({ network }, {}, 0);
      harness.engine.time(80);
      network.set(false);
      expect(c.status.hint).toEqual({ key: 'offline' });
      harness.engine.fail(offline);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(c.phase).toBe('playing');
      await jest.advanceTimersByTimeAsync(60_000);
      expect(c.failure).toMatchObject({ category: 'T1' });
      await c.stop();
    }
  );
  row(
    'A25',
    'back online: the waiting reload runs at once; a T1 card retries on its own',
    async () => {
      jest.useFakeTimers();
      const network = fakeNetwork();
      const c = await playing({ network }, {}, 0);
      harness.engine.time(80);
      network.set(false);
      harness.engine.fail(offline);
      await jest.advanceTimersByTimeAsync(10_000);
      network.set(true);
      await settle();
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(80);
      harness.engine.started();
      network.set(false);
      harness.engine.fail(offline);
      await jest.advanceTimersByTimeAsync(130_000);
      expect(c.phase).toBe('failed');
      network.set(true);
      await settle();
      expect(c.phase).toBe('playing');
      expect(starts().at(-1)?.position).toBe(80);
      await c.stop();
    }
  );
  pending('A26', 'Captive portal / proxy answers HTML', 'S4');
  pending('A27', 'Device clock skew', 'regression test, S3+');
  row('A28', 'a TLS failure mid-play is a card at once, no step-down', async () => {
    jest.useFakeTimers();
    const c = await playing({}, {}, 20);
    harness.engine.fail('javax.net.ssl.SSLHandshakeException: Handshake failed');
    await settle();
    expect(c.failure).toMatchObject({ code: 'tls_error', category: 'T1', actions: [] });
    expect(harness.server.sent('switch')).toHaveLength(0);
    await c.stop();
  });
});
