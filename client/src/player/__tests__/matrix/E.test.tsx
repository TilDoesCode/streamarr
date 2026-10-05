import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describeError } from '@/api/error-text';
import i18n from '@/i18n';
import { noticeError, noticeMs, stepDownReasonKey } from '@/player/overlay-labels';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Platform } from 'react-native';

import {
  HINT_MS,
  RESUME_REVALIDATE_MS,
  SPINNER_MS,
  STALL_LADDER_MS,
  START_BUDGET_MS,
  STATE_BUDGET_MS,
  SYSTEM_PAUSE_MS,
} from '@/player/controller';
import { PlayerStatusView, statusLayout } from '@/screens/player/player-status';
import { UpNextCard } from '@/screens/player/up-next';
import { useCloseOnFailure } from '@/screens/player/use-close-on-failure';
import { harness, newController, reply } from '@/../jest/player/harness';
import { pending, row } from '@/../jest/player/matrix';
import { fakeNetwork, playing, settle, starts, TICKS } from '@/../jest/player/play';
import { renderWithProviders } from '@/../jest/render';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());

const generic = () => describeError(i18n.t, { code: 'unknown' });

beforeEach(() => harness.reset());
afterEach(() => jest.useRealTimers());

// State matrix layer E (docs/client/player/state-matrix.md § 1): one test per row id.

