import { act, fireEvent, screen } from '@testing-library/react-native';
import { BackHandler, Platform } from 'react-native';

import type {
  CandidateWithSpace,
  DownloadCandidate,
  DownloadRequestItem,
  DownloadsSupport,
  PackWithSpace,
} from '@/downloads';
import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';

import { DownloadSheetScreen } from '../download-sheet-screen';

const GB = 1_000_000_000;
const { spaceVerdict } = jest.requireActual<typeof import('@/downloads')>('@/downloads');

let mockParams: Record<string, string> = {};
const mockRouter = { back: jest.fn(), navigate: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
}));
jest.mock('@/browse/queries', () => ({
  ...jest.requireActual('@/browse/queries'),
  useAudioLanguages: () => 'en',
}));
jest.mock('@modules/tv-native', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    tvNativeAvailable: true,
    TVFocusHost: (props: object) => <View {...props} />,
    setMenuMode: () => undefined,
    focusView: () => null,
  };
});

jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));

let mockAvailable = 10 * GB;
let mockSupport: DownloadsSupport = { supported: true, reason: null };
let mockSingle: { downloadable: CandidateWithSpace[]; streamOnlyCount: number } | undefined;
let mockSeason:
  | {
      seasonNumber: number;
      packs: PackWithSpace[];
      episodes: {
        workId: string;
        episodeNumber: number;
        title: string;
        aired: boolean;
        candidates: CandidateWithSpace[];
        streamOnlyCount: number;
      }[];
    }
  | undefined;
let mockPlanItems:
  | {
      workId: string;
      match: string;
      candidate: DownloadCandidate | null;
      notes?: { code: string; params?: Record<string, string> }[];
    }[]
  | undefined;
let mockSeasonItems: { workId: string; state: string }[] = [];
let mockOwn: { download: object | null; state: string | null } = { download: null, state: null };
const mockPlanCalls: unknown[] = [];
const mockStart = jest.fn(async (items: DownloadRequestItem[]) => items.map(() => ({})));

jest.mock('@/downloads', () => {
  const actual = jest.requireActual('@/downloads');
  const verdict = (bytes: number, estimate = false) =>
    actual.spaceVerdict(bytes, mockAvailable, estimate);
  const query = { error: null, refetch: jest.fn() };
  return {
    ...actual,
    useDownloadsSupported: () => mockSupport,
    useDownloadSpace: () => ({ availableBytes: mockAvailable, verdict }),
    useDownloadActions: () => ({ start: mockStart }),
    useDownloadFor: () => mockOwn,
    useSeasonDownloads: () => ({ items: mockSeasonItems }),
    useDownloadCandidates: (_workId: string, options: { enabled: boolean }) => ({
      query,
      data:
        options.enabled && mockSingle
          ? { ...mockSingle, candidates: mockSingle.downloadable }
          : undefined,
    }),
    useSeasonDownloadCandidates: (_workId: string, options: { enabled: boolean }) => ({
      query,
      data: options.enabled ? mockSeason : undefined,
    }),
    useDownloadPlan: (anchor: unknown, workIds: string[]) => {
      if (anchor) mockPlanCalls.push({ anchor, workIds });
      return {
        query,
        data: anchor && mockPlanItems ? { items: mockPlanItems } : undefined,
      };
    },
  };
});

function candidate(
  releaseId: string,
  patch: Partial<DownloadCandidate> & { name?: string } = {}
): CandidateWithSpace {
  const { name, ...rest } = patch;
  const base: DownloadCandidate = {
    version: {
      releaseId,
      rank: 1,
      name: name ?? `Show.S01.1080p.WEB.H264-${releaseId}`,
      resolution: '1080p',
      videoCodec: 'h264',
      audioCodec: 'eac3',
      languages: ['en'],
      releaseGroup: releaseId,
    } as DownloadCandidate['version'],
    offline: { playable: true, engine: 'native', reasons: [] },
    sizeBytes: 2 * GB,
    sizeExact: true,
    sizeSource: 'resolved',
    seasonPack: false,
    recommended: false,
    ...rest,
  };
  return { ...base, space: spaceVerdict(base.sizeBytes, mockAvailable, !base.sizeExact) };
}

