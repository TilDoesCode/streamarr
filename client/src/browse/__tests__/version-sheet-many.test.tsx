import { act, renderHook, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { Version } from '@/browse/queries';
import { PICKER_FIRST_BATCH, useProgressiveCount, VersionPicker } from '@/browse/version-picker';
import { VERSION_LIST_INITIAL, VersionSheetPanel } from '@/browse/version-sheet';
import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';

// A title with many releases (the ROCK 4D test run: the version sheet took long to open).
const MANY = 150;
const versions: Version[] = Array.from({ length: MANY }, (_, index) => ({
  rank: index + 1,
  qualityRank: index + 1,
  releaseId: `r${index + 1}`,
  name: `Many.Versions.2023.1080p.WEB-DL.DDP5.1.H.264-G${index + 1}`,
  resolution: '1080p',
  videoCodec: 'h264',
  audioCodec: 'eac3',
  languages: ['en'],
  sizeBytes: 4_000_000_000 + index * 150_000_000,
  recommended: index === 0,
  predictedMethod: 'direct',
  health: 'ready',
})) as Version[];

let mockList: Version[] = versions;
jest.mock('@/browse/queries', () => ({
  ...jest.requireActual('@/browse/queries'),
  useVersions: () => ({ data: { versions: mockList, incomplete: false }, refetch: jest.fn() }),
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

const mountedCards = () => screen.queryAllByTestId(/^version-\d+$/).length;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockList = versions;
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const panel = (current?: string) => (
  <VersionSheetPanel
    frame="tv"
    workId="tmdb-movie-507"
    title="Many Versions"
    currentReleaseId={current}
    onPlay={() => undefined}
    onClose={() => undefined}
  />
);

describe('version sheet with 150 versions (TV)', () => {
  it('mounts only the cards around the viewport, not all 150', async () => {
    await renderWithProviders(panel());
    const mounted = mountedCards();
    expect(mounted).toBeGreaterThanOrEqual(VERSION_LIST_INITIAL);
    expect(mounted).toBeLessThan(MANY / 3);
    expect(screen.getByTestId('version-sheet-entry')).toBeOnTheScreen();
  });

  it('keeps the TV conventions: item snapping, the focused card centred', async () => {
    await renderWithProviders(panel());
    expect(screen.getByTestId('version-sheet-list')).toHaveProp('snapToAlignment', 'item');
    expect(screen.getByTestId('version-1')).toHaveProp('scrollSnapAlign', 'center');
  });

  it('still mounts a last-played entry card far down the list', async () => {
    mockList = versions.map((version) => ({ ...version, recommended: false }));
    await renderWithProviders(panel('r40'));
    expect(screen.getByTestId('version-sheet-entry')).toBeOnTheScreen();
    expect(screen.getByTestId('version-40')).toBeOnTheScreen();
  });
});

describe('version picker (player sheet) with 150 versions', () => {
  it('opens with the first batch and adds the rest after the sheet slid in', async () => {
    jest.useFakeTimers();
    await renderWithProviders(
      <VersionPicker
        open
        inline
        onClose={() => undefined}
        workId="tmdb-movie-507"
        title="Many Versions"
        onPlay={() => undefined}
      />
    );
    expect(mountedCards()).toBe(PICKER_FIRST_BATCH);
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });
    expect(mountedCards()).toBe(MANY);
  }, 60_000);
});

describe('useProgressiveCount', () => {
  it('starts with the first batch, then doubles per frame up to the total', async () => {
    jest.useFakeTimers();
    const { result } = await renderHook(() => useProgressiveCount(40, 8));
    expect(result.current).toBe(8);
    await act(async () => jest.advanceTimersByTime(350));
    expect(result.current).toBe(16);
    await act(async () => jest.advanceTimersByTime(1_000));
    expect(result.current).toBe(40);
  });

  it('shows short lists at once', async () => {
    const { result } = await renderHook(() => useProgressiveCount(3, 8));
    expect(result.current).toBe(3);
  });
});
