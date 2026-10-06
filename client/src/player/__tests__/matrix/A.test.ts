import { render } from '@testing-library/react-native';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppState } from 'react-native';

import { categoryOf } from '@/api/error-categories';
import { describeError } from '@/api/error-text';
import i18n from '@/i18n';
import { cardButtons } from '@/screens/player/card-actions';
import { harness, newController, reply } from '@/../jest/player/harness';
import { row } from '@/../jest/player/matrix';
import { expoVideoView } from '@/../jest/player/library-fakes';
import { expoPlaying } from '@/../jest/player/native';
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
import { lockPlayerLandscape } from '@/player/orientation';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());
jest.mock('expo-video', () =>
  jest.requireActual('@/../jest/player/library-fakes').expoVideoModule()
);

beforeEach(() => harness.reset());
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const offline = 'Source error: ERROR_CODE_IO_NETWORK_CONNECTION_FAILED';

const generic = () => describeError(i18n.t, { code: 'unknown' });

/** The real expo-video engine reports a native system pause; the controller adopts it with the cause (S6). */
async function systemPause(cause: string) {
  jest.useFakeTimers();
  const c = await playing({}, {}, 0);
  harness.engine.time(42);
  const expo = await expoPlaying();
  expo.player.system(true, cause);
  expect(expo.of('userPlayback')).toEqual([expect.objectContaining({ paused: true })]);
  expo.replay();
  await jest.advanceTimersByTimeAsync(3_000);
  return { c, expo };
}

// State matrix layer A (docs/client/player/state-matrix.md § 1): one test per row id.