const episodeOf = (n: number, candidates: CandidateWithSpace[]) => ({
  workId: `tmdb-tv-1396-s02e0${n}`,
  episodeNumber: n,
  title: `Episode ${n}`,
  aired: true,
  candidates,
  streamOnlyCount: 0,
});

type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
let backHandlers: BackListener[] = [];
const pressBack = () => act(() => void backHandlers.at(-1)?.({} as never));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockAvailable = 10 * GB;
  mockSupport = { supported: true, reason: null };
  mockSingle = undefined;
  mockSeason = undefined;
  mockPlanItems = undefined;
  mockSeasonItems = [];
  mockOwn = { download: null, state: null };
  mockPlanCalls.length = 0;
  mockStart.mockClear();
  mockRouter.back.mockClear();
  mockRouter.navigate.mockClear();
  backHandlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    backHandlers.push(handler);
    return { remove: () => void (backHandlers = backHandlers.filter((item) => item !== handler)) };
  });
});
afterEach(() => jest.restoreAllMocks());

const press = (testID: string) => fireEvent.press(screen.getByTestId(testID));

describe('download sheet: movie or episode', () => {
  beforeEach(() => {
    mockParams = { workId: 'tmdb-movie-603', title: 'The Matrix' };
  });

  it('lists the downloadable versions with the recommended one selected and starts it', async () => {
    mockSingle = {
      downloadable: [
        candidate('web', { recommended: true, sizeBytes: 1.4 * GB }),
        candidate('blu', {
          sizeBytes: 3.9 * GB,
          sizeExact: false,
          offline: {
            playable: true,
            engine: 'vlc',
            reasons: [{ code: 'image_subtitle_vlc', params: { codec: 'pgs' } }],
          },
        }),
        candidate('uhd', {
          sizeBytes: 3 * GB,
          offline: { playable: true, engine: 'vlc', reasons: [{ code: 'vlc_fallback' }] },
        }),
      ],
      streamOnlyCount: 2,
    };
    await renderWithProviders(<DownloadSheetScreen />);
    // VLC is how it plays offline, not a fault: a positive line instead of "the built-in player can't".
    expect(screen.getByTestId('download-candidate-2-note')).toHaveTextContent(
      'Plays on this device with VLC'
    );
    expect(screen.queryByText(/built-in player can/i)).toBeNull();
    expect(screen.getByTestId('download-sheet-subtitle')).toHaveTextContent('The Matrix', {
      exact: false,
    });
    expect(screen.getByTestId('download-candidate-0')).toBeChecked();
    expect(screen.getByTestId('download-candidate-1')).not.toBeChecked();
    expect(screen.getByTestId('download-candidate-1-engine')).toHaveTextContent('VLC', {
      exact: false,
    });
    expect(screen.getByTestId('download-candidate-1-size')).toHaveTextContent('about 3.9 GB', {
      exact: false,
    });
    expect(screen.getByTestId('download-candidate-1-note')).toHaveTextContent(/PGS subtitle/i);
    expect(screen.getByTestId('download-candidate-0-space')).toHaveTextContent(
      'Fits · 8.6 GB left',
      { exact: false }
    );
    expect(screen.getByTestId('download-stream-only')).toHaveTextContent(
      '2 more versions would need converting – stream only',
      { exact: false }
    );
    expect(screen.queryByTestId('download-scope')).toBeNull();
    await press('download-candidate-1');
    expect(screen.getByTestId('download-confirm')).toHaveTextContent('Download about 3.9 GB', {
      exact: false,
    });
    await press('download-confirm');
    expect(await screen.findByTestId('download-started')).toHaveTextContent('Download started', {
      exact: false,
    });
    expect(mockStart).toHaveBeenCalledWith([
      expect.objectContaining({
        workId: 'tmdb-movie-603',
        releaseId: 'blu',
        candidate: expect.objectContaining({ sizeBytes: 3.9 * GB }),
      }),
    ]);
    await press('download-open-downloads');
    expect(mockRouter.back).toHaveBeenCalled();
    expect(mockRouter.navigate).toHaveBeenCalledWith('/downloads');
  });

  it('keeps versions that do not fit listed, blocked with what is missing', async () => {
    mockAvailable = 2 * GB;
    mockSingle = {
      downloadable: [
        candidate('uhd', { recommended: true, sizeBytes: 9.2 * GB }),
        candidate('web', { sizeBytes: 1.5 * GB }),
      ],
      streamOnlyCount: 0,
    };
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-candidate-0')).toBeDisabled();
    expect(screen.getByTestId('download-candidate-0-space')).toHaveTextContent(
      'Doesn’t fit · 7.2 GB short',
      { exact: false }
    );
    // The first version that fits is selected instead of the recommended one.
    expect(screen.getByTestId('download-candidate-1')).toBeChecked();
    await press('download-candidate-0');
    expect(screen.getByTestId('download-candidate-1')).toBeChecked();
  });

  it('says so when nothing fits and blocks the button', async () => {
    mockAvailable = GB;
    mockSingle = {
      downloadable: [candidate('uhd', { recommended: true, sizeBytes: 9 * GB })],
      streamOnlyCount: 0,
    };
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-confirm')).toBeDisabled();
    expect(screen.getByTestId('download-confirm-reason')).toHaveTextContent(
      'No version fits into the free storage.',
      { exact: false }
    );
  });

  it('explains an empty list (every version needs converting)', async () => {
    mockSingle = { downloadable: [], streamOnlyCount: 3 };
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-empty')).toHaveTextContent(/No version plays as it is/);
    expect(screen.getByTestId('download-empty')).toHaveTextContent(/3 more versions/);
  });

  it('shows an existing download instead of the list', async () => {
    mockOwn = { download: { id: 'd1' }, state: 'done' };
    mockSingle = { downloadable: [candidate('web', { recommended: true })], streamOnlyCount: 0 };
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-already')).toHaveTextContent('Already on this device', {
      exact: false,
    });
    expect(screen.queryByTestId('download-candidate-0')).toBeNull();
  });

  it('replaces a failed download: says why, marks the failed version, takes the suggestion', async () => {
    mockOwn = {
      download: {
        id: 'd1',
        releaseId: 'web',
        state: 'failed',
        error: { code: 'not_direct_playable', params: { suggestedReleaseId: 'blu' } },
      },
      state: 'failed',
    };
    mockSingle = {
      downloadable: [candidate('web', { recommended: true }), candidate('hd'), candidate('blu')],
      streamOnlyCount: 0,
    };
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.queryByTestId('download-already')).toBeNull();
    expect(screen.getByTestId('download-failed')).toHaveTextContent('Pick another version', {
      exact: false,
    });
    expect(screen.getByTestId('download-candidate-0-failed')).toHaveTextContent('Failed before');
    expect(screen.getByTestId('download-candidate-2')).toBeChecked();
    await press('download-confirm');
    await screen.findByTestId('download-started');
    expect(mockStart).toHaveBeenCalledWith([expect.objectContaining({ releaseId: 'blu' })]);
  });

  it('a failed download without a suggestion takes the best other version', async () => {
    mockOwn = {
      download: {
        id: 'd1',
        releaseId: 'web',
        state: 'failed',
        error: { code: 'download_source_gone' },
      },
      state: 'failed',
    };
    mockSingle = {
      downloadable: [candidate('web', { recommended: true }), candidate('hd')],
      streamOnlyCount: 0,
    };
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-candidate-1')).toBeChecked();
  });

  it('explains when the admin turned downloads off', async () => {
    mockSupport = { supported: false, reason: 'permission' };
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-not-allowed')).toHaveTextContent(
      'The admin turned off downloads for your profile.',
      { exact: false }
    );
    await press('download-close');
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('says downloads do not exist on an unsupported device', async () => {
    mockSupport = { supported: false, reason: 'platform' };
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-unsupported')).toBeOnTheScreen();
  });

  it('is in German too', async () => {
    await act(() => i18n.changeLanguage('de'));
    mockSingle = {
      downloadable: [candidate('web', { recommended: true, sizeBytes: 1.4 * GB })],
      streamOnlyCount: 1,
    };
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-sheet-title')).toHaveTextContent('Herunterladen', {
      exact: false,
    });
    expect(screen.getByTestId('download-confirm')).toHaveTextContent('1,4 GB herunterladen', {
      exact: false,
    });
    expect(screen.getByTestId('download-candidate-0-engine')).toHaveTextContent('Direkt', {
      exact: false,
    });
    expect(screen.getByTestId('download-stream-only')).toHaveTextContent(
      '1 weitere Version bräuchte Umwandlung – nicht herunterladbar',
      { exact: false }
    );
    await act(() => i18n.changeLanguage('en'));
  });
});

