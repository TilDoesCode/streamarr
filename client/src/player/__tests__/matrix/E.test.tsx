import { statusOf } from '@/player/recovery/status';
import { describeError } from '@/api/error-text';
import i18n from '@/i18n';
import { endOverlay } from '@/player/end-state';
import { createPlayer, profileOrFallback } from '@/player/caps-fallback';
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
import { row } from '@/../jest/player/matrix';
import { fakeNetwork, playing, settle, starts, TICKS } from '@/../jest/player/play';
import { renderWithProviders } from '@/../jest/render';
import { FakeVideoElement } from '@/../jest/player/library-fakes';
import { loadHls, WebEngine } from '@/player/engines/web-engine.web';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());
jest.mock('hls.js', () => jest.requireActual('@/../jest/player/library-fakes').hlsJsModule());

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
      expect(c.status.hint).toEqual({ key: 'startSlow', params: { cause: 'loadingFile' } });
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
      harness.engine.time(harness.engine.getSnapshot().position + 0.5);
      expect(c.status.spinner).toBe(false);
      c.seekTo(200);
      harness.engine.state('buffering');
      expect(c.status.spinner).toBe(true);
      harness.engine.state('playing');
      harness.engine.time(harness.engine.getSnapshot().position + 0.5);
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
    expect(screen.getByText('Paused: incoming call.')).toBeOnTheScreen();
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
    expect(stepDownReasonKey({ reason: 'picture_timeout' })).toBe('notice.because.picture_timeout');
    // A stall without a decoder error names what was seen (S4m); "too slowly" stays for a measured timeout.
    expect(stepDownReasonKey({ reason: 'playback_stalled' })).toBe('notice.because.stalled');
    expect(stepDownReasonKey({ reason: 'segment_timeout' })).toBe('notice.because.T5');
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
  row(
    'E16',
    'device capabilities that fail to load: the player is created with the conservative profile and starts; no card',
    async () => {
      jest.useFakeTimers();
      const made: unknown[] = [];
      const c = await createPlayer(
        () => Promise.reject(new Error('media-caps missing')),
        (profile) => {
          made.push(profile);
          return newController({ profile });
        }
      );
      await settle();
      expect(made).toHaveLength(1);
      expect(made[0]).toMatchObject({
        engines: [
          expect.objectContaining({
            videoCodecs: [expect.objectContaining({ codec: 'h264', maxHeight: 1080 })],
            audioCodecs: [expect.objectContaining({ codec: 'aac', maxChannels: 2 })],
          }),
        ],
      });
      expect(harness.server.sent('start')[0]?.body).toMatchObject({ device: made[0] });
      expect(c?.failure).toBeNull();
      await c?.stop();
      // A screen that left before the profile came creates nothing.
      expect(
        await createPlayer(
          async () => ({ profile: made[0] as never }),
          () => null
        )
      ).toBeNull();
      // A measured profile is used as it is.
      const measured = { platform: 'web', engines: [], vlcAvailable: true } as never;
      expect(await profileOrFallback(async () => ({ profile: measured }))).toBe(measured);
      for (const lng of ['en', 'de']) {
        await i18n.changeLanguage(lng);
        expect(describeError(i18n.t, { code: 'player_internal_error' })).not.toEqual(generic());
      }
      await i18n.changeLanguage('en');
    }
  );
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
    'with visible controls the hint and the spinner move under the top bar (below a notice); the spinner is never hidden (review 20, S9a2 START)',
    () => {
      const base = { tv: false, top: 80, noticeShown: false, noticeHeight: 64 };
      expect(statusLayout({ ...base, controlsVisible: false })).toEqual({
        anchor: 'centre',
        offset: 0,
      });
      expect(statusLayout({ ...base, controlsVisible: true })).toEqual({
        anchor: 'top',
        offset: 80,
      });
      expect(statusLayout({ ...base, controlsVisible: true, noticeShown: true })).toEqual({
        anchor: 'top',
        offset: 144,
      });
      expect(statusLayout({ ...base, controlsVisible: true, tv: true })).toEqual({
        anchor: 'centre',
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

describe('matrix E — code review S5 + S4b (S4d)', () => {
  row(
    'E18',
    'a step whose switch ends in a failed playback never leaves the phase on "switching" (review R9)',
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
            error: { code: 'transcode_capacity' },
          } as never)
        )
      );
      const decode = 'MediaCodecVideoRenderer error: decoder init failed';
      harness.engine.fail(decode);
      await settle();
      harness.engine.fail(decode);
      await settle();
      expect(c.phase).not.toBe('switching');
      await c.stop();
    }
  );

  row(
    'E11',
    'the screen reader label follows the live hint, while the announcement stays one per hint (review R10)',
    async () => {
      const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
      const status = (seconds: number) => ({
        spinner: true,
        hint: { key: 'serverBusy' as const, params: { seconds } },
        actions: [],
      });
      const view = await renderWithProviders(
        <PlayerStatusView status={status(9)} onAction={jest.fn()} />
      );
      await view.rerender(<PlayerStatusView status={status(4)} onAction={jest.fn()} />);
      expect(screen.getByLabelText('The server is busy. Retrying in 4 s…')).toBeTruthy();
      expect(
        announce.mock.calls.filter(([text]) => String(text).startsWith('The server is busy'))
      ).toHaveLength(1);
      announce.mockRestore();
    }
  );
});