describe('matrix A — App, auth, device and OS', () => {
  row(
    'A02',
    'failing heartbeats (refresh or network outage) never touch the running source',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(15);
      harness.server.answer('progress', ...Array.from({ length: 10 }, () => reply.offline()));
      await playOn(60);
      expect(harness.server.sent('progress').length).toBeGreaterThan(1);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(harness.server.sent('switch')).toHaveLength(0);
      expect(c.phase).toBe('playing');
      expect(c.status.hint).toBeNull();
      await c.stop();
    }
  );
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
  row(
    'A12',
    'a pause by the lock screen is adopted: "Paused: screen locked" + Resume',
    async () => {
      const { c, expo } = await systemPause('locked');
      expect(c.paused).toBe(true);
      expect(c.status.hint).toEqual({ key: 'pausedBySystem', params: { cause: 'locked' } });
      expect(c.status.actions).toEqual(['resume']);
      expect(harness.server.sent('progress').length).toBeGreaterThan(0);
      c.setPaused(false);
      expect(c.status.hint).toBeNull();
      expect(harness.engine.play).toHaveBeenCalled();
      expo.engine.release();
      await c.stop();
    }
  );
  row(
    'A13',
    'audio focus / interruption: the cause is named, the OS resume plays on, an app pause is not a system pause',
    async () => {
      const { c, expo } = await systemPause('call');
      expect(c.status.hint).toEqual({ key: 'pausedBySystem', params: { cause: 'call' } });
      // The OS ends the interruption with "should resume" (iOS): the engine plays and the controller follows.
      expo.player.system(false, 'resume');
      expect(expo.player.calls.at(-1)).toBe('play');
      expect(expo.of('userPlayback').at(-1)).toEqual({ type: 'userPlayback', paused: false });
      expo.replay();
      harness.engine.state('playing');
      expect(c.paused).toBe(false);
      expect(c.systemPaused).toBe(false);
      expect(c.status.hint).toBeNull();
      // Another app takes the audio focus (Android): named as such.
      expo.player.system(true, 'otherAudio');
      expect(expo.of('userPlayback').at(-1)).toMatchObject({ cause: 'otherAudio' });
      // The viewer paused in the app first: a later focus loss is no system pause.
      const own = await expoPlaying();
      own.engine.pause();
      own.player.system(true, 'otherAudio');
      expect(own.of('userPlayback')).toEqual([]);
      // Media keys / notification (Android `remote`): adopted as the viewer's pause, no system hint.
      const remote = await expoPlaying();
      remote.player.system(true, 'remote');
      expect(remote.of('userPlayback')).toEqual([{ type: 'userPlayback', paused: true }]);
      for (const engine of [expo.engine, own.engine, remote.engine]) engine.release();
      await c.stop();
    }
  );
  row(
    'A14',
    'headphones / Bluetooth gone ("becoming noisy"): "Paused: headphones disconnected"',
    async () => {
      const { c, expo } = await systemPause('headphones');
      expect(c.status.hint).toEqual({ key: 'pausedBySystem', params: { cause: 'headphones' } });
      expect(c.status.actions).toEqual(['resume']);
      expo.engine.release();
      await c.stop();
    }
  );
  row(
    'A16',
    'the PiP window closed with ✕ pauses: adopted as "Paused: picture-in-picture closed"',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(42);
      const expo = await expoPlaying();
      await render(createElement(expo.engine.Surface));
      const onPip = expoVideoView.props?.onPictureInPictureStop as () => void;
      onPip();
      expo.player.setPlaying(false);
      expect(expo.of('userPlayback')).toEqual([
        { type: 'userPlayback', paused: true, cause: 'pipClosed' },
      ]);
      expo.replay();
      expect(c.status.hint).toEqual({ key: 'pausedBySystem', params: { cause: 'pipClosed' } });
      // Long after the window closed, a pause is not blamed on it.
      await jest.advanceTimersByTimeAsync(5_000);
      const later = await expoPlaying();
      later.player.setPlaying(false);
      expect(later.of('userPlayback')).toEqual([]);
      expo.engine.release();
      later.engine.release();
      await c.stop();
    }
  );
  row('A18', 'AirPlay: "Playing on {device}", picture checks off while external', async () => {
    jest.useFakeTimers();
    const c = await playing({}, {}, 0);
    harness.engine.time(42);
    const expo = await expoPlaying();
    expo.player.health = { external: true, externalDevice: 'Wohnzimmer' };
    expo.player.setExternal(true);
    await settle();
    expect(expo.of('external').at(-1)).toEqual({
      type: 'external',
      active: true,
      device: 'Wohnzimmer',
    });
    await expect(expo.engine.readHealth()).resolves.toMatchObject({ external: true });
    expo.replay();
    expect(c.status.hint).toEqual({ key: 'airplay', params: { device: 'Wohnzimmer' } });
    expect(c.status.actions).toEqual([]);
    expo.player.setExternal(false);
    expo.replay();
    expect(c.status.hint).toBeNull();
    expo.engine.release();
    await c.stop();
  });
  row('A19', 'the AirPlay receiver goes away: "Paused: AirPlay disconnected"', async () => {
    const { c, expo } = await systemPause('airplayLost');
    expect(c.status.hint).toEqual({ key: 'pausedBySystem', params: { cause: 'airplayLost' } });
    expo.engine.release();
    await c.stop();
  });
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
      expect(c.phase).toBe('failed');
      // The network must stay back for 2 s before the card retries on its own (flapping Wi-Fi).
      await jest.advanceTimersByTimeAsync(2_000);
      expect(c.phase).toBe('playing');
      expect(starts().at(-1)?.position).toBe(80);
      await c.stop();
    }
  );
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

