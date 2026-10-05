import { render } from '@testing-library/react-native';
import { createElement } from 'react';
import { AppState } from 'react-native';

import { categoryOf } from '@/api/error-categories';
import { describeError } from '@/api/error-text';
import i18n from '@/i18n';
import { cardButtons } from '@/screens/player/card-actions';
import { harness, newController, reply } from '@/../jest/player/harness';
import { pending, row } from '@/../jest/player/matrix';
import { expoVideoView } from '@/../jest/player/library-fakes';
import { expoPlaying } from '@/../jest/player/native';
import { fakeNetwork, playing, settle, starts } from '@/../jest/player/play';

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
  pending(
    'A03',
    'pause and save the position locally before the card; queue flush after sign-in',
    'S6'
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
  pending('A15', 'PiP start / stop via button or leaving the app', 'regression test, S3+');
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
  pending('A17', 'Failure while in PiP', 'S4');
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
      expect(c.phase).toBe('failed');
      // The network must stay back for 2 s before the card retries on its own (flapping Wi-Fi).
      await jest.advanceTimersByTimeAsync(2_000);
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