describe('matrix E — live web audit S9a (S4d)', () => {
  row(
    'E03',
    'hls.js reports 0:00 before it applies the start position: still loading, the spinner stays and the budget runs (S9a START, C21)',
    async () => {
      jest.useFakeTimers();
      harness.server.answer(
        'start',
        reply.ok(harness.server.playback({ method: 'remux' } as never))
      );
      const c = newController({ startSeconds: 90 });
      await c.start();
      harness.engine.state('playing');
      harness.engine.time(0, 180);
      expect(c.status.spinner).toBe(true);
      await jest.advanceTimersByTimeAsync(4_000);
      expect(c.status.hint?.key).toBe('startSlow');
      await jest.advanceTimersByTimeAsync(27_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      expect(harness.engine.source?.startPosition).toBe(90);
      await c.stop();
    }
  );

  row(
    'E03',
    'a clock that runs on from the start position counts as a picture (engines without a first-frame event)',
    async () => {
      jest.useFakeTimers();
      const c = newController({ startSeconds: 90 });
      await c.start();
      harness.engine.state('playing');
      harness.engine.time(90, 180);
      expect(c.status.spinner).toBe(true);
      harness.engine.time(90.5, 180);
      harness.engine.time(91.2, 180);
      expect(c.status.spinner).toBe(false);
      await c.stop();
    }
  );
});

describe('matrix E — a switch the server never finishes (S9a P8, P2, D10)', () => {
  const starting = (id: string) =>
    reply.ok(
      harness.server.playback({
        playbackId: id,
        state: 'starting',
        revision: 1,
        pollAfterMs: 1000,
      } as never)
    );

  row(
    'E18',
    'a viewer switch stuck in "starting": the switching card explains after 45 s and the ladder takes over after 60 s',
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
      const id = c.playback!.playbackId!;
      harness.server.answer('switch', starting(id));
      harness.server.answer('poll', ...Array.from({ length: 200 }, () => starting(id)));
      const switching = c.setQuality(720);
      await settle();
      expect(c.phase).toBe('switching');
      await jest.advanceTimersByTimeAsync(46_000);
      expect(c.status.hint).toEqual({ key: 'startSlow', params: { cause: 'preparing' } });
      await jest.advanceTimersByTimeAsync(15_000);
      await switching;
      expect(c.phase).not.toBe('switching');
      await jest.advanceTimersByTimeAsync(10_000);
      expect(starts()).toHaveLength(2);
      expect(starts().at(-1)?.position).toBe(41);
      await c.stop();
    }
  );
});