describe('matrix A — code review S1-S4 (S4b)', () => {
  const exo = (status: number) =>
    `Source error: InvalidResponseCodeException: Response code: ${status}`;

  row(
    'A24',
    'a stall across an offline period never steps down when the network returns (review P3)',
    async () => {
      jest.useFakeTimers();
      const network = fakeNetwork();
      const c = await playing({ network }, {}, 100);
      harness.engine.emit({ type: 'buffering', buffering: true });
      network.set(false);
      await jest.advanceTimersByTimeAsync(30_000);
      network.set(true);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(harness.server.sent('switch')).toHaveLength(0);
      // The stall budget starts over at the return: a real stall afterwards still gets its ladder, 15 s later.
      await jest.advanceTimersByTimeAsync(12_000);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(harness.server.sent('switch')).toHaveLength(1);
      await c.stop();
    }
  );

  row(
    'A24',
    'offline at the start: the offline hint, no card, and the start runs once the network is back (review P9)',
    async () => {
      jest.useFakeTimers();
      const network = fakeNetwork();
      harness.server.answer('start', reply.offline());
      const c = newController({ network });
      network.set(false);
      await c.start();
      expect(c.status.hint?.key).toBe('offline');
      await jest.advanceTimersByTimeAsync(60_000);
      expect(harness.server.sent('start')).toHaveLength(1);
      expect(c.phase).toBe('starting');
      network.set(true);
      await settle();
      expect(harness.server.sent('start')).toHaveLength(2);
      expect(c.phase).toBe('playing');
      await c.stop();
    }
  );

  row(
    'A25',
    'a flapping network: a card retries only after 2 s of stable network, at most 3 times in 10 minutes (review 14)',
    async () => {
      jest.useFakeTimers();
      const network = fakeNetwork();
      const c = await playing({ network }, {}, 50);
      const toCard = async () => {
        network.set(false);
        harness.engine.fail(offline);
        await jest.advanceTimersByTimeAsync(130_000);
        expect(c.phase).toBe('failed');
      };
      await toCard();
      network.set(true);
      await jest.advanceTimersByTimeAsync(1_000);
      network.set(false);
      network.set(true);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.phase).toBe('failed');
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.phase).toBe('playing');
      harness.engine.started();
      for (let round = 2; round <= 4; round += 1) {
        await toCard();
        network.set(true);
        await jest.advanceTimersByTimeAsync(3_000);
        expect(c.phase).toBe(round <= 3 ? 'playing' : 'failed');
        harness.engine.started();
      }
      await c.stop();
    }
  );

  row(
    'A23',
    'while a step runs the hint says what it does, never "Retrying in 0 s" (review P14)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      harness.engine.fail(offline);
      expect(c.status.hint).toMatchObject({ key: 'reconnecting', params: { seconds: 2 } });
      await jest.advanceTimersByTimeAsync(1_500);
      expect(c.status.hint).toMatchObject({ key: 'reconnecting', params: { seconds: 1 } });
      expect(c.status.actions).toEqual(['tryNow', 'back']);
      await jest.advanceTimersByTimeAsync(500);
      expect(c.status).toEqual({
        spinner: true,
        hint: { key: 'reloading', params: { time: '1:40' } },
        actions: [],
      });
      harness.engine.started();
      const starting = harness.server.playback({ state: 'starting', pollAfterMs: 1_000 } as never);
      harness.server.answer('start', reply.ok(starting));
      harness.server.answer('poll', ...Array.from({ length: 5 }, () => reply.ok(starting)));
      harness.engine.fail(exo(404));
      await jest.advanceTimersByTimeAsync(3_000);
      expect(c.status).toEqual({
        spinner: true,
        hint: { key: 'restarting', params: { time: '1:40' } },
        actions: [],
      });
      await c.stop();
    }
  );

  row(
    'A03',
    'signed out mid-play (refused while restarting): the card offers Sign in (review 16)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      harness.server.answer(
        'start',
        reply.error(401, 'refresh_session_revoked', { reason: 'admin' })
      );
      harness.engine.fail(exo(404));
      await settle();
      expect(c.failure).toMatchObject({
        code: 'refresh_session_revoked',
        category: 'T3',
        actions: ['signIn'],
      });
      expect(cardButtons(c.failure!.actions)).toEqual(['signIn', 'back']);
      await c.stop();
    }
  );

  row(
    'A03',
    'signed out while backgrounded: the foreground check ends on the Sign in card',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      harness.server.answer('poll', reply.error(401, 'refresh_session_expired'));
      await c.revalidate();
      expect(c.failure).toMatchObject({ code: 'refresh_session_expired', actions: ['signIn'] });
      await c.stop();
    }
  );
});

