import { act } from '@testing-library/react-native';
import { Profiler } from 'react';
import { Platform } from 'react-native';

import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';
import type { PlayerStatus } from '@/player/recovery/status';
import { PlayScreen } from '@/screens/player/play-screen';

type Listener = (event: { type: string }) => void;

class FakeEngine {
  kind = 'expo-video';
  supportsPictureInPicture = false;
  supportsAirPlay = false;
  listeners = new Set<Listener>();
  snapshot = {
    state: 'buffering',
    position: 30,
    duration: 734,
    buffered: 31,
    tracks: { audio: [], subtitles: [], video: { height: 2160, width: 3840 } },
    stats: {},
  };
  Surface = () => null;
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
}

class MockPlayer {
  static last: MockPlayer;
  phase = 'switching';
  paused = false;
  ended = false;
  pictureInPicture = false;
  notice: object | null = { kind: 'stepDown', params: { height: '1080' }, id: 1 };
  failure = null;
  states = ['loading', 'buffering'];
  playback = {
    workId: 'tmdb-movie-1',
    method: 'transcode',
    engine: 'native',
    version: { releaseId: 'r1' },
    mediaInfo: {
      video: { height: 2160, width: 3840 },
      audioTracks: [{ index: 1, language: 'eng', codec: 'aac', channels: 2 }],
      subtitleTracks: [],
    },
  };
  preferences = { engine: 'auto', maxHeight: 1080 };
  engine = new FakeEngine();
  position = 30;
  duration = 734;
  status: PlayerStatus = {
    spinner: true,
    hint: { key: 'steppingDown' } as PlayerStatus['hint'],
    actions: [],
  };
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
  /** One controller change, as an engine event or the 1 s status tick reports it. */
  notify() {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }
  currentAudio = () => 1;
  currentSubtitle = () => null;
  renditionOf = () => undefined;
  start = jest.fn(async () => undefined);
  stop = jest.fn(async () => undefined);
  retry = jest.fn(() => true);
  dismissNotice = jest.fn();
  setPaused = jest.fn();
  togglePlay = jest.fn();
  seekBy = jest.fn();
  seekTo = jest.fn();
  yieldToOtherTab = jest.fn();
  endSession = jest.fn();
}

jest.mock('@/player/controller', () => ({
  PlaybackController: function MockController() {
    return new MockPlayer();
  },
}));
jest.mock('@/player/engines', () => ({
  nativeCandidates: () => ['expo-video'],
  vlcAvailable: () => true,
  ENGINE_LABELS: {},
}));
jest.mock('@/player/device-profile', () => ({ loadDeviceCaps: async () => ({}) }));
jest.mock('@/player/caps-fallback', () => ({
  createPlayer: async (_load: unknown, make: (profile: object) => unknown) => make({}),
}));
jest.mock('@modules/player-keys', () => ({
  playerKeysAvailable: true,
  setKeyCapture: jest.fn(),
  addKeyListener: () => ({ remove: () => undefined }),
}));
jest.mock('expo-video', () => ({ VideoAirPlayButton: () => null }));
jest.mock('@/accounts/accounts-provider', () => ({
  useActiveAccount: () => ({
    account: { id: 'a1', serverUrl: 'http://dev.test', signedIn: true },
    client: {},
  }),
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ playbackId: 'new', workId: 'tmdb-movie-1', title: 'Tears' }),
  useNavigation: () => ({ getState: () => ({ routes: [] }), dispatch: jest.fn() }),
  useRouter: () => ({ back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
}));
jest.mock('expo-router/react-navigation', () => ({
  ...jest.requireActual('expo-router/react-navigation'),
  usePreventRemove: () => undefined,
}));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
jest.mock('@/browse/queries', () => ({
  ...jest.requireActual('@/browse/queries'),
  invalidateWatchQueries: async () => undefined,
  useVersions: () => ({ data: undefined }),
}));
jest.mock('@/browse/version-picker', () => ({ VersionPicker: () => null }));
jest.mock('@/navigation/screen-title', () => ({ useScreenTitle: () => undefined }));
jest.mock('@/screens/player/player-overlay', () =>
  (process.env.LOOP_OFF ?? '').split(',').includes('overlay')
    ? { PlayerOverlay: () => null }
    : jest.requireActual('@/screens/player/player-overlay')
);
jest.mock('@/screens/player/player-panels', () =>
  (process.env.LOOP_OFF ?? '').split(',').includes('panels')
    ? { PlayerPanels: () => null }
    : jest.requireActual('@/screens/player/player-panels')
);
jest.mock('@/screens/player/player-status', () =>
  (process.env.LOOP_OFF ?? '').split(',').includes('status')
    ? { ...jest.requireActual('@/screens/player/player-status'), PlayerStatusView: () => null }
    : jest.requireActual('@/screens/player/player-status')
);
jest.mock('@/player/use-clock', () =>
  (process.env.LOOP_OFF ?? '').split(',').includes('clock')
    ? {
        usePlayerClock: () => ({
          clock: { position: 30, duration: 734, buffered: 31 },
          onVisibleChange: () => undefined,
        }),
      }
    : jest.requireActual('@/player/use-clock')
);
jest.mock('@/screens/player/up-next', () => ({
  useNextEpisode: () => null,
  EndCard: () => null,
  UpNextCard: () => null,
}));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => jest.restoreAllMocks());

async function mount() {
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  const counter = { commits: 0 };
  await renderWithProviders(
    <Profiler id="player" onRender={() => void (counter.commits += 1)}>
      <PlayScreen />
    </Profiler>
  );
  await act(async () => undefined);
  return { player: MockPlayer.last, counter };
}

describe('the player on a slow Android TV box in step-down recovery (0.17.0 release blocker)', () => {
  it('one controller change is one commit, never a follow-up render', async () => {
    const { player, counter } = await mount();
    const perNotify: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const before = counter.commits;
      await act(async () => player.notify());
      perNotify.push(counter.commits - before);
    }
    expect(perNotify).toEqual(perNotify.map(() => 1));
  });

  it('changes back to back with no scheduler turn in between never reach "Maximum update depth"', async () => {
    const { player } = await mount();
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnv = env.IS_REACT_ACT_ENVIRONMENT;
    // A busy box: only microtasks (sync renders) run between the changes, a deferred render never gets its turn.
    env.IS_REACT_ACT_ENVIRONMENT = false;
    let error: unknown = null;
    try {
      for (let i = 0; i < 80 && !error; i += 1) {
        try {
          player.notify();
        } catch (thrown) {
          error = thrown;
        }
        for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
      }
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = actEnv;
    }
    expect(error).toBeNull();
  });
});