describe('matrix E — the engine throws on a new source (S9a E09)', () => {
  row(
    'E09',
    'an engine whose load throws stops the old source and ends on the internal-error card, no further steps',
    async () => {
      jest.useFakeTimers();
      await i18n.changeLanguage('en');
      const c = await playing({}, {}, 24);
      harness.engine.load.mockImplementationOnce(() => {
        throw new Error('load exploded');
      });
      const before = harness.engine.commands.length;
      harness.engine.fail('Source error: InvalidResponseCodeException: Response code: 404');
      await settle();
      // The engine stops the old source the moment the load throws, before anything else happens.
      expect(harness.engine.commands.slice(before, before + 2)).toEqual(['pause', 'shutdown']);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(c.phase).toBe('failed');
      expect(c.failure).toMatchObject({
        code: 'player_internal_error',
        category: 'T11',
        actions: ['retry'],
      });
      expect(describeError(i18n.t, c.failure!).title).toBe('The player hit an internal error');
      expect(harness.engine.pause).toHaveBeenCalled();
      expect(harness.server.sent('switch')).toHaveLength(0);
    }
  );
});

describe('matrix E — stuck start states, the switching picture (S4f)', () => {
  row(
    'E02',
    'a start state past its budget explains itself in the start card, and past twice the budget the card offers Retry and Other version',
    async () => {
      jest.useFakeTimers();
      const server = harness.server;
      const planning = server.playback({ state: 'planning', pollAfterMs: 1_000 } as never);
      server.answer('start', reply.ok(planning));
      server.answer('poll', ...Array.from({ length: 200 }, () => reply.ok({ ...planning })));
      const c = newController();
      void c.start();
      await jest.advanceTimersByTimeAsync(29_000);
      expect(c.status.hint).toBeNull();
      await jest.advanceTimersByTimeAsync(2_000);
      expect(c.status.hint).toEqual({ key: 'startSlow', params: { cause: 'preparing' } });
      await jest.advanceTimersByTimeAsync(30_000);
      expect(c.phase).toBe('failed');
      expect(c.failure).toMatchObject({ code: 'start_stuck', params: { state: 'planning' } });
      await i18n.changeLanguage('en');
      expect(describeError(i18n.t, c.failure!).title).toBe(
        'The server got stuck preparing the video'
      );
    }
  );

  row(
    'E18',
    'web: the last frame stays as the poster while the next source loads, and goes with its first frame',
    async () => {
      const draw = jest.fn();
      (globalThis as { document?: unknown }).document = {
        createElement: () => ({
          canPlayType: () => '',
          getContext: () => ({
            drawImage: draw,
            getImageData: () => ({ data: new Uint8ClampedArray(4) }),
          }),
          toDataURL: () => 'data:image/jpeg;base64,LAST',
        }),
      };
      try {
        const engine = new WebEngine();
        const video = new FakeVideoElement() as FakeVideoElement & { poster?: string };
        (engine as unknown as { attach(video: unknown): void }).attach(video);
        await loadHls();
        engine.load({ uri: 'http://server.test/a/master.m3u8', kind: 'hls' });
        video.present(24);
        engine.load({ uri: 'http://server.test/b/master.m3u8', kind: 'hls', keepLastFrame: true });
        expect(video.poster).toBe('data:image/jpeg;base64,LAST');
        video.present(1);
        expect(video.poster).toBe('');
        engine.release();
        // A plain cross-origin src cannot be read: no poster rather than a tainted canvas.
        const plain = new WebEngine();
        const element = new FakeVideoElement() as FakeVideoElement & { poster?: string };
        Object.defineProperty(plain, 'mode', { value: 'native' });
        (plain as unknown as { attach(video: unknown): void }).attach(element);
        plain.load({ uri: 'http://server.test/a.mkv', kind: 'progressive' });
        element.present(24);
        plain.load({ uri: 'http://server.test/b.mkv', kind: 'progressive', keepLastFrame: true });
        expect(element.poster).toBe('');
        plain.release();
      } finally {
        delete (globalThis as { document?: unknown }).document;
      }
    }
  );
});