describe('matrix A — idle expiry seen in the progress answer (S4c, B13)', () => {
  row(
    'A09',
    'the server ended an idle playback: the next heartbeat restarts it silently at the position',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 600);
      c.setPaused(true);
      harness.server.answer('progress', reply.ok({ playbackAlive: false }));
      c.setPaused(false);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(starts().at(-1)?.position).toBe(600);
      expect(c.notice).toBeNull();
      await c.stop();
    }
  );
});

describe('matrix A — code review S5 + S4b (S4d)', () => {
  row(
    'A20',
    'casting (Remote Playback / AirPlay): the local engine is not judged for sound or picture, no reload (review B2)',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing({}, {}, 0);
      await playFor(5, (second) => ({
        position: second,
        health: { framesPresented: second * 24, audioProgress: second * 1000 },
      }));
      await playFor(
        15,
        (second) => ({
          position: second,
          health: { external: true, framesPresented: 120, audioProgress: 5000 },
        }),
        5
      );
      // The picture plays elsewhere: said so, never judged as missing (S4j: the probe's external is read).
      expect(c.status.hint).toEqual({ key: 'airplay', params: { device: 'AirPlay' } });
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      await c.stop();
    }
  );

  row(
    'A24',
    'an outage while the picture loads does not count against the start budget (review K28)',
    async () => {
      jest.useFakeTimers();
      const network = fakeNetwork();
      const c = newController({ network });
      await c.start();
      await jest.advanceTimersByTimeAsync(10_000);
      network.set(false);
      await jest.advanceTimersByTimeAsync(30_000);
      network.set(true);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(6_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      await c.stop();
    }
  );
});

