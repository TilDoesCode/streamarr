import { act, fireEvent, screen } from '@testing-library/react-native';

import '@/i18n';
import { renderWithProviders } from '@/../jest/render';
import type { PlayerStatus } from '@/player/recovery/status';
import { PlayScreen } from '@/screens/player/play-screen';

/** The controller the screen creates: only what the screen reads, driven by the test. */
class MockPlayer {
  static last: MockPlayer;
  phase = 'playing';
  paused = false;
  ended = false;
  pictureInPicture = false;
  notice: object | null = null;
  failure = null;
  states: string[] = [];
  resumeSeconds = 0;
  playback: object | null = null;
  engine = null;
  status: PlayerStatus = { spinner: false, hint: null, actions: [] };
  private version = 0;
  private listeners = new Set<() => void>();
  constructor() {
    MockPlayer.last = this;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getVersion = () => this.version;
  set(status: PlayerStatus) {
    this.status = status;
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }
  start = jest.fn(async () => undefined);
  stop = jest.fn(async () => undefined);
  dismissNotice = jest.fn();
  setPaused = jest.fn();
  yieldToOtherTab = jest.fn();
  endSession = jest.fn();
  selectSubtitle = jest.fn(async () => undefined);
  notify() {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }
}

const mockBack: { current: (() => boolean) | null } = { current: null };
const mockRouter = { back: jest.fn(), replace: jest.fn(), canGoBack: () => true };

jest.mock('@/player/controller', () => ({
  PlaybackController: function MockController() {
    return new MockPlayer();
  },
}));
jest.mock('@/player/engines', () => ({
  nativeCandidates: () => ['web'],
  vlcAvailable: () => false,
}));
jest.mock('@/player/device-profile', () => ({ loadDeviceCaps: async () => ({}) }));
jest.mock('@/player/caps-fallback', () => ({
  createPlayer: async (_load: unknown, make: (profile: object) => unknown) => make({}),
}));
jest.mock('@/accounts/accounts-provider', () => ({
  useActiveAccount: () => ({
    account: { id: 'a1', serverUrl: 'http://dev.test', signedIn: true },
    client: {},
  }),
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
jest.mock('@/browse/version-picker', () => ({ VersionPicker: () => null }));
jest.mock('@/screens/player/player-panels', () => ({ PlayerPanels: () => null }));
jest.mock('@/navigation/screen-title', () => ({ useScreenTitle: () => undefined }));
jest.mock('@/screens/player/player-overlay', () => ({ PlayerOverlay: () => null }));
jest.mock('@/screens/player/up-next', () => ({
  useNextEpisode: () => null,
  EndCard: () => null,
  UpNextCard: () => null,
}));
jest.mock('@/screens/player/player-tv-back', () => ({
  ...jest.requireActual('@/screens/player/player-tv-back'),
  usePlayerBack: (onBack: () => boolean) => void (mockBack.current = onBack),
  leavePlayer: () => mockRouter.back(),
}));

const stall: PlayerStatus = {
  spinner: true,
  hint: { key: 'buffering' },
  actions: ['lowerQuality'],
};
const running: PlayerStatus = { spinner: false, hint: null, actions: [] };

async function open() {
  await renderWithProviders(<PlayScreen />);
  await act(async () => undefined);
  return MockPlayer.last;
}

const back = async () => {
  await act(async () => void mockBack.current?.());
};

afterEach(() => jest.useRealTimers());

describe('PlayScreen: Back during a recovery hides its hint once (S4p, review B1)', () => {
  it('a hint dismissed in one stall shows again in the next stall', async () => {
    jest.useFakeTimers();
    const c = await open();
    await act(async () => c.set(stall));
    expect(screen.getByText(/Loading takes longer than usual/)).toBeOnTheScreen();
    await back();
    expect(screen.queryByText(/Loading takes longer than usual/)).toBeNull();
    expect(mockRouter.back).not.toHaveBeenCalled();
    // The picture runs again, minutes later the next stall: its hint is there again.
    await act(async () => c.set(running));
    await act(async () => jest.advanceTimersByTime(20 * 60_000));
    await act(async () => c.set(stall));
    expect(screen.getByText(/Loading takes longer than usual/)).toBeOnTheScreen();
  });

  it('a Back while the hint is already hidden leaves (it never "dismisses" nothing again)', async () => {
    jest.useFakeTimers();
    mockRouter.back.mockClear();
    const c = await open();
    await act(async () => c.set(stall));
    await back();
    await act(async () => jest.advanceTimersByTime(10_000));
    await back();
    await act(async () => jest.advanceTimersByTime(100));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('another cause during the same recovery shows its own hint', async () => {
    jest.useFakeTimers();
    const c = await open();
    await act(async () => c.set(stall));
    await back();
    await act(async () =>
      c.set({ spinner: true, hint: { key: 'reloading', params: { time: '0:30' } }, actions: [] })
    );
    expect(screen.getByText(/0:30/)).toBeOnTheScreen();
  });
});

describe('PlayScreen: subtitles kept off for this video offer the way back on (S4p R1)', () => {
  it('the notice of a second failure has "Turn subtitles on again"; it shows the track again', async () => {
    const c = await open();
    const track = { index: 3, language: 'de', deliveredAs: 'webvtt', selected: true };
    c.playback = { mediaInfo: { subtitleTracks: [track], audioTracks: [] } };
    c.notice = { kind: 'subtitleFailed', params: { index: '3', code: 'x', retry: '' }, id: 1 };
    await act(async () => c.notify());
    await act(async () => fireEvent.press(screen.getByTestId('player-notice-subtitles-on')));
    expect(c.selectSubtitle).toHaveBeenCalledWith(track);
    expect(c.dismissNotice).toHaveBeenCalled();
  });

  it('a first failure (retried later) has no such action', async () => {
    const c = await open();
    c.notice = { kind: 'subtitleFailed', params: { index: '3', code: 'x', retry: 'later' }, id: 1 };
    await act(async () => c.notify());
    expect(screen.queryByTestId('player-notice-subtitles-on')).toBeNull();
  });
});