describe('matrix E — code review S4c-S4f (S4g)', () => {
  row(
    'E18',
    'an engine "ended" while a viewer switch runs is the old source going away, not the end of the title (review M17)',
    async () => {
      jest.useFakeTimers();
      // At 9:58 of 10:00 an "ended" of the old source would otherwise finish the title.
      const c = await playing({}, { method: 'remux' } as never, 0);
      harness.engine.time(598, 600);
      const id = c.playback!.playbackId!;
      harness.server.answer(
        'switch',
        reply.ok(
          harness.server.playback({
            playbackId: id,
            state: 'starting',
            revision: 1,
            pollAfterMs: 1000,
          } as never)
        )
      );
      const switching = c.setQuality(720);
      await settle();
      expect(c.phase).toBe('switching');
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.ended).toBe(false);
      expect(c.failure).toBeNull();
      await c.stop();
      await switching;
    }
  );

  row(
    'E18',
    'an audio pick while a reload waits is the audio the reload brings back (review M16)',
    async () => {
      jest.useFakeTimers();
      const audioTracks = [
        { index: 1, language: 'en', deliveredAs: 'original', selected: true },
        { index: 2, language: 'de', deliveredAs: 'original', selected: false },
      ];
      const c = await playing(
        {},
        {
          method: 'remux',
          mediaInfo: { durationTicks: 6e9, audioTracks, subtitleTracks: [] },
        } as never,
        100
      );
      const tracks = (selected: number) => ({
        audio: [
          { id: 'a0', label: 'en', language: 'en', selected: selected === 0 },
          { id: 'a1', label: 'de', language: 'de', selected: selected === 1 },
        ],
        subtitles: [],
      });
      harness.engine.emit({ type: 'tracks', tracks: tracks(0) });
      harness.engine.emit({ type: 'error', reason: 'networkError:fragLoadError', status: 503 });
      await settle();
      expect(c.status.hint).toMatchObject({ key: 'serverError' });
      // The viewer picks German while the reload waits; the engine still lists its tracks.
      await c.selectAudio(audioTracks[1] as never);
      harness.engine.emit({ type: 'tracks', tracks: tracks(1) });
      await jest.advanceTimersByTimeAsync(6_000);
      expect(harness.engine.load).toHaveBeenCalledTimes(2);
      // The reloaded engine starts on its default (English); the reload itself puts German back.
      const before = harness.engine.commands.length;
      harness.engine.emit({ type: 'tracks', tracks: tracks(0) });
      expect(harness.engine.commands.slice(before)).toContain('audio:a1');
      await c.stop();
    }
  );
});

describe('matrix E — the poster is asked for only under the switching card (S4g, review R5)', () => {
  row('E18', 'a viewer switch keeps the last frame; a reload does not', async () => {
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
      40
    );
    await c.setQuality(720);
    expect(harness.engine.source?.keepLastFrame).toBe(true);
    harness.engine.started();
    harness.engine.fail('Source error: InvalidResponseCodeException: Response code: 503');
    await jest.advanceTimersByTimeAsync(6_000);
    expect(harness.engine.load).toHaveBeenCalledTimes(3);
    expect(harness.engine.source?.keepLastFrame).toBe(false);
    await c.stop();
  });
});

describe('matrix E — live re-audit S9a2: the start at a saved position (S4i)', () => {
  row(
    'E02',
    'while a source loads at 1:30 the clock says 1:30, not 0:00; once it plays the engine clock counts (S9a2 START)',
    async () => {
      harness.server.answer('start', reply.ok(harness.server.playback()));
      const c = newController({ startSeconds: 90 });
      await c.start();
      // A loading engine reports 0 until its seek to the start position lands.
      harness.engine.time(0, 180);
      expect(c.position).toBe(90);
      harness.engine.started();
      harness.engine.time(91, 600);
      expect(c.position).toBe(91);
      await c.stop();
    }
  );
});

describe('matrix E — code review native: the start floor (S4j)', () => {
  row(
    'E02',
    'an engine that lands 2 s before the start position has arrived: the clock follows the engine (review native N22)',
    async () => {
      harness.server.answer('start', reply.ok(harness.server.playback()));
      const c = newController({ startSeconds: 90 });
      await c.start();
      harness.engine.time(0, 180);
      expect(c.position).toBe(90);
      harness.engine.started();
      harness.engine.time(88, 180);
      expect(c.position).toBe(88);
      await c.stop();
    }
  );
});