describe('matrix A — signed out, background, PiP, OS, network (S4f)', () => {
  const background = () => {
    const handlers: ((state: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      handlers.push(handler as (state: string) => void);
      return { remove: () => undefined };
    });
    return (state: string) => handlers.forEach((handler) => handler(state));
  };

  row(
    'A01',
    'an access token that expires mid-play is refreshed by the client: the heartbeat goes through, the playback never notices',
    async () => {
      jest.useFakeTimers();
      // The auth middleware refreshes and replays the request: the player sees one ordinary answer.
      const c = await playing({}, {}, 30);
      await playOn(25);
      expect(harness.server.sent('progress').length).toBeGreaterThan(1);
      expect(c.failure).toBeNull();
      expect(c.paused).toBe(false);
      expect(c.status.hint).toBeNull();
      await c.stop();
    }
  );

  /** A heartbeat refused for good: pause where it is, the Sign in card names it, the position waits in the queue. */
  async function refusedHeartbeat(code: string, status: number, params?: Record<string, string>) {
    jest.useFakeTimers();
    await i18n.changeLanguage('en');
    const c = await playing({}, {}, 0);
    harness.engine.time(420);
    harness.server.answer('progress', reply.error(status, code, params));
    await playOn(10);
    expect(c.phase).toBe('failed');
    expect(c.paused).toBe(true);
    expect(harness.engine.pause).toHaveBeenCalled();
    expect(c.failure).toMatchObject({ code, category: 'T3' });
    expect(cardButtons(c.failure!.actions)).toEqual(['signIn', 'back']);
    const text = describeError(i18n.t, c.failure!);
    expect(text).not.toEqual(generic());
    expect(text.title).not.toMatch(/errors\./);
    // The refused report is kept for this account and goes out after the next sign-in.
    expect(c.progress.pending).toBeGreaterThan(0);
    const signedIn = new ProgressQueue(c.options.accountId, harness.server.client);
    await signedIn.flush();
    const last = harness.server.sent('progress').at(-1)?.body;
    expect(Number(last?.positionTicks)).toBeGreaterThanOrEqual(420 * TICKS);
    expect(signedIn.pending).toBe(0);
    return text;
  }

  row(
    'A03',
    'refresh refused (refresh_session_expired) mid-play: paused, Sign in card, position kept',
    async () => {
      await refusedHeartbeat('refresh_session_expired', 401);
    }
  );
  row(
    'A05',
    'refresh refused (refresh_token_reused) mid-play: paused, Sign in card, position kept',
    async () => {
      await refusedHeartbeat('refresh_token_reused', 401);
    }
  );
  row(
    'A07',
    'password_change_required (403) mid-play: paused, the card says to change the password, position kept',
    async () => {
      const text = await refusedHeartbeat('password_change_required', 403);
      expect(text.message).toMatch(/password/i);
    }
  );
  row(
    'A04',
    'refresh_session_revoked (signed_out) mid-play: the card names the reason',
    async () => {
      await refusedHeartbeat('refresh_session_revoked', 401, { reason: 'signed_out' });
    }
  );
  row('A06', 'account disabled mid-play: the card says so, position kept', async () => {
    const text = await refusedHeartbeat('refresh_session_revoked', 401, {
      reason: 'account_disabled',
    });
    expect(text.message).toMatch(/disabled/i);
  });

  row('A04', 'each revoke reason has its own words on the card (F8 wording)', async () => {
    await i18n.changeLanguage('en');
    const reasons = [
      'signed_out',
      'revoked_by_viewer',
      'session_limit',
      'admin',
      'password_changed',
      'account_disabled',
    ];
    const texts = reasons.map(
      (reason) =>
        describeError(i18n.t, { code: 'refresh_session_revoked', params: { reason } }).message
    );
    expect(new Set(texts).size).toBeGreaterThanOrEqual(5);
  });

  row(
    'A08',
    'backgrounded without picture-in-picture: paused and the position reported; back, it stays paused',
    async () => {
      jest.useFakeTimers();
      const change = background();
      const c = await playing({}, {}, 0);
      harness.engine.time(77);
      const reports = harness.server.sent('progress').length;
      change('background');
      await settle();
      expect(c.paused).toBe(true);
      expect(harness.engine.pause).toHaveBeenCalled();
      expect(harness.server.sent('progress').length).toBeGreaterThan(reports);
      change('active');
      await settle();
      expect(c.paused).toBe(true);
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );

  row(
    'A10',
    'backgrounded while playing on an engine with picture-in-picture: it keeps playing',
    async () => {
      jest.useFakeTimers();
      const change = background();
      harness.features.supportsPictureInPicture = true;
      const c = await playing({}, {}, 0);
      harness.engine.time(30);
      change('background');
      await settle();
      expect(c.paused).toBe(false);
      expect(harness.engine.pause).not.toHaveBeenCalled();
      await c.stop();
    }
  );

  row(
    'A15',
    'picture-in-picture on and off follows the engine; the status layer and notices stay out of it',
    async () => {
      jest.useFakeTimers();
      harness.features.supportsPictureInPicture = true;
      const c = await playing({}, {}, 0);
      harness.engine.emit({ type: 'pip', active: true });
      expect(c.pictureInPicture).toBe(true);
      harness.engine.emit({ type: 'pip', active: false });
      expect(c.pictureInPicture).toBe(false);
      await c.stop();
    }
  );

  row(
    'A17',
    'a terminal failure while in picture-in-picture leaves it, so the card waits in the app window',
    async () => {
      jest.useFakeTimers();
      harness.features.supportsPictureInPicture = true;
      const c = await playing({}, {}, 0);
      harness.engine.emit({ type: 'pip', active: true });
      harness.engine.fail('javax.net.ssl.SSLHandshakeException: Handshake failed');
      await settle();
      expect(c.phase).toBe('failed');
      expect(harness.engine.stopPictureInPicture).toHaveBeenCalled();
      await c.stop();
    }
  );
  row('A17', 'expo-video leaves picture-in-picture through its native view', async () => {
    const expo = await expoPlaying();
    await render(createElement(expo.engine.Surface));
    expoVideoView.ref.stopPictureInPicture.mockClear();
    expo.engine.stopPictureInPicture();
    expect(expoVideoView.ref.stopPictureInPicture).toHaveBeenCalledTimes(1);
    expo.engine.release();
  });

  row(
    'A11',
    'the OS kills the app: the last report survives in the queue and the next start offers to resume there',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(234);
      harness.server.answer('progress', reply.offline(), reply.offline(), reply.offline());
      await jest.advanceTimersByTimeAsync(10_000);
      expect(c.progress.pending).toBeGreaterThan(0);
      // No stop: the process is gone. A new process creates a new queue and a new controller.
      const revived = new ProgressQueue(c.options.accountId, harness.server.client);
      await revived.flush();
      expect(Number(harness.server.sent('progress').at(-1)?.body?.positionTicks)).toBe(234 * TICKS);
      harness.server.answer(
        'start',
        reply.ok(harness.server.playback({ resumePositionTicks: 234 * TICKS } as never))
      );
      const next = newController({ startSeconds: undefined, accountId: c.options.accountId });
      const started = next.start();
      await settle();
      expect(next.phase).toBe('resume');
      expect(next.resumeSeconds).toBe(234);
      await next.stop();
      await started;
    }
  );

  row('A20', 'casting is not offered: the web video carries disableRemotePlayback', async () => {
    const source = readFileSync(join(__dirname, '../../engines/web-engine.web.tsx'), 'utf8');
    expect(source).toMatch(/disableRemotePlayback: true/);
  });

  row(
    'A22',
    'rotation: the phone player locks landscape and gives a portrait app its portrait back; the playback is untouched',
    async () => {
      jest.useFakeTimers();
      const calls: string[] = [];
      const orientation = Promise.resolve({
        OrientationLock: { LANDSCAPE: 'landscape', PORTRAIT_UP: 'portrait-up' },
        lockAsync: async (lock: string) => void calls.push(`lock ${lock}`),
        unlockAsync: async () => void calls.push('unlock'),
      } as never);
      const c = await playing({}, {}, 50);
      const release = lockPlayerLandscape(orientation, true, () => true);
      await settle();
      expect(calls).toEqual(['lock landscape']);
      release();
      await settle();
      expect(calls).toEqual(['lock landscape', 'lock portrait-up', 'unlock']);
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(c.failure).toBeNull();
      await c.stop();
    }
  );

  row(
    'A26',
    'a sign-in page answers instead of the server: the card says the network intercepts, no retries into the portal',
    async () => {
      jest.useFakeTimers();
      await i18n.changeLanguage('en');
      harness.server.answer('start', reply.html(200), reply.html(200));
      const c = newController();
      await c.start();
      await settle();
      expect(harness.server.sent('start')).toHaveLength(1);
      expect(c.failure).toMatchObject({
        code: 'network_intercepted',
        category: 'T1',
        actions: ['retry'],
      });
      expect(describeError(i18n.t, c.failure!).title).toBe('The network intercepts the connection');
    }
  );

  row(
    'A27',
    'the device clock jumps an hour: no stall, reload or card; positions come from the media clock',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      jest.setSystemTime(Date.now() + 3_600_000);
      await playOn(12);
      expect(c.status.hint).toBeNull();
      expect(harness.engine.load).toHaveBeenCalledTimes(1);
      expect(c.failure).toBeNull();
      expect(
        Number(harness.server.sent('progress').at(-1)?.body?.positionTicks)
      ).toBeGreaterThanOrEqual(110 * TICKS);
      await c.stop();
    }
  );
});

