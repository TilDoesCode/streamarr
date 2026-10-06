import { act, fireEvent, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';

import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';
import { row } from '@/../jest/player/matrix';
import type { PlayerStatus } from '@/player/recovery/status';
import { PlayScreen } from '@/screens/player/play-screen';

// Rows A15, B07/B10, E01, E02, E07, E09–E11, E16 as the viewer sees them: the real PlayScreen, a driven controller (V1).

/** The controller the screen creates: only what the screen reads, driven by the test. */
class MockPlayer {
  static all: MockPlayer[] = [];
  static throwOnCreate = false;
  phase = 'starting';
  paused = false;
  ended = false;
  pictureInPicture = false;
  notice: object | null = null;
  failure: object | null = null;
  states: string[] = [];
  resumeSeconds = 0;
  /** The title's length as the controller knows it (0 = the clock's). */
  duration = 0;
  playback: object | null = null;
  engine = null;
  status: PlayerStatus = { spinner: false, hint: null, actions: [] };
  private version = 0;
  private listeners = new Set<() => void>();
  constructor(readonly options: { profile: unknown }) {
    if (MockPlayer.throwOnCreate) throw new Error('engine module missing');
    MockPlayer.all.push(this);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getVersion = () => this.version;
  update(over: Partial<MockPlayer>) {
    Object.assign(this, over);
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }
  start = jest.fn(async () => undefined);
  stop = jest.fn(async () => undefined);
  retry = jest.fn(() => true);
  dismissNotice = jest.fn(() => this.update({ notice: null }));
  setPaused = jest.fn();
  yieldToOtherTab = jest.fn();
  endSession = jest.fn();
}

const mockProps: {
  panels?: { panel: unknown };
  picker?: { open: boolean };
  overlay?: { onPanel(kind: string): void };
} = {};
const mockCaps = jest.fn<Promise<{ profile: object }>, []>(async () => ({ profile: {} }));
const mockClock = { position: 0, duration: 0 };
const mockNext: { current: object | null } = { current: null };
const mockRouter = { back: jest.fn(), replace: jest.fn(), canGoBack: () => true };

let mockWindow: { width: number; height: number; scale: number; fontScale: number } | undefined;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => {
  const actual = jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions');
  return { __esModule: true, default: () => mockWindow ?? actual.default() };
});

jest.mock('@/player/controller', () => ({
  PlaybackController: function MockController(options: { profile: unknown }) {
    return new MockPlayer(options);
  },
}));
jest.mock('@/player/engines', () => ({
  nativeCandidates: () => ['web'],
  vlcAvailable: () => false,
}));
jest.mock('@/player/device-profile', () => ({ loadDeviceCaps: () => mockCaps() }));
jest.mock('@/player/use-clock', () => ({
  usePlayerClock: () => ({ clock: mockClock, onVisibleChange: () => undefined }),
}));
const mockAccount = {
  id: 'a1',
  serverUrl: 'http://dev.test',
  signedIn: true,
  mustChangePassword: false,
};
jest.mock('@/accounts/accounts-provider', () => ({
  useActiveAccount: () => ({ account: mockAccount, client: {} }),
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ playbackId: 'new', workId: 'tmdb-movie-1', title: 'Sintel' }),
  useNavigation: () => ({ getState: () => ({ routes: [] }), dispatch: jest.fn() }),
  useRouter: () => mockRouter,
}));
jest.mock('expo-router/react-navigation', () => ({
  ...jest.requireActual('expo-router/react-navigation'),
  usePreventRemove: () => undefined,
}));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
jest.mock('@/browse/queries', () => ({ invalidateWatchQueries: async () => undefined }));
jest.mock('@/browse/version-picker', () => ({
  VersionPicker: (props: { open: boolean }) => {
    mockProps.picker = props;
    return null;
  },
}));
jest.mock('@/screens/player/player-panels', () => ({
  PlayerPanels: (props: { panel: unknown }) => {
    mockProps.panels = props;
    return null;
  },
}));
jest.mock('@/navigation/screen-title', () => ({ useScreenTitle: () => undefined }));
jest.mock('@/screens/player/player-overlay', () => ({
  PlayerOverlay: (props: { onPanel(kind: string): void }) => {
    mockProps.overlay = props;
    return null;
  },
}));
jest.mock('@/screens/player/up-next', () => ({
  ...jest.requireActual('@/screens/player/up-next'),
  useNextEpisode: () => mockNext.current,
  EndCard: () => null,
}));
jest.mock('@/screens/player/player-tv-back', () => ({
  ...jest.requireActual('@/screens/player/player-tv-back'),
  usePlayerBack: () => undefined,
  leavePlayer: () => mockRouter.back(),
}));

