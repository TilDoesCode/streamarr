import { fireEvent } from '@testing-library/react-native';
import { act, screen, waitFor } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { writePerformancePreference } from '@/performance';

import { clearWorld, json, open, resetWorld, WAIT, world } from '../../../../jest/mylist-world';

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

// RN's Jest mock of the native View lacks Commands; TVFocusGuideView sends setDestinations on TV.
jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));

// Google TV's 960 × 540 dp canvas.
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 960, height: 540, scale: 2, fontScale: 1 }),
}));

const movie = (tmdbId: number, title: string) => ({
  workId: `tmdb-movie-${tmdbId}`,
  mediaType: 'movie',
  tmdbId,
  title,
});
const ROWS = [
  {
    id: 'trending-movies',
    kind: 'trending',
    mediaType: 'movie',
    items: [movie(1, 'Sintel'), movie(2, 'Tears of Steel'), movie(3, 'Big Buck Bunny')],
  },
  { id: 'popular-movies', kind: 'popular', mediaType: 'movie', items: [movie(4, 'Wing It')] },
];
const STATUS = '/api/v1/viewer/diagnostics/status';

const sleep = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
const heroTitle = () =>
  screen.getByTestId(/^home-lite-hero-(?!copy$)/).props.accessibilityLabel as string;
const rowOrder = () => screen.getAllByTestId(/^home-row-/).map((row) => row.props.testID as string);
const focusCard = (testID: string) =>
  act(async () => {
    fireEvent(screen.getByTestId(testID), 'focus', {});
  });

beforeEach(async () => {
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  writePerformancePreference('on');
  await resetWorld();
  world.handlers['/api/v1/viewer/catalog/discover'] = () => json(200, { rows: ROWS });
});
afterEach(() => {
  clearWorld();
  writePerformancePreference('auto');
  jest.restoreAllMocks();
});

describe('lite Home (TV)', () => {
  it('keeps its rows in place and changes the banner only after focus rested', async () => {
    await open('/');
    await screen.findByTestId('home-lite-hero', {}, WAIT);
    await waitFor(() => expect(heroTitle()).toBe('Sintel'), WAIT);
    const order = rowOrder();
    expect(order).toEqual(['home-row-trending-movies', 'home-row-popular-movies']);

    // Quick presses (100 ms apart): the banner keeps its title the whole time.
    await focusCard('home-card-trending-movies-1');
    await sleep(100);
    await focusCard('home-card-trending-movies-2');
    await sleep(100);
    await focusCard('home-card-popular-movies-0');
    await sleep(300);
    expect(heroTitle()).toBe('Sintel');
    expect(rowOrder()).toEqual(order);

    // Focus rests: one change, to the card focus rests on.
    await sleep(150);
    expect(heroTitle()).toBe('Wing It');
    expect(rowOrder()).toEqual(order);
  });

  it('shows the service status banner and the My List tab', async () => {
    world.handlers[STATUS] = () =>
      json(200, {
        state: 'down',
        categories: [
          { id: 'usenet', state: 'down', since: '2026-10-24T12:05:00Z', affected: 2, total: 2 },
        ],
        impacts: ['playbackUnavailable'],
        since: '2026-10-24T12:05:00Z',
        checkedAt: '2026-10-24T12:08:00Z',
        adminNotified: false,
      });
    await open('/');
    await screen.findByTestId('home-lite-hero', {}, WAIT);
    expect(await screen.findByTestId('service-status-banner', {}, WAIT)).toBeOnTheScreen();
    expect(screen.getByTestId('nav-mylist')).toBeOnTheScreen();
  });
});