describe('matrix A — code review native (S4j)', () => {
  row(
    'A13',
    'a system resume while the sign-in card shows is ignored: the engine stays paused (review native #1)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(420);
      harness.server.answer('progress', reply.error(401, 'refresh_session_expired'));
      // A call pauses; the session ends during the call.
      harness.engine.emit({ type: 'userPlayback', paused: true, cause: 'call' });
      harness.engine.state('paused');
      await jest.advanceTimersByTimeAsync(10_000);
      expect(c.phase).toBe('failed');
      // The call ends: the OS says "may resume", the engine starts playing.
      harness.engine.emit({ type: 'userPlayback', paused: false });
      harness.engine.state('playing');
      expect(c.paused).toBe(true);
      expect(harness.engine.commands.at(-1)).toBe('pause');
      await c.stop();
    }
  );

  row(
    'A13',
    'media keys or a remote (no cause) pause as the viewer: no system hint, and the engine playing by itself is paused again (review native N24)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(42);
      const remote = await expoPlaying();
      remote.player.system(true, 'remote');
      remote.replay();
      await jest.advanceTimersByTimeAsync(3_000);
      expect(c.paused).toBe(true);
      expect(c.systemPaused).toBe(false);
      expect(c.status.hint).toBeNull();
      harness.engine.state('playing');
      expect(c.paused).toBe(true);
      expect(harness.engine.commands.at(-1)).toBe('pause');
      remote.engine.release();
      await c.stop();
    }
  );

  row(
    'A13',
    'the system resumes on its own (end of a call) without telling: playing, no hint, no pause command (review native N25)',
    async () => {
      const { c, expo } = await systemPause('call');
      expect(c.status.hint).toMatchObject({ key: 'pausedBySystem' });
      harness.engine.state('playing');
      expect(c.paused).toBe(false);
      expect(c.systemPaused).toBe(false);
      expect(c.status.hint).toBeNull();
      expect(harness.engine.commands.at(-1)).not.toBe('pause');
      expo.engine.release();
      await c.stop();
    }
  );

  row(
    'A18',
    'AirPlay ends with the engine: no stale "Playing on …" after VLC took over; the new engine’s probe is read (review native #2)',
    async () => {
      jest.useFakeTimers();
      harness.features.probe = true;
      const c = await playing({}, {}, 30);
      harness.engine.emit({ type: 'external', active: true, device: 'TV' });
      expect(c.status.hint).toEqual({ key: 'airplay', params: { device: 'TV' } });
      harness.server.answer(
        'switch',
        reply.ok(harness.server.playback({ engine: 'vlc' } as never))
      );
      await c.setEnginePreference('vlc');
      await settle();
      expect(harness.engine.kind).toBe('vlc');
      harness.engine.started();
      harness.engine.time(31);
      expect(c.external).toBeNull();
      expect(c.status.hint).toBeNull();
      // An engine whose probe says it plays elsewhere is external again, even without its own event.
      harness.engine.setHealth({ external: true });
      await playOn(2);
      expect(c.external).toEqual({});
      expect(c.status.hint).toEqual({ key: 'airplay', params: { device: 'AirPlay' } });
      await c.stop();
      expect(c.external).toBeNull();
    }
  );
});

describe('matrix A — live native audit S9b: the session ends under the player (S4k)', () => {
  row(
    'A05',
    "the account's session ends elsewhere (refresh refused) while playing: paused, the Sign in card in the player, the position kept (S9b A05)",
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(25);
      c.endSession({ code: 'refresh_session_expired' });
      expect(c.phase).toBe('failed');
      expect(c.paused).toBe(true);
      expect(harness.engine.pause).toHaveBeenCalled();
      expect(c.failure).toMatchObject({ code: 'refresh_session_expired', category: 'T3' });
      expect(cardButtons(c.failure!.actions)).toEqual(['signIn', 'back']);
      await c.stop();
    }
  );
});
