import { userEvent, within } from '@testing-library/react-native';
import { act, fireEvent, screen, waitFor } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { clearWorld, open, resetWorld, WAIT, world } from '@/../jest/downloads-ui-world';
import { TEST_ACCOUNT_KEY } from '@/../jest/downloads';

jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const LOCKED = { code: 'age_restricted', at: 1 } as const;
const UNMOUNTED = { code: 'volume_unavailable', at: 1 } as const;
const episode = (n: number, patch: Record<string, unknown> = {}) => ({
  workId: `tmdb-tv-7-s01e0${n}`,
  meta: { title: `Episode ${n}`, seriesTitle: 'Sherlock' },
  ...patch,
});

afterEach(() => {
  clearWorld();
  jest.restoreAllMocks();
});

/** The series row's D-pad stops in render order, left to right (focusable host views only). */
const seriesStops = () => {
  const stops = within(screen.getByTestId('download-series-tmdb-tv-7'))
    .queryAllByTestId(/^download-series-tmdb-tv-7-(open|play|delete)$/)
    .filter((node) => node.props.focusable !== false)
    .map((node) => node.props.testID as string);
  return [...new Set(stops)];
};

describe('the series row plays only an episode this profile can play here', () => {
  it('a season mixing locked and playable episodes plays the playable one, also over a started locked one', async () => {
    await resetWorld([episode(1, { error: LOCKED }), episode(2)]);
    world.downloads!.store.setPosition(TEST_ACCOUNT_KEY, 'tmdb-tv-7-s01e01', {
      seconds: 600,
      durationSeconds: 1800,
      at: Date.now(),
      played: false,
    });
    const { router } = await open('/downloads');
    const row = await screen.findByTestId('download-series-tmdb-tv-7', {}, WAIT);
    expect(within(row).getByText(/Next: S1, E2/)).toBeOnTheScreen();
    await userEvent.setup().press(screen.getByTestId('download-series-tmdb-tv-7-play'));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams()).toMatchObject({ workId: 'tmdb-tv-7-s01e02' });
  });

  it.each([
    ['every episode is age-locked', [episode(1, { error: LOCKED }), episode(2, { error: LOCKED })]],
    [
      'its storage is not connected',
      [
        episode(1, { volumeId: 'volume-1234', error: UNMOUNTED }),
        episode(2, { volumeId: 'volume-1234', error: UNMOUNTED }),
      ],
    ],
  ])('%s: no Play and no next episode, expand and delete stay', async (_, seed) => {
    await resetWorld(seed);
    await open('/downloads');
    const row = await screen.findByTestId('download-series-tmdb-tv-7', {}, WAIT);
    expect(screen.queryByTestId('download-series-tmdb-tv-7-play')).toBeNull();
    expect(within(row).queryByText(/Next:|Continue:/)).toBeNull();
    expect(screen.getByTestId('download-series-tmdb-tv-7-delete')).toBeOnTheScreen();
    await act(async () => fireEvent.press(screen.getByTestId('download-series-tmdb-tv-7-open')));
    expect(await screen.findByTestId('download-season-tmdb-tv-7-s01', {}, WAIT)).toBeOnTheScreen();
    expect(screen.queryByTestId('download-tmdb-tv-7-s01e01-open')).toBeNull();
  });

  it('TV: focus moves from the series row straight to Delete when nothing can play', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    await resetWorld([episode(1, { error: LOCKED }), episode(2, { error: LOCKED })]);
    await open('/downloads');
    await screen.findByTestId('download-series-tmdb-tv-7', {}, WAIT);
    expect(seriesStops()).toEqual([
      'download-series-tmdb-tv-7-open',
      'download-series-tmdb-tv-7-delete',
    ]);
  });

  it('TV: one playable episode keeps Play between the row and Delete', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    await resetWorld([episode(1, { error: LOCKED }), episode(2)]);
    await open('/downloads');
    await screen.findByTestId('download-series-tmdb-tv-7', {}, WAIT);
    expect(seriesStops()).toEqual([
      'download-series-tmdb-tv-7-open',
      'download-series-tmdb-tv-7-play',
      'download-series-tmdb-tv-7-delete',
    ]);
  });

  // DL-C verify 2 (C2-09), the verifier's repro as a regular test.
  it('C2-09: a series with every episode locked offers no no-op TV Play control', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    await resetWorld([
      {
        workId: 'tmdb-tv-7-s01e01',
        meta: { title: 'Adult episode', seriesTitle: 'Sherlock', minimumAge: 18, rated: true },
        error: { code: 'age_restricted', at: 1 },
      },
    ]);
    const { router } = await open('/downloads');
    await screen.findByTestId('download-series-tmdb-tv-7', {}, WAIT);
    expect(screen.queryByTestId('download-series-tmdb-tv-7-play')).toBeNull();
    expect(router.getPathname()).toBe('/downloads');
    expect(world.downloads!.store.all()).toHaveLength(1);
  });
});