describe('matrix E — the spinner under visible controls (S4j)', () => {
  row(
    'E11',
    'with the controls up the spinner is drawn under the top bar, not dropped (S9a2 START)',
    async () => {
      const status = { spinner: true, hint: null, actions: [] };
      await renderWithProviders(
        <PlayerStatusView status={status} onAction={jest.fn()} controlsVisible top={80} />
      );
      expect(screen.getByTestId('player-status-spinner')).toBeOnTheScreen();
    }
  );
});

describe('matrix E — live native audit S9b: a slow direct start names the engine, not the network (S4k)', () => {
  const input = {
    now: 10_000,
    phase: 'playing',
    offline: false,
    recovery: null,
    loadingSince: 1,
    stallSince: 0,
    seekAt: 0,
    seeking: false,
    paused: false,
    systemPaused: false,
    autoplay: null,
    health: null,
    frozenAt: 0,
    serverState: '',
    serverStateSince: 0,
    method: 'direct',
    bitrateKbps: 8_000,
    bandwidthBps: 50_000_000,
  } as const;

  row(
    'E03',
    'direct play on a fast link: "The player is still opening the file." (S9b START VLC)',
    () => {
      expect(statusOf(input).hint).toEqual({ key: 'startSlow', params: { cause: 'loadingFile' } });
    }
  );

  row('E03', 'a measured slow link or a late first byte is still "The connection is slow."', () => {
    expect(statusOf({ ...input, bandwidthBps: 5_000_000 }).hint).toEqual({
      key: 'startSlow',
      params: { cause: 'slowConnection' },
    });
    expect(
      statusOf({ ...input, fetch: { waitMs: 3_000, transferMs: 100, bytes: 1 } }).hint
    ).toEqual({ key: 'startSlow', params: { cause: 'slowConnection' } });
  });
});

