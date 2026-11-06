import { act, fireEvent, screen } from '@testing-library/react-native';
import { BackHandler, Platform } from 'react-native';

import { focusTopLayer } from '@/components/focus/focus-layer';
import type { DownloadRequestItem, DownloadsSupport, OfflineDownload } from '@/downloads';
import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';

import { DownloadSheetScreen } from '../download-sheet-screen';

// Regressions of DL-C-verify1 (C1-09, C1-10, C1-11, C1-16, C1-20, C1-25), promoted from its sheet reproductions.

const mockRouter = { back: jest.fn(), navigate: jest.fn(), push: jest.fn() };
let mockAvailable = 10_000;
let mockWorkId = 'tmdb-movie-603';
let mockPacks: { id: string; episodes: number[]; size: number; perEpisode: number }[] = [];
let mockEpisodeSizes: Record<number, number[]> = { 1: [6000], 2: [1000] };
let mockStreamOnly: Record<number, number> = {};
let mockExisting: (Pick<OfflineDownload, 'workId' | 'state'> & {
  error?: OfflineDownload['error'];
})[] = [];
let mockSupport: DownloadsSupport = { supported: true, reason: null };
let mockSingleEmpty = false;
const mockStart = jest.fn(async (items: DownloadRequestItem[]) => items.map(() => ({})));
const mockPlan = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ workId: mockWorkId }),
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
jest.mock('@/downloads', () => {
  const actual = jest.requireActual('@/downloads');
  const candidate = (id: string, sizeBytes: number) => ({
    version: { releaseId: id, name: id, rank: 1 },
    offline: { playable: true, engine: 'native', reasons: [] },
    recommended: true,
    sizeBytes,
    sizeExact: true,
    sizeSource: 'resolved',
    seasonPack: false,
    space: actual.spaceVerdict(sizeBytes, mockAvailable),
  });
  const query = { error: null, refetch: jest.fn() };
  return {
    ...actual,
    useDownloadsSupported: () => mockSupport,
    useDownloadSpace: () => ({
      availableBytes: mockAvailable,
      verdict: (bytes: number, estimate: boolean) =>
        actual.spaceVerdict(bytes, mockAvailable, estimate),
    }),
    useDownloadActions: () => ({ start: mockStart }),
    useDownloadFor: () => ({ download: null, state: null }),
    useSeasonDownloads: () => ({ items: mockExisting }),
    useDownloadCandidates: () => ({
      query,
      data: mockSingleEmpty
        ? { downloadable: [], streamOnlyCount: 2 }
        : { downloadable: [candidate('r1', 2000), candidate('r2', 3000)], streamOnlyCount: 0 },
    }),
    useSeasonDownloadCandidates: () => ({
      query,
      data: {
        seasonNumber: 1,
        packs: mockPacks.map((pack) => ({
          ...candidate(pack.id, pack.size),
          sizeExact: false,
          episodes: pack.episodes,
          complete: pack.episodes.length === Object.keys(mockEpisodeSizes).length,
          packSizeBytes: pack.size,
          perEpisodeSizeBytes: pack.perEpisode,
        })),
        episodes: Object.entries(mockEpisodeSizes).map(([key, sizes]) => {
          const n = Number(key);
          return {
            workId: `tmdb-tv-5-s01e0${n}`,
            episodeNumber: n,
            title: `Episode ${n}`,
            aired: true,
            candidates: sizes.map((size, index) =>
              candidate(index ? `r${n}-${index}` : `r${n}`, size)
            ),
            streamOnlyCount: mockStreamOnly[n] ?? 0,
          };
        }),
      },
    }),
    useDownloadPlan: (anchor: unknown, ids: string[]) => {
      if (anchor) mockPlan(anchor, ids);
      return { query, data: anchor ? { items: [] } : undefined };
    },
  };
});

type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
let backHandlers: BackListener[] = [];
const pressBack = () => act(() => void backHandlers.at(-1)?.({} as never));
const press = (testID: string) => fireEvent.press(screen.getByTestId(testID));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockAvailable = 10_000;
  mockWorkId = 'tmdb-movie-603';
  mockPacks = [];
  mockEpisodeSizes = { 1: [6000], 2: [1000] };
  mockStreamOnly = {};
  mockExisting = [];
  mockSupport = { supported: true, reason: null };
  mockSingleEmpty = false;
  mockStart.mockClear();
  mockPlan.mockClear();
  backHandlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    backHandlers.push(handler);
    return { remove: () => void (backHandlers = backHandlers.filter((item) => item !== handler)) };
  });
});
afterEach(() => jest.restoreAllMocks());

