import { act, fireEvent, screen } from '@testing-library/react-native';

import { Platform } from 'react-native';

import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';
import type { PlayerStatus } from '@/player/recovery/status';
import { PlayScreen } from '@/screens/player/play-screen';

/** The controller the screen creates: only what the screen reads, driven by the test. */
class MockPlayer {
  static last: MockPlayer;
  static options: { preferences?: object } | undefined;
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
  PlaybackController: function MockController(options: { preferences?: object }) {
    MockPlayer.options = options;
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
const mockPicker: { open?: boolean; onClose?: () => void } = {};
jest.mock('@/browse/version-picker', () => ({
  VersionPicker: (props: { open: boolean; onClose: () => void }) => {
    Object.assign(mockPicker, props);
    return null;
  },
}));
jest.mock('@/screens/player/player-panels', () => ({
  ...jest.requireActual('@/screens/player/player-panels'),
  PlayerPanels: () => null,
}));
jest.mock('@/navigation/screen-title', () => ({ useScreenTitle: () => undefined }));
const mockRefocus = jest.fn();
jest.mock('@/screens/player/player-overlay', () => ({
  PlayerOverlay: ({ refocusRef }: { refocusRef?: { current: unknown } }) => {
    if (refocusRef) refocusRef.current = (target?: string) => mockRefocus(target, mockPicker.open);
    return null;
  },
}));
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
  actions: ['otherVersion'],
};

// TV shows no hint buttons in the status view (the remote reaches them elsewhere): open the picker as a phone does.
async function pickerFromHint(tv: boolean) {
  const isTV = jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(false);
  await renderWithProviders(<PlayScreen />);
  await act(async () => undefined);
  await act(async () => MockPlayer.last.set(stall));
  await act(async () => fireEvent.press(screen.getByTestId('player-status-action-otherVersion')));
  expect(mockPicker.open).toBe(true);
  isTV.mockReturnValue(tv);
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => mockRefocus.mockClear());
afterEach(() => jest.restoreAllMocks());

describe("the hint's version picker on Android TV (same bug class as P1: focus fell to the seek bar)", () => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'android'));

  it('Back closes it with the version chip focused first, while the picker still exists', async () => {
    await pickerFromHint(true);
    await act(async () => void mockBack.current?.());
    expect(mockRefocus).toHaveBeenCalledWith('version', true);
    expect(mockPicker.open).toBe(false);
  });

  it("the picker's own close does the same", async () => {
    await pickerFromHint(true);
    await act(async () => mockPicker.onClose?.());
    expect(mockRefocus).toHaveBeenCalledWith('version', true);
    expect(mockPicker.open).toBe(false);
  });

  it('over the failure card the card takes focus back, so the overlay behind it is not refocused', async () => {
    await pickerFromHint(true);
    const player = MockPlayer.last;
    await act(async () => {
      player.phase = 'failed';
      player.notify();
    });
    await act(async () => mockPicker.onClose?.());
    expect(mockRefocus).not.toHaveBeenCalled();
  });
});

it('Modal platforms close the picker without the TV refocus', async () => {
  await pickerFromHint(false);
  await act(async () => void mockBack.current?.());
  expect(mockRefocus).not.toHaveBeenCalled();
  expect(mockPicker.open).toBe(false);
});