describe('matrix E — Player UI states', () => {
  row('E01', 'the stepper lists the server states in order of appearance', async () => {
    jest.useFakeTimers();
    const server = harness.server;
    const queued = server.playback({ state: 'queued', pollAfterMs: 500 } as never);
    server.answer('start', reply.ok(queued));
    server.answer(
      'poll',
      reply.ok({ ...queued, state: 'resolving' }),
      reply.ok({ ...queued, state: 'resolving' }),
      reply.ok({ ...queued, state: 'ready' })
    );
    const c = newController();
    const started = c.start();
    await jest.advanceTimersByTimeAsync(2_000);
    await started;
    expect(c.states).toEqual(['queued', 'resolving', 'ready']);
    await c.stop();
  });
  row(
    'E02',
    'a start state that takes longer than its budget explains itself in the start card',
    async () => {
      jest.useFakeTimers();
      const server = harness.server;
      const planning = server.playback({ state: 'planning', pollAfterMs: 60_000 } as never);
      server.answer('start', reply.ok(planning));
      const c = newController();
      void c.start();
      await jest.advanceTimersByTimeAsync(STATE_BUDGET_MS.planning! - 1_000);
      expect(c.status.hint).toBeNull();
      const before = c.getVersion();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(c.getVersion()).toBeGreaterThan(before);
      expect(c.status.hint).toEqual({ key: 'startSlow', params: { cause: 'preparing' } });
      await c.stop();
    }
  );
  pending('E02', 'give up after twice the budget with Retry / Other version (B16)', 'S4b');
  row(
    'E03',
    'a spinner from ready until the first frame, a cause hint by 4 s, a reload after 20 s',
    async () => {
      jest.useFakeTimers();
      const c = newController();
      await c.start();
      expect(c.phase).toBe('playing');
      expect(c.status).toEqual({ spinner: true, hint: null, actions: [] });
      await jest.advanceTimersByTimeAsync(HINT_MS);
      expect(c.status.hint).toEqual({ key: 'startSlow', params: { cause: 'slowConnection' } });
      expect(c.status.actions).toEqual(['lowerQuality', 'cancel']);
      await jest.advanceTimersByTimeAsync(START_BUDGET_MS.progressive - HINT_MS);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(c.status).toMatchObject({ spinner: true, hint: { key: 'reloading' } });
      harness.engine.started();
      expect(c.status).toEqual({ spinner: false, hint: null, actions: [] });
      await c.stop();
    }
  );
  row('E03', 'the hint names a conversion for a transcode start', async () => {
    jest.useFakeTimers();
    harness.server.answer('start', reply.ok(harness.server.playback({ method: 'transcode' })));
    const c = newController();
    await c.start();
    await jest.advanceTimersByTimeAsync(HINT_MS);
    expect(c.status.hint).toEqual({ key: 'startSlow', params: { cause: 'converting' } });
    await c.stop();
  });
  row(
    'E04',
    'buffering mid-play: spinner after 1 s (at once after a seek), hint after 4 s, ladder after 15 s',
    async () => {
      jest.useFakeTimers();
      const c = await playing(
        {},
        { mediaInfo: { durationTicks: 600 * TICKS, video: { height: 1080 } } } as never,
        60
      );
      harness.engine.emit({ type: 'buffering', buffering: true });
      expect(c.status.spinner).toBe(false);
      await jest.advanceTimersByTimeAsync(SPINNER_MS);
      expect(c.status).toEqual({ spinner: true, hint: null, actions: [] });
      await jest.advanceTimersByTimeAsync(HINT_MS - SPINNER_MS);
      expect(c.status.hint).toEqual({ key: 'buffering' });
      expect(c.status.actions).toEqual(['lowerQuality']);
      harness.engine.emit({ type: 'buffering', buffering: false });
      expect(c.status.spinner).toBe(false);
      c.seekTo(200);
      harness.engine.state('buffering');
      expect(c.status.spinner).toBe(true);
      harness.engine.state('playing');
      await jest.advanceTimersByTimeAsync(3_000);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(STALL_LADDER_MS);
      expect(harness.server.sent('switch').at(-1)?.body).toMatchObject({
        preferences: expect.objectContaining({ maxHeight: 720 }),
      });
      await c.stop();
    }
  );
  row('E05', 'a pause by the viewer pauses the engine, reports and shows no status', async () => {
    jest.useFakeTimers();
    const c = await playing({}, {}, 12);
    c.setPaused(true);
    expect(harness.engine.pause).toHaveBeenCalled();
    expect(c.status).toEqual({ spinner: false, hint: null, actions: [] });
    await settle();
    expect(harness.server.sent('progress').at(-1)?.body).toMatchObject({
      positionTicks: 12 * TICKS,
    });
    await c.stop();
  });
  row('E06', 'a pause by the system is adopted with a hint and Resume', async () => {
    jest.useFakeTimers();
    const c = await playing({}, {}, 30);
    harness.engine.state('paused');
    expect(c.paused).toBe(false);
    await jest.advanceTimersByTimeAsync(SYSTEM_PAUSE_MS);
    expect(c.paused).toBe(true);
    expect(c.status).toEqual({
      spinner: false,
      hint: { key: 'pausedBySystem', params: { cause: 'outside' } },
      actions: ['resume'],
    });
    harness.engine.play.mockClear();
    c.setPaused(false);
    expect(harness.engine.play).toHaveBeenCalled();
    expect(c.status.hint).toBeNull();
    await c.stop();
  });
  row('E06', 'its own pause is not a system pause', async () => {
    jest.useFakeTimers();
    const c = await playing({}, {}, 30);
    c.setPaused(true);
    harness.engine.state('paused');
    await jest.advanceTimersByTimeAsync(SYSTEM_PAUSE_MS);
    expect(c.systemPaused).toBe(false);
    expect(c.status.hint).toBeNull();
    await c.stop();
  });
  row('E07', 'the up-next countdown stops while paused', async () => {
    jest.useFakeTimers();
    const next = { workId: 'w2', title: 'Next', playTitle: 'Next' };
    const onPlay = jest.fn();
    const view = await renderWithProviders(
      <UpNextCard next={next} paused onPlay={onPlay} onCancel={jest.fn()} />
    );
    const shown = () => screen.getByTestId('player-up-next-countdown').props.children;
    const before = shown();
    await act(async () => jest.advanceTimersByTime(5_000));
    expect(shown()).toEqual(before);
    await view.rerender(
      <UpNextCard next={next} paused={false} onPlay={onPlay} onCancel={jest.fn()} />
    );
    await act(async () => jest.advanceTimersByTime(3_000));
    expect(shown()).not.toEqual(before);
    expect(onPlay).not.toHaveBeenCalled();
  });
  row('E08', 'closing reports the position, stops the engine and the session once', async () => {
    jest.useFakeTimers();
    const c = await playing({}, {}, 77);
    await c.stop();
    await settle();
    expect(c.phase).toBe('stopped');
    expect(harness.engine.shutdown).toHaveBeenCalledTimes(1);
    expect(harness.server.sent('progress').at(-1)?.body).toMatchObject({
      event: 'stop',
      positionTicks: 77 * TICKS,
    });
    await c.stop();
    expect(harness.engine.shutdown).toHaveBeenCalledTimes(1);
  });
  row(
    'E09',
    'the card lists what was tried, and Retry resumes at the last good position without asking',
    async () => {
      jest.useFakeTimers();
      const server = harness.server;
      const c = await playing({ startSeconds: undefined }, {}, 300);
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
      harness.engine.fail('decoder failure');
      await settle();
      harness.engine.fail('decoder failure');
      await settle();
      expect(c.phase).toBe('failed');
      expect(c.failure?.tried?.map((attempt) => [attempt.step, attempt.position])).toEqual([
        ['R', 300],
        ['S', 300],
      ]);
      expect(c.failure?.actions).toEqual(['otherVersion', 'useVlc']);
      expect(c.retry()).toBe(true);
      await settle();
      expect(starts().at(-1)?.position).toBe(300);
      expect(c.phase).toBe('playing');
      expect(harness.engine.source?.startPosition).toBe(300);
      await c.stop();
    }
  );
  row('E10', 'panels and the version picker close when the playback fails', async () => {
    const close = jest.fn();
    function Probe({ failed }: { failed: boolean }) {
      useCloseOnFailure(failed, close);
      return null;
    }
    const view = await render(<Probe failed={false} />);
    expect(close).not.toHaveBeenCalled();
    await view.rerender(<Probe failed />);
    expect(close).toHaveBeenCalledTimes(1);
  });
  row('E11', 'notices stay 6 s, on TV 8 s', () => {
    expect(noticeMs(false)).toBe(6_000);
    expect(noticeMs(true)).toBe(8_000);
  });
  row('E12', 'status hints never take focus on TV: no buttons, touches pass through', async () => {
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const status = {
      spinner: true,
      hint: { key: 'pausedBySystem' as const, params: { cause: 'call' } },
      actions: ['resume' as const],
    };
    await renderWithProviders(<PlayerStatusView status={status} onAction={jest.fn()} />);
    expect(screen.getByTestId('player-status')).toHaveProp('pointerEvents', 'none');
    expect(screen.queryByTestId('player-status-action-resume')).toBeNull();
    expect(screen.getByText('Paused: call.')).toBeOnTheScreen();
    jest.restoreAllMocks();
  });
  row('E12', 'on touch the actions are buttons without preferred focus', async () => {
    const onAction = jest.fn();
    const status = {
      spinner: false,
      hint: { key: 'mutedAutoplay' as const },
      actions: ['unmute' as const],
    };
    await renderWithProviders(<PlayerStatusView status={status} onAction={onAction} />);
    fireEvent.press(screen.getByTestId('player-status-action-unmute'));
    expect(onAction).toHaveBeenCalledWith('unmute');
    // Preferred focus is checked on what the view passes to its buttons: player-status.test (review M15).
  });
  row('E13', 'offline shows the banner at once and keeps the engine', async () => {
    jest.useFakeTimers();
    const network = fakeNetwork();
    const c = await playing({ network }, {}, 50);
    network.set(false);
    expect(c.status).toEqual({ spinner: false, hint: { key: 'offline' }, actions: ['back'] });
    expect(harness.engine.load).toHaveBeenCalledTimes(1);
    network.set(true);
    expect(c.status.hint).toBeNull();
    await c.stop();
  });
  row('E14', 'the step-down notice says why', async () => {
    jest.useFakeTimers();
    const server = harness.server;
    const c = await playing({}, {}, 0);
    server.answer('switch', (request) =>
      reply.ok(
        server.playback({ playbackId: request.playbackId, method: 'transcode', revision: 1 })
      )
    );
    await jest.advanceTimersByTimeAsync(0);
    harness.engine.fail('decoder init failed');
    await settle();
    harness.engine.fail('decoder init failed');
    await settle();
    expect(c.notice).toMatchObject({
      kind: 'stepDown',
      params: { reason: 'decode_error', to: 'transcode' },
    });
    await i18n.changeLanguage('en');
    expect(stepDownReasonKey(c.notice!.params)).toBe('notice.because.T7');
    expect(stepDownReasonKey({ reason: 'start_timeout' })).toBe('notice.because.start_timeout');
    expect(stepDownReasonKey({ reason: 'playback_stalled' })).toBe('notice.because.T5');
    expect(stepDownReasonKey({ reason: 'network_unreachable' })).toBeUndefined();
    await c.stop();
  });
  row(
    'E15',
    'switchFailed names the category of an unknown code, never the generic reason',
    async () => {
      await i18n.changeLanguage('en');
      const controller = newController();
      await controller.start();
      harness.engine.started();
      harness.server.answer('switch', reply.error(503, 'brand_new_code'));
      expect(await controller.setQuality(720)).toBe(false);
      expect(controller.phase).toBe('playing');
      expect(controller.notice).toMatchObject({
        kind: 'switchFailed',
        params: { code: 'brand_new_code', status: '503' },
      });
      const reason = describeError(i18n.t, noticeError(controller.notice!.params)).message;
      expect(reason).toBe(i18n.t('errors.categories.T4.message'));
      expect(reason).not.toBe(generic().message);
      expect(noticeError({ code: 'x', status: '0' }).status).toBe(0);
      await controller.stop();
    }
  );
  row('E16', 'device capabilities that fail to load get their own code and text', async () => {
    const screen = readFileSync(join(__dirname, '../../../screens/player/play-screen.tsx'), 'utf8');
    expect(screen).toContain("setCapsError('device_caps_unavailable')");
    for (const lng of ['en', 'de']) {
      await i18n.changeLanguage(lng);
      const text = describeError(i18n.t, { code: 'device_caps_unavailable' });
      expect(text).not.toEqual(generic());
    }
    await i18n.changeLanguage('en');
  });
  pending('E16', 'fall back to a conservative static profile and play', 'S3');
  row(
    'E17',
    "a resume prompt left open past the server's idle end starts anew at the choice",
    async () => {
      jest.useFakeTimers();
      const server = harness.server;
      server.answer(
        'start',
        reply.ok(
          server.playback({
            resumePositionTicks: 1_000 * TICKS,
            mediaInfo: { durationTicks: 3_600 * TICKS, audioTracks: [], subtitleTracks: [] },
          } as never)
        )
      );
      const c = newController({ startSeconds: undefined });
      const started = c.start();
      await settle();
      expect(c.phase).toBe('resume');
      await jest.advanceTimersByTimeAsync(RESUME_REVALIDATE_MS);
      server.answer('poll', reply.error(404, 'playback_not_found'));
      c.chooseStart(true);
      await started;
      expect(starts().map((start) => start.position)).toEqual([0, 1_000]);
      expect(harness.engine.source?.startPosition).toBe(1_000);
      await c.stop();
    }
  );
  pending('E18', '"Switching…" card (phase === \'switching\')', 'S4');
});