describe('C1-09: the picked version is checked again', () => {
  it('blocks confirm once the explicitly picked version no longer fits, keeping it visible with the reason', async () => {
    const view = await renderWithProviders(<DownloadSheetScreen />);
    await press('download-candidate-1');
    expect(screen.getByTestId('download-candidate-1')).toBeChecked();
    mockAvailable = 1000;
    await act(() => view.rerender(<DownloadSheetScreen />));
    expect(screen.getByTestId('download-candidate-1')).toBeDisabled();
    expect(screen.getByTestId('download-candidate-1')).toBeChecked();
    expect(screen.getByTestId('download-confirm')).toBeDisabled();
    expect(screen.getByTestId('download-confirm-reason')).toHaveTextContent(
      'The chosen version no longer fits',
      { exact: false }
    );
    await press('download-confirm');
    expect(mockStart).not.toHaveBeenCalled();
  });
});

describe('C1-11: rest similar takes a usable anchor', () => {
  beforeEach(() => {
    mockWorkId = 'tmdb-tv-5-s01';
    mockAvailable = 3000;
  });

  it('defaults to the first episode whose version fits and asks the plan for the others', async () => {
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-mode-similar')).toBeChecked();
    expect(mockPlan).toHaveBeenCalledWith({ workId: 'tmdb-tv-5-s01e02', releaseId: 'r2' }, [
      'tmdb-tv-5-s01e01',
    ]);
    expect(screen.getByTestId('download-anchor')).toHaveTextContent('Similar to S1, E2', {
      exact: false,
    });
  });

  it('starts at the episode the viewer came from, then wraps around', async () => {
    mockWorkId = 'tmdb-tv-5-s01e03';
    mockEpisodeSizes = { 1: [500], 2: [9000], 3: [9000], 4: [700] };
    await renderWithProviders(<DownloadSheetScreen />);
    await press('download-scope-season');
    expect(mockPlan).toHaveBeenLastCalledWith(
      { workId: 'tmdb-tv-5-s01e04', releaseId: 'r4' },
      expect.any(Array)
    );
  });

  it('lets the viewer pick any episode and version as the anchor', async () => {
    mockAvailable = 10_000;
    mockEpisodeSizes = { 1: [1000, 1200], 2: [1000, 1500], 3: [1000] };
    await renderWithProviders(<DownloadSheetScreen />);
    expect(mockPlan).toHaveBeenLastCalledWith({ workId: 'tmdb-tv-5-s01e01', releaseId: 'r1' }, [
      'tmdb-tv-5-s01e02',
      'tmdb-tv-5-s01e03',
    ]);
    await press('download-anchor-episode');
    expect(screen.getByTestId('download-anchor-episode-2-detail')).toHaveTextContent('r2', {
      exact: false,
    });
    await press('download-anchor-episode-2');
    await press('download-pick-1');
    expect(mockPlan).toHaveBeenLastCalledWith({ workId: 'tmdb-tv-5-s01e02', releaseId: 'r2-1' }, [
      'tmdb-tv-5-s01e01',
      'tmdb-tv-5-s01e03',
    ]);
    expect(screen.getByTestId('download-anchor')).toHaveTextContent('Similar to S1, E2', {
      exact: false,
    });
  });

  it('says plainly when no episode has a version that fits', async () => {
    mockEpisodeSizes = { 1: [6000], 2: [7000] };
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-no-anchor')).toHaveTextContent('No episode fits', {
      exact: false,
    });
    expect(mockPlan).not.toHaveBeenCalled();
    await press('download-anchor-episode');
    expect(screen.getByTestId('download-anchor-episode-1-detail')).toHaveTextContent(
      'No version fits',
      { exact: false }
    );
  });

  it('Back from the episode list returns to the review', async () => {
    mockAvailable = 10_000;
    await renderWithProviders(<DownloadSheetScreen />);
    await press('download-anchor-episode');
    expect(screen.getByTestId('download-anchor-episode-1')).toBeOnTheScreen();
    await pressBack();
    expect(screen.queryByTestId('download-anchor-episode-1')).toBeNull();
    expect(screen.getByTestId('download-anchor')).toBeOnTheScreen();
  });
});

describe('C1-16: packs fit by what they would download now', () => {
  const GB = 1_000_000_000;
  beforeEach(() => {
    mockWorkId = 'tmdb-tv-5-s01';
    mockAvailable = 3 * GB;
    mockEpisodeSizes = { 1: [6 * GB], 2: [1 * GB] };
    mockPacks = [
      { id: 'pack-a', episodes: [1, 2], size: 4 * GB, perEpisode: 2 * GB },
      { id: 'pack-b', episodes: [1, 2], size: 4 * GB, perEpisode: 2 * GB },
    ];
  });

  it('another pack becomes selectable once the kept episodes fit, with whole and selected sizes', async () => {
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-mode-pack')).toBeChecked();
    expect(screen.getByTestId('download-pack-1')).toBeDisabled();
    expect(screen.getByTestId('download-pack-0-line')).toHaveTextContent(
      'Whole pack about 4 GB · selected about 4 GB',
      { exact: false }
    );
    await press('review-1-toggle');
    expect(screen.getByTestId('download-confirm')).toBeEnabled();
    expect(screen.getByTestId('download-pack-1')).toBeEnabled();
    expect(screen.getByTestId('download-pack-1-line')).toHaveTextContent(
      'Whole pack about 4 GB · selected about 2 GB',
      { exact: false }
    );
    await press('download-pack-1');
    await press('download-confirm');
    expect(mockStart).toHaveBeenCalledWith([
      expect.objectContaining({ workId: 'tmdb-tv-5-s01e02', releaseId: 'pack-b' }),
    ]);
  });

  it('episodes already on the device do not count against a pack', async () => {
    mockExisting = [{ workId: 'tmdb-tv-5-s01e01', state: 'done' }];
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-pack-0')).toBeEnabled();
    expect(screen.getByTestId('download-confirm')).toBeEnabled();
  });

  it('names a non-contiguous pack by its episodes', async () => {
    mockEpisodeSizes = { 1: [100], 2: [100], 3: [100], 4: [100], 5: [100] };
    mockPacks = [{ id: 'pack-odd', episodes: [5, 1, 3], size: 900, perEpisode: 300 }];
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-pack-0-line-episodes')).toHaveTextContent(
      'Episodes 1, 3, 5 (3)'
    );
    expect(screen.queryByTestId('review-2')).toBeNull();
    expect(screen.getByTestId('review-3')).toBeOnTheScreen();
  });
});