describe('download sheet: a season', () => {
  const pack = (complete = true): PackWithSpace => ({
    version: {
      releaseId: 'pack',
      rank: 1,
      name: 'Sherlock.S02.1080p.BluRay-PACK',
      resolution: '1080p',
    } as PackWithSpace['version'],
    offline: { playable: true, engine: 'vlc', reasons: [] },
    episodes: [1, 2, 3],
    complete,
    packSizeBytes: 9 * GB,
    sizeBytes: 9 * GB,
    sizeExact: false,
    perEpisodeSizeBytes: 3 * GB,
    recommended: true,
    space: spaceVerdict(9 * GB, mockAvailable, true),
  });
  const seasonWith = (packs: PackWithSpace[]) => ({
    seasonNumber: 2,
    packs,
    episodes: [
      episodeOf(1, [candidate('a1', { recommended: true, sizeBytes: 1.4 * GB }), candidate('b1')]),
      episodeOf(2, [candidate('a2', { recommended: true, sizeBytes: 1.3 * GB }), candidate('b2')]),
      episodeOf(3, [candidate('a3', { recommended: true, sizeBytes: 2.1 * GB }), candidate('b3')]),
    ],
  });

  it('starts from an episode: "This episode" first, the switch opens the season', async () => {
    mockParams = { workId: 'tmdb-tv-1396-s02e02', title: 'Sherlock · S2, E2', series: 'Sherlock' };
    mockSingle = { downloadable: [candidate('a2', { recommended: true })], streamOnlyCount: 0 };
    mockSeason = seasonWith([]);
    mockPlanItems = [];
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-scope-single')).toBeChecked();
    expect(screen.getByTestId('download-candidate-0')).toBeOnTheScreen();
    await press('download-scope-season');
    expect(screen.getByTestId('download-sheet-subtitle')).toHaveTextContent('Sherlock', {
      exact: false,
    });
    expect(screen.getByTestId('download-sheet-subtitle')).toHaveTextContent('Season 2', {
      exact: false,
    });
    // Without a pack the season opens on "rest similar", anchored on the episode it started from.
    expect(screen.getByTestId('download-mode-similar')).toBeChecked();
    expect(screen.queryByTestId('download-mode-pack')).toBeNull();
    expect(mockPlanCalls.at(-1)).toEqual({
      anchor: { workId: 'tmdb-tv-1396-s02e02', releaseId: 'a2' },
      workIds: ['tmdb-tv-1396-s02e01', 'tmdb-tv-1396-s02e03'],
    });
  });

  it('season pack: completeness, deselect an episode, skip a downloaded one, start the pack per episode', async () => {
    mockParams = { workId: 'tmdb-tv-1396-s02', title: 'Sherlock · Season 2', series: 'Sherlock' };
    mockSeason = seasonWith([pack()]);
    mockSeasonItems = [
      { workId: 'tmdb-tv-1396-s02e03', state: 'done' },
      { workId: 'tmdb-tv-1396-s02e01', state: 'failed' },
    ];
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.queryByTestId('download-scope')).toBeNull();
    expect(screen.getByTestId('download-mode-pack')).toBeChecked();
    expect(screen.getByTestId('download-pack-0')).toHaveTextContent('3/3 episodes · complete', {
      exact: false,
    });
    expect(screen.getByTestId('review-3-detail')).toHaveTextContent('On this device', {
      exact: false,
    });
    expect(screen.getByTestId('review-3-toggle')).toBeDisabled();
    // A failed episode can be downloaded again (it replaces the failed one).
    expect(screen.getByTestId('review-1-toggle')).toBeChecked();
    expect(screen.getByTestId('review-1-detail')).toHaveTextContent('Failed before', {
      exact: false,
    });
    expect(screen.queryByTestId('review-1-change')).toBeNull();
    expect(screen.getByTestId('download-confirm-summary')).toHaveTextContent(
      '2 episodes · about 6 GB',
      { exact: false }
    );
    await press('review-1-toggle');
    expect(screen.getByTestId('review-1-toggle')).not.toBeChecked();
    expect(screen.getByTestId('download-confirm')).toHaveTextContent(
      '1 episode · download about 3 GB',
      { exact: false }
    );
    await press('download-confirm');
    await screen.findByTestId('download-started');
    expect(mockStart).toHaveBeenCalledWith([
      expect.objectContaining({
        workId: 'tmdb-tv-1396-s02e02',
        releaseId: 'pack',
        meta: { title: 'Episode 2', seriesTitle: 'Sherlock' },
      }),
    ]);
  });

  it('rest similar: match markers, change one row, deselect another, start the rest', async () => {
    mockParams = { workId: 'tmdb-tv-1396-s02', title: 'Sherlock · Season 2', series: 'Sherlock' };
    mockSeason = seasonWith([pack()]);
    mockPlanItems = [
      {
        workId: 'tmdb-tv-1396-s02e02',
        match: 'same_release',
        candidate: candidate('a2', { sizeBytes: 1.3 * GB }),
      },
      {
        workId: 'tmdb-tv-1396-s02e03',
        match: 'best_available',
        candidate: candidate('b3'),
        notes: [{ code: 'language_differs', params: { languages: 'de', anchorLanguages: 'en' } }],
      },
    ];
    await renderWithProviders(<DownloadSheetScreen />);
    await press('download-mode-similar');
    expect(screen.getByTestId('download-anchor')).toHaveTextContent(/Similar to S2, E1/);
    expect(screen.getByTestId('review-2-match')).toHaveTextContent('Same release', {
      exact: false,
    });
    expect(screen.getByTestId('review-3-match')).toHaveTextContent('Best available', {
      exact: false,
    });
    expect(screen.getByTestId('review-3-language')).toHaveTextContent('Different language: German');
    expect(screen.getByTestId('review-3-toggle').props.accessibilityLabel).toMatch(
      /Different language: German/
    );
    expect(screen.queryByTestId('review-2-language')).toBeNull();
    await press('review-3-change');
    expect(screen.getByTestId('download-pick-title')).toHaveTextContent('Version for S2, E3', {
      exact: false,
    });
    // Back steps back to the review without choosing.
    await pressBack();
    expect(screen.getByTestId('review-3-match')).toHaveTextContent('Best available', {
      exact: false,
    });
    await press('review-3-change');
    await press('download-pick-0');
    expect(screen.getByTestId('review-3-match')).toHaveTextContent('Your pick', { exact: false });
    expect(screen.queryByTestId('review-3-language')).toBeNull();
    expect(screen.getByTestId('review-3-detail')).toHaveTextContent(/2.1 GB/);
    await press('review-2-toggle');
    await press('download-confirm');
    await screen.findByTestId('download-started');
    expect(mockStart).toHaveBeenCalledWith([
      expect.objectContaining({ workId: 'tmdb-tv-1396-s02e01', releaseId: 'a1' }),
      expect.objectContaining({ workId: 'tmdb-tv-1396-s02e03', releaseId: 'a3' }),
    ]);
    expect(screen.getByTestId('download-started')).toHaveTextContent('2 downloads started', {
      exact: false,
    });
  });

  it('rest similar: another anchor version asks the plan again', async () => {
    mockParams = { workId: 'tmdb-tv-1396-s02', title: 'Sherlock · Season 2', series: 'Sherlock' };
    mockSeason = seasonWith([]);
    mockPlanItems = [];
    await renderWithProviders(<DownloadSheetScreen />);
    await press('download-anchor-card');
    await press('download-pick-1');
    expect(mockPlanCalls.at(-1)).toEqual({
      anchor: { workId: 'tmdb-tv-1396-s02e01', releaseId: 'b1' },
      workIds: ['tmdb-tv-1396-s02e02', 'tmdb-tv-1396-s02e03'],
    });
  });

  it('each yourself: prefilled with the recommended versions, every row changeable', async () => {
    mockParams = { workId: 'tmdb-tv-1396-s02', title: 'Sherlock · Season 2', series: 'Sherlock' };
    mockSeason = seasonWith([]);
    await renderWithProviders(<DownloadSheetScreen />);
    await press('download-mode-each');
    expect(screen.getByTestId('review-1-match')).toHaveTextContent('Recommended', { exact: false });
    expect(screen.getByTestId('download-confirm-summary')).toHaveTextContent(
      '3 episodes · 4.8 GB',
      { exact: false }
    );
    await press('review-2-change');
    await press('download-pick-1');
    expect(screen.getByTestId('review-2-match')).toHaveTextContent('Your pick', { exact: false });
    expect(screen.getByTestId('download-confirm-summary')).toHaveTextContent(
      '3 episodes · 5.5 GB',
      { exact: false }
    );
  });

  it('a pre-selected pack that does not fit stays selected but blocked, without a check mark', async () => {
    mockAvailable = 3 * GB;
    mockParams = { workId: 'tmdb-tv-1396-s02', title: 'Sherlock · Season 2', series: 'Sherlock' };
    mockSeason = seasonWith([pack()]);
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-mode-pack')).toBeChecked();
    expect(screen.getByTestId('download-pack-0')).toBeChecked();
    expect(screen.getByTestId('download-pack-0-mark-blocked')).toBeOnTheScreen();
    expect(screen.queryByTestId('download-pack-0-mark-checked')).toBeNull();
    expect(screen.getByTestId('download-confirm')).toBeDisabled();
    expect(screen.getByTestId('download-confirm-reason')).toHaveTextContent(
      'Deselect episodes or free up space',
      { exact: false }
    );
  });

  it('blocks a selection that does not fit and says what is missing', async () => {
    mockAvailable = 3 * GB;
    mockParams = { workId: 'tmdb-tv-1396-s02', title: 'Sherlock · Season 2', series: 'Sherlock' };
    mockSeason = seasonWith([]);
    await renderWithProviders(<DownloadSheetScreen />);
    await press('download-mode-each');
    expect(screen.getByTestId('download-confirm')).toBeDisabled();
    expect(screen.getByTestId('download-confirm-space')).toHaveTextContent(
      'Doesn’t fit · 1.8 GB short',
      { exact: false }
    );
    expect(screen.getByTestId('download-confirm-reason')).toHaveTextContent(
      'Needs 4.8 GB · 3 GB free. Deselect episodes or free up space.',
      { exact: false }
    );
    await press('review-3-toggle');
    expect(screen.getByTestId('download-confirm')).toBeEnabled();
  });

  it('lists an episode without a downloadable version as such', async () => {
    mockParams = { workId: 'tmdb-tv-1396-s02', title: 'Sherlock · Season 2', series: 'Sherlock' };
    mockSeason = {
      ...seasonWith([]),
      episodes: [
        episodeOf(1, [candidate('a1', { recommended: true })]),
        episodeOf(2, [candidate('x2', { offline: { playable: false, reasons: [] } })]),
      ],
    };
    await renderWithProviders(<DownloadSheetScreen />);
    await press('download-mode-each');
    expect(screen.getByTestId('review-2-detail')).toHaveTextContent('No downloadable version', {
      exact: false,
    });
    expect(screen.getByTestId('review-2-toggle')).toBeDisabled();
  });
});

describe('download sheet frames', () => {
  it('Android TV: a glass side panel (dialog) and Back closes the version list first', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    mockParams = { workId: 'tmdb-tv-1396-s02', title: 'Sherlock · Season 2', series: 'Sherlock' };
    mockSeason = {
      seasonNumber: 2,
      packs: [],
      episodes: [
        episodeOf(1, [candidate('a1', { recommended: true })]),
        episodeOf(2, [candidate('a2')]),
      ],
    };
    mockPlanItems = [
      { workId: 'tmdb-tv-1396-s02e02', match: 'same_variant', candidate: candidate('a2') },
    ];
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-sheet')).toHaveProp('role', 'dialog');
    await press('review-2-change');
    expect(screen.getByTestId('download-pick-title')).toBeOnTheScreen();
    await pressBack();
    expect(screen.queryByTestId('download-pick-title')).toBeNull();
    expect(screen.getByTestId('review-2-match')).toHaveTextContent('Same variant', {
      exact: false,
    });
  });
});