describe('matrix E — code review S1-S4 (S4b)', () => {
  row(
    'E09',
    'a client exception never shows "Something went wrong": its own text, Retry and the code (review 11)',
    async () => {
      jest.useFakeTimers();
      await i18n.changeLanguage('en');
      const broken = () => {
        throw new Error('vlc module missing');
      };
      harness.server.answer('start', broken, broken);
      const c = newController();
      await c.start();
      await settle();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(c.phase).toBe('failed');
      expect(c.failure).toMatchObject({
        code: 'player_internal_error',
        category: 'T11',
        actions: ['retry'],
      });
      const text = describeError(i18n.t, c.failure!);
      expect(text.title).toBe('The player hit an internal error');
      expect(text).not.toEqual(generic());
      expect(i18n.t('errors.codeLabel', { code: c.failure!.code })).toContain(
        'player_internal_error'
      );
    }
  );

  row(
    'E04',
    "the timeline is the design's: spinner at 1 s, hint at 4 s, ladder at 15 s (literal numbers, review M11)",
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 100);
      harness.engine.emit({ type: 'buffering', buffering: true });
      await jest.advanceTimersByTimeAsync(900);
      expect(c.status.spinner).toBe(false);
      await jest.advanceTimersByTimeAsync(100);
      expect(c.status.spinner).toBe(true);
      await jest.advanceTimersByTimeAsync(2_900);
      expect(c.status.hint).toBeNull();
      await jest.advanceTimersByTimeAsync(100);
      expect(c.status.hint).not.toBeNull();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(harness.server.sent('switch')).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(harness.server.sent('switch')).toHaveLength(1);
      expect({ SPINNER_MS, HINT_MS, STALL_LADDER_MS, START_BUDGET_MS }).toEqual({
        SPINNER_MS: 1_000,
        HINT_MS: 4_000,
        STALL_LADDER_MS: 15_000,
        START_BUDGET_MS: { progressive: 20_000, hls: 30_000 },
      });
      await c.stop();
    }
  );

  row(
    'E11',
    'with visible controls the hint moves under the top bar (below a notice) and the spinner leaves the centre (review 20)',
    () => {
      const base = { tv: false, spinner: true, top: 80, noticeShown: false, noticeHeight: 64 };
      expect(statusLayout({ ...base, controlsVisible: false })).toEqual({
        anchor: 'centre',
        spinner: true,
        offset: 0,
      });
      expect(statusLayout({ ...base, controlsVisible: true })).toEqual({
        anchor: 'top',
        spinner: false,
        offset: 80,
      });
      expect(statusLayout({ ...base, controlsVisible: true, noticeShown: true })).toEqual({
        anchor: 'top',
        spinner: false,
        offset: 144,
      });
      expect(statusLayout({ ...base, controlsVisible: true, tv: true })).toEqual({
        anchor: 'centre',
        spinner: true,
        offset: 0,
      });
    }
  );

  row(
    'E11',
    'screen readers hear a hint once per change, not every countdown second (review 19)',
    async () => {
      const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
      const said = (start: string) =>
        announce.mock.calls.filter(([text]) => String(text).startsWith(start));
      const status = (seconds: number) => ({
        spinner: true,
        hint: { key: 'serverBusy' as const, params: { seconds } },
        actions: [],
      });
      const view = await renderWithProviders(
        <PlayerStatusView status={status(9)} onAction={jest.fn()} />
      );
      await view.rerender(<PlayerStatusView status={status(8)} onAction={jest.fn()} />);
      await view.rerender(<PlayerStatusView status={status(7)} onAction={jest.fn()} />);
      expect(said('The server is busy')).toEqual([['The server is busy. Retrying in 9 s…']]);
      await view.rerender(
        <PlayerStatusView
          status={{ spinner: true, hint: { key: 'offline' }, actions: [] }}
          onAction={jest.fn()}
        />
      );
      expect(said('No network')).toHaveLength(1);
      announce.mockRestore();
    }
  );
});