describe('matrix E — S4s: a seek or play after the end leaves the end card (S6x Left)', () => {
  row(
    'E07',
    'seekTo(60) after the title ended: no "Finished" card over the playing picture',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(600, 600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.ended).toBe(true);
      expect(
        endOverlay({
          playing: true,
          ended: c.ended,
          hasNext: false,
          upNextDismissed: false,
          blocked: false,
          remaining: 0,
          duration: 600,
          upNextSeconds: 30,
        })
      ).toBe('endCard');
      c.seekTo(60);
      expect(c.ended).toBe(false);
      expect(
        endOverlay({
          playing: true,
          ended: c.ended,
          hasNext: true,
          upNextDismissed: false,
          blocked: false,
          remaining: 540,
          duration: 600,
          upNextSeconds: 30,
        })
      ).toBeNull();
      await c.stop();
    }
  );

  row(
    'E07',
    'Play from the system controls after the end plays again, not "Finished"',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(600, 600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      c.setPaused(true);
      c.setPaused(false);
      expect(c.ended).toBe(false);
      await c.stop();
    }
  );

  const overlayAt = (c: { ended: boolean }) =>
    endOverlay({
      playing: true,
      ended: c.ended,
      hasNext: false,
      upNextDismissed: false,
      blocked: false,
      remaining: 0,
      duration: 600,
      upNextSeconds: 30,
    });

  row(
    'E07',
    'a remote ▶ or the card Play right after the end (never paused) starts the title again: never a frozen last frame without a card (review 7 P2-2 A)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.time(600, 600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.ended).toBe(true);
      expect(c.paused).toBe(false);
      const plays = harness.engine.play.mock.calls.length;
      const heard = jest.fn();
      c.subscribe(heard);
      c.setPaused(false);
      expect(harness.engine.play.mock.calls.length).toBe(plays + 1);
      expect(harness.engine.seek).toHaveBeenLastCalledWith(0);
      expect(heard).toHaveBeenCalled();
      expect(c.ended).toBe(false);
      expect(overlayAt(c)).toBeNull();
      await c.stop();
    }
  );

  row(
    'E07',
    'web, V2 turn 2: Chrome\'s media controls / a media key play the <video> from 0:00 after the end without the app: "Finished" goes, a new viewing is reported',
    async () => {
      jest.useFakeTimers();
      const c = await playing({ nativeEngine: 'web' }, {}, 0);
      harness.engine.time(600, 600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(overlayAt(c)).toBe('endCard');
      const heard = jest.fn();
      c.subscribe(heard);
      // HTMLMediaElement.play() from outside: playing, the clock from the start, no userPlayback event.
      harness.engine.state('playing');
      harness.engine.time(0.4, 600);
      harness.engine.time(0.9, 600);
      expect(c.ended).toBe(false);
      expect(c.paused).toBe(false);
      expect(heard).toHaveBeenCalled();
      expect(overlayAt(c)).toBeNull();
      await settle();
      expect(harness.server.sent('progress').at(-1)?.body).toMatchObject({ positionTicks: 0 });
      await c.stop();
    }
  );

  row(
    'E07',
    'a time before the end while the engine is still "ended" (Safari scrubbing its ended element, no play) keeps the end card until it plays',
    async () => {
      jest.useFakeTimers();
      const c = await playing({ nativeEngine: 'web' }, {}, 0);
      harness.engine.time(600, 600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      harness.engine.time(300, 600);
      expect(c.ended).toBe(true);
      expect(overlayAt(c)).toBe('endCard');
      await c.stop();
    }
  );

  row(
    'E07',
    'Play from the system controls (media session) after the end: "Finished" goes and the listeners hear it (review 7 P2-2 B)',
    async () => {
      jest.useFakeTimers();
      const c = await playing({ nativeEngine: 'web' }, {}, 0);
      harness.engine.time(600, 600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(overlayAt(c)).toBe('endCard');
      const heard = jest.fn();
      c.subscribe(heard);
      harness.engine.emit({ type: 'userPlayback', paused: false });
      harness.engine.time(1, 600);
      expect(c.ended).toBe(false);
      expect(heard).toHaveBeenCalled();
      expect(overlayAt(c)).toBeNull();
      await c.stop();
    }
  );
});

describe('matrix E — S4y: a title that ends in picture-in-picture (V2 turn 3, iPad A16)', () => {
  row(
    'E07',
    'PiP ✕ after the end: no "Paused: picture-in-picture closed" with a Resume, the end state wins and up-next keeps running',
    async () => {
      jest.useFakeTimers();
      const c = await playing({}, {}, 0);
      harness.engine.emit({ type: 'pip', active: true });
      harness.engine.time(600, 600);
      harness.engine.emit({ type: 'ended' });
      await settle();
      expect(c.ended).toBe(true);
      // The ✕: iOS pauses the item (the engine names the cause) and puts it back to 0:00.5.
      harness.engine.emit({ type: 'userPlayback', paused: true, cause: 'pipClosed' });
      harness.engine.emit({ type: 'pip', active: false });
      harness.engine.time(0.5, 600);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(c.systemPaused).toBe(false);
      expect(c.paused).toBe(false);
      expect(c.status.hint?.key).not.toBe('pausedBySystem');
      expect(c.ended).toBe(true);
      expect(
        endOverlay({
          playing: true,
          ended: c.ended,
          hasNext: true,
          upNextDismissed: false,
          blocked: false,
          remaining: 0,
          duration: 600,
          upNextSeconds: 30,
        })
      ).toBe('upNext');
      await c.stop();
    }
  );

  row('E06', 'a PiP ✕ while the title still plays is the system pause as before', async () => {
    jest.useFakeTimers();
    const c = await playing({}, {}, 30);
    harness.engine.emit({ type: 'userPlayback', paused: true, cause: 'pipClosed' });
    expect(c.systemPaused).toBe(true);
    expect(c.status.hint).toMatchObject({ key: 'pausedBySystem', params: { cause: 'pipClosed' } });
    await c.stop();
  });
});