describe('C1-20: versions that need converting are named in every picker', () => {
  it('the row and anchor pickers end with the stream-only line', async () => {
    mockWorkId = 'tmdb-tv-5-s01';
    mockEpisodeSizes = { 1: [1000], 2: [1000] };
    mockStreamOnly = { 1: 2, 2: 1 };
    await renderWithProviders(<DownloadSheetScreen />);
    await press('download-anchor-card');
    expect(screen.getByTestId('download-stream-only')).toHaveTextContent(
      '2 more versions would need converting – stream only',
      { exact: false }
    );
    await pressBack();
    await press('download-mode-each');
    await press('review-2-change');
    expect(screen.getByTestId('download-stream-only')).toHaveTextContent(
      '1 more version would need converting – stream only',
      { exact: false }
    );
  });
});

describe('C1-10: a failed episode of a season can be downloaded again', () => {
  it('is selected with its reason and can change its version', async () => {
    mockWorkId = 'tmdb-tv-5-s01';
    mockEpisodeSizes = { 1: [1000, 900], 2: [1000] };
    mockExisting = [
      {
        workId: 'tmdb-tv-5-s01e01',
        state: 'failed',
        error: { code: 'release_dead', actions: ['otherVersion'], at: 0 },
      },
    ];
    await renderWithProviders(<DownloadSheetScreen />);
    await press('download-mode-each');
    expect(screen.getByTestId('review-1-toggle')).toBeChecked();
    expect(screen.getByTestId('review-1-detail')).toHaveTextContent('Failed before:', {
      exact: false,
    });
    expect(screen.getByTestId('review-1-change')).toBeOnTheScreen();
  });
});

describe('C1-25: focus inside the panel', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  });

  it('the TV panel traps focus on every side and hides the focus look of the page under it', async () => {
    const view = await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-sheet-trap')).toHaveProp('trapFocusUp', true);
    expect(screen.getByTestId('download-sheet-trap')).toHaveProp('trapFocusDown', true);
    expect(screen.getByTestId('download-sheet-trap')).toHaveProp('trapFocusLeft', true);
    expect(screen.getByTestId('download-sheet-trap')).toHaveProp('trapFocusRight', true);
    expect(focusTopLayer().get()).toBe(1);
    await act(() => view.unmount());
    expect(focusTopLayer().get()).toBe(0);
  });

  it('a card that does not fit stays reachable by the D-pad but cannot be picked', async () => {
    mockAvailable = 2500;
    await renderWithProviders(<DownloadSheetScreen />);
    const blocked = screen.getByTestId('download-candidate-1');
    expect(blocked).toHaveProp('focusable', true);
    await press('download-candidate-1');
    expect(screen.getByTestId('download-candidate-0')).toBeChecked();
  });

  it.each([
    ['permission off', () => (mockSupport = { supported: false, reason: 'permission' })],
    ['nothing downloadable', () => (mockSingleEmpty = true)],
  ])('%s: Close takes the first focus', async (_, setup) => {
    setup();
    await renderWithProviders(<DownloadSheetScreen />);
    expect(screen.getByTestId('download-close')).toHaveProp('hasTVPreferredFocus', true);
  });

  it('a held or unavailable first row is skipped for the first focus', async () => {
    mockWorkId = 'tmdb-tv-5-s01';
    mockEpisodeSizes = { 1: [1000], 2: [1000], 3: [1000] };
    mockExisting = [{ workId: 'tmdb-tv-5-s01e01', state: 'done' }];
    await renderWithProviders(<DownloadSheetScreen />);
    await press('download-mode-each');
    expect(screen.queryByTestId('review-1-change')).toBeNull();
    expect(screen.getByTestId('review-1-toggle')).toBeDisabled();
    expect(screen.getByTestId('review-2-change')).toBeOnTheScreen();
  });
});