const running: PlayerStatus = { spinner: false, hint: null, actions: [] };

async function open() {
  await renderWithProviders(<PlayScreen />);
  await act(async () => undefined);
  return MockPlayer.all.at(-1)!;
}

const change = (c: MockPlayer, over: Partial<MockPlayer>) => act(async () => c.update(over));

const failed = (over: object = {}) => ({
  phase: 'failed',
  failure: { code: 'playback_failed', category: 'T6', actions: ['retry'], tried: [], ...over },
});

beforeEach(async () => {
  MockPlayer.all = [];
  MockPlayer.throwOnCreate = false;
  mockCaps.mockImplementation(async () => ({ profile: {} }));
  mockClock.position = 0;
  mockClock.duration = 0;
  mockNext.current = null;
  mockWindow = undefined;
  mockAccount.mustChangePassword = false;
  mockRouter.replace.mockClear();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('PlayScreen cards, stepper and notices (verify V1 WEAK rows)', () => {
  row(
    'E01',
    'the start card shows the stepper with the explanation of the running step',
    async () => {
      const c = await open();
      await change(c, { states: ['queued', 'resolving'] });
      expect(screen.getByTestId('play-starting-card')).toBeOnTheScreen();
      expect(screen.getByTestId('play-step-resolving')).toBeOnTheScreen();
      expect(screen.getByTestId('play-step-explain')).toHaveTextContent(
        'Checking that every part of this version is available.'
      );
    }
  );

  row('E01', 'a failed start keeps the stepper on the card without the explanation', async () => {
    const c = await open();
    await change(c, { states: ['queued', 'resolving'], ...failed() });
    expect(screen.getByTestId('play-error-card')).toBeOnTheScreen();
    expect(screen.getByTestId('play-stepper')).toBeOnTheScreen();
    expect(screen.queryByTestId('play-step-explain')).toBeNull();
  });

  row('E02', 'a start state past its budget: the start card says why', async () => {
    const c = await open();
    await change(c, {
      states: ['planning'],
      status: {
        spinner: true,
        hint: { key: 'startSlow', params: { cause: 'preparing' } },
        actions: [],
      },
    });
    expect(screen.getByTestId('play-starting-startSlow')).toHaveTextContent(
      /^Starting takes longer than usual\. \S/
    );
  });

  row('E02', 'a viewer switch that takes long: the switching card says why', async () => {
    const c = await open();
    await change(c, {
      phase: 'switching',
      states: ['planning'],
      status: {
        spinner: false,
        hint: { key: 'startSlow', params: { cause: 'converting' } },
        actions: [],
      },
    });
    expect(screen.getByTestId('play-switching')).toBeOnTheScreen();
    expect(screen.getByTestId('play-switching-startSlow')).toHaveTextContent(
      /Starting takes longer than usual/
    );
  });

  row('E07', 'the up-next countdown stands still while the playback is paused', async () => {
    jest.useFakeTimers();
    mockNext.current = { workId: 'tmdb-tv-1-s1e2', title: 'S1 E2', playTitle: 'Show S1 E2' };
    mockClock.duration = 600;
    mockClock.position = 590;
    const c = await open();
    await change(c, { phase: 'playing', status: running, paused: true });
    const countdown = () => screen.getByTestId('player-up-next-countdown');
    expect(countdown()).toHaveTextContent('Starts in 10 seconds');
    await act(async () => jest.advanceTimersByTime(5_000));
    expect(countdown()).toHaveTextContent('Starts in 10 seconds');
    await change(c, { paused: false });
    await act(async () => jest.advanceTimersByTime(3_000));
    expect(countdown()).toHaveTextContent('Starts in 7 seconds');
  });

  row(
    'E07',
    "VLC guesses 1:49:42 for a 3:00 MPEG-PS: up-next counts from the controller's 3:00, not from the guess (review 8 R29)",
    async () => {
      jest.useFakeTimers();
      mockNext.current = { workId: 'tmdb-tv-1-s1e2', title: 'S1 E2', playTitle: 'Show S1 E2' };
      mockClock.duration = 6582;
      mockClock.position = 170;
      const c = await open();
      await change(c, { phase: 'playing', status: running, duration: 180 });
      expect(screen.getByTestId('player-up-next-countdown')).toHaveTextContent(
        'Starts in 10 seconds'
      );
    }
  );

  row(
    'E09',
    'the card lists what was tried with the positions, and Retry resumes in place',
    async () => {
      const c = await open();
      const at = { at: 0, revision: 0, category: 'T6', code: 'server_error' };
      await change(c, {
        ...failed({
          tried: [
            { ...at, step: 'R', position: 754 },
            { ...at, step: 'N', position: 754 },
            { ...at, step: 'S', position: 754 },
          ],
        }),
      });
      expect(screen.getByTestId('play-error-tried')).toHaveTextContent(/What was tried/);
      expect(screen.getByTestId('play-error-tried-R')).toHaveTextContent(/^Reloaded at 12:34 · /);
      expect(screen.getByTestId('play-error-tried-N')).toHaveTextContent(/^Restarted at 12:34 · /);
      expect(screen.getByTestId('play-error-tried-S')).toHaveTextContent(/^Another way to play · /);
      await act(async () => fireEvent.press(screen.getByText('Try again')));
      expect(c.retry).toHaveBeenCalledTimes(1);
      // Resumed by the same controller at its last good position: no new start flow.
      expect(MockPlayer.all).toHaveLength(1);
    }
  );

  const pressSignIn = async () => {
    await act(async () => fireEvent.press(screen.getByText('Sign in again')));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  };

  row(
    'A07',
    'a password change due mid-play: the card\'s Sign in opens "Change password" for this account (review 7 M08)',
    async () => {
      mockAccount.mustChangePassword = true;
      const c = await open();
      await change(
        c,
        failed({ code: 'password_change_required', category: 'T3', actions: ['signIn'] })
      );
      await pressSignIn();
      expect(mockRouter.replace).toHaveBeenLastCalledWith({
        pathname: '/sign-in/change-password',
        params: { account: 'a1' },
      });
    }
  );

  row('A07', "a sign-out mid-play: the card's Sign in opens the profiles", async () => {
    const c = await open();
    await change(c, failed({ code: 'session_ended', category: 'T3', actions: ['signIn'] }));
    await pressSignIn();
    expect(mockRouter.replace).toHaveBeenLastCalledWith('/profiles');
  });

  row('E09', 'nothing tried (a start refused at once): no "What was tried"', async () => {
    const c = await open();
    await change(c, failed());
    expect(screen.queryByTestId('play-error-tried')).toBeNull();
  });

  row('E10', 'an open panel and the version picker close when the playback fails', async () => {
    const c = await open();
    await change(c, {
      phase: 'playing',
      status: { spinner: true, hint: { key: 'buffering' }, actions: ['otherVersion'] },
    });
    await act(async () => fireEvent.press(screen.getByTestId('player-status-action-otherVersion')));
    await act(async () => mockProps.overlay?.onPanel('audio'));
    expect(mockProps.picker?.open).toBe(true);
    expect(mockProps.panels?.panel).toBe('audio');
    await change(c, failed());
    expect(screen.getByTestId('play-error-card')).toBeOnTheScreen();
    expect(mockProps.panels?.panel).toBeNull();
    expect(mockProps.picker?.open).toBe(false);
  });

  row('E11', 'a notice goes after 6 s on touch', async () => {
    jest.useFakeTimers();
    const c = await open();
    await change(c, { phase: 'playing', status: running, notice: { kind: 'otherTab', id: 1 } });
    await act(async () => jest.advanceTimersByTime(5_900));
    expect(c.dismissNotice).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(200));
    expect(c.dismissNotice).toHaveBeenCalledTimes(1);
  });

  row('E11', 'a notice stays 8 s on TV', async () => {
    jest.useFakeTimers();
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const c = await open();
    await change(c, { phase: 'playing', status: running, notice: { kind: 'otherTab', id: 1 } });
    await act(async () => jest.advanceTimersByTime(7_900));
    expect(c.dismissNotice).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(200));
    expect(c.dismissNotice).toHaveBeenCalledTimes(1);
  });

  row(
    'E16',
    'capabilities that fail to load: the player starts with the conservative profile',
    async () => {
      mockCaps.mockImplementation(async () => {
        throw new Error('MediaCodecList unavailable');
      });
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const c = await open();
      expect(c.options.profile).toMatchObject({
        engines: [
          expect.objectContaining({ videoCodecs: [expect.objectContaining({ codec: 'h264' })] }),
        ],
      });
      expect(c.start).toHaveBeenCalled();
      expect(screen.queryByTestId('play-error-card')).toBeNull();
    }
  );

  row(
    'E16',
    'a player that cannot be created: its own card, never "Something went wrong"',
    async () => {
      MockPlayer.throwOnCreate = true;
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      await open();
      expect(screen.getByTestId('play-error-card')).toBeOnTheScreen();
      expect(screen.getByText('The player hit an internal error')).toBeOnTheScreen();
      expect(screen.queryByText('Something went wrong')).toBeNull();
      expect(screen.getByText(/player_internal_error/)).toBeOnTheScreen();
    }
  );

  row(
    'A15',
    'picture-in-picture hides the notices and the status layer; leaving it shows them again',
    async () => {
      const c = await open();
      await change(c, {
        phase: 'playing',
        status: { spinner: true, hint: { key: 'buffering' }, actions: [] },
        notice: { kind: 'otherTab', id: 1 },
      });
      expect(screen.getByTestId('player-notice-otherTab')).toBeOnTheScreen();
      expect(screen.getByTestId('player-status')).toBeOnTheScreen();
      await change(c, { pictureInPicture: true });
      expect(screen.queryByTestId('player-notice-otherTab')).toBeNull();
      expect(screen.queryByTestId('player-status')).toBeNull();
      await change(c, { pictureInPicture: false });
      expect(screen.getByTestId('player-notice-otherTab')).toBeOnTheScreen();
    }
  );

  it.each([
    ['iPad landscape', 1180, 820],
    ['iPad portrait', 820, 1180],
  ])(
    "E06 %s: the paused hint starts below the header's title line, never over it (V2 turn 3)",
    async (_name, width, height) => {
      mockWindow = { width, height, scale: 2, fontScale: 1 };
      const c = await open();
      await change(c, {
        phase: 'playing',
        paused: true,
        status: {
          spinner: false,
          hint: { key: 'pausedBySystem', params: { cause: 'pipClosed' } },
          actions: ['resume'],
        },
      });
      await act(async () =>
        (
          mockProps.overlay as unknown as { onVisibleChange(visible: boolean): void }
        ).onVisibleChange(true)
      );
      const style = StyleSheet.flatten(screen.getByTestId('player-status').props.style);
      // The overlay's large header: top max(inset, s(64)), a 64 pt button row, 14 gap, a 68 pt title line.
      const s = (value: number) => value * Math.max(0.6, width / 1920);
      expect(style.paddingTop).toBeGreaterThanOrEqual(s(64) + s(64) + s(14) + s(68));
    }
  );

  it.each([
    ['iPhone landscape', 844, 390, 2],
    ['iPhone portrait', 390, 844, 4],
    ['iPad landscape', 1180, 820, 4],
    ['TV', 1920, 1080, 4],
  ])(
    'E09 %s: the failure card fits — on a short window the last two steps of "What was tried" and a "show all" (V2)',
    async (_name, width, height, lines) => {
      mockWindow = { width, height, scale: 2, fontScale: 1 };
      const c = await open();
      const at = { at: 0, revision: 0, category: 'T6', code: 'server_error' };
      await change(c, {
        ...failed({
          tried: [
            { ...at, step: 'R', position: 754 },
            { ...at, step: 'N', position: 754 },
            { ...at, step: 'S', position: 754 },
            { ...at, step: 'V', position: 754 },
          ],
        }),
      });
      const shown = () => screen.getByTestId('play-error-tried').children.length;
      expect(screen.queryAllByTestId(/^play-error-tried-[RNSV]$/)).toHaveLength(lines);
      if (lines === 4) {
        expect(screen.queryByTestId('play-error-tried-more')).toBeNull();
        return;
      }
      expect(screen.getByTestId('play-error-tried-V')).toBeOnTheScreen();
      expect(screen.queryByTestId('play-error-tried-R')).toBeNull();
      expect(screen.getByTestId('play-error-tried-more')).toHaveTextContent('Show 2 more');
      expect(shown()).toBeGreaterThan(0);
      await act(async () => fireEvent.press(screen.getByTestId('play-error-tried-more')));
      expect(screen.queryAllByTestId(/^play-error-tried-[RNSV]$/)).toHaveLength(4);
      expect(screen.queryByTestId('play-error-tried-more')).toBeNull();
    }
  );

  row('B07', 'the failure card says why the server cannot convert (reason line)', async () => {
    const c = await open();
    await change(
      c,
      failed({ code: 'transcoding_unavailable', params: { reason: 'ffmpeg_unavailable' } })
    );
    expect(screen.getByTestId('play-error-reason')).toHaveTextContent(
      'The server’s video converter isn’t installed.'
    );
  });

  row(
    'B10',
    'an unknown params.reason shows its code on the card; none shows no reason line',
    async () => {
      const c = await open();
      await change(c, failed({ params: { reason: 'start_timeout' } }));
      expect(screen.getByTestId('play-error-reason')).toHaveTextContent('Reason: start_timeout');
      await change(c, failed());
      expect(screen.queryByTestId('play-error-reason')).toBeNull();
    }
  );
});
