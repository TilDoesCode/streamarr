import { userEvent } from '@testing-library/react-native';
import { router as navigate } from 'expo-router';
import { act, screen, waitFor } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { redirectSystemPath } from '@/app/+native-intent';
import * as tvFocusModule from '@/components/focus/tv-focus';
import { deviceSettings } from '@/lib/storage';
import { AppTabs } from '@/navigation/app-tabs';
import { clearWorld, json, open, resetWorld, WAIT, world } from '@/../jest/downloads-ui-world';

// DL-C-verify1 C1-25: old and deep links through the phone's hidden-tab layout, and the TV focus return.
let mockWindow: { width: number; height: number; scale: number; fontScale: number } | undefined;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => {
  const actual = jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions');
  return { __esModule: true, default: () => mockWindow ?? actual.default() };
});
const PHONE = { width: 390, height: 844, scale: 3, fontScale: 1 };

// TV focus guides call the native view commands; the phone tests swap NativeTabs for the headless shell.
jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));
jest.mock('@/navigation/native-tabs-shell', () => ({
  NativeTabsShell: jest.requireActual('@/navigation/large-shell').LargeShell,
}));

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(async () => {
  await resetWorld();
  deviceSettings.remove('library.kind');
  world.handlers['/api/v1/viewer/catalog/genres'] = () => json(200, { genres: [] });
  world.handlers['/api/v1/viewer/catalog/library'] = () =>
    json(200, { items: [], page: 1, hasMore: false });
});
afterEach(() => {
  mockWindow = undefined;
  clearWorld();
  jest.restoreAllMocks();
});

describe('phone links', () => {
  beforeEach(() => {
    mockWindow = PHONE;
  });

  it('an old /series link opens the Library tab on Series', async () => {
    const { router } = await open('/series', { '(app)/(tabs)/_layout': AppTabs });
    await waitFor(() => expect(router.getPathname()).toBe('/movies'), WAIT);
    expect(router.getSearchParams()).toMatchObject({ kind: 'series' });
    expect(await screen.findByTestId('library-kind-series', {}, WAIT)).toBeChecked();
  });

  it('a series link and a nested season link open their screens', async () => {
    await open('/series/7');
    expect(await screen.findByTestId('series-screen-7', {}, WAIT)).toBeOnTheScreen();
    clearWorld();
    await resetWorld();
    await open('/series/7/season/1');
    expect(await screen.findByTestId('season-screen-7-1', {}, WAIT)).toBeOnTheScreen();
    expect(await screen.findByTestId('season-download', {}, WAIT)).toBeOnTheScreen();
  });

  it('a title opened from Settings does not land in the Downloads stack', async () => {
    const { router } = await open('/settings');
    await act(async () => navigate.navigate('/series/7'));
    await waitFor(() => expect(router.getPathname()).toBe('/series/7'), WAIT);
    expect(router.getSegments()[2]).toBe('(home)');
  });
});

describe('native intent', () => {
  it('names the Movies segment of a /movies link and leaves the rest to the router', () => {
    expect(redirectSystemPath({ path: 'streamarr://movies', initial: true })).toBe(
      '/movies?kind=movie'
    );
    expect(redirectSystemPath({ path: 'streamarr://series', initial: true })).toBe(
      'streamarr://series'
    );
    expect(redirectSystemPath({ path: 'streamarr://series/7/season/2', initial: true })).toBe(
      'streamarr://series/7/season/2'
    );
  });
});

describe('TV: focus returns to the Download button', () => {
  it('after the sheet closes, the button that opened it gets the focus again', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const focus = jest.spyOn(tvFocusModule, 'tvFocus');
    const { router } = await open('/movie/123');
    const button = await screen.findByTestId('movie-download', {}, WAIT);
    await userEvent.setup().press(button);
    await waitFor(() => expect(router.getPathname()).toBe('/download/tmdb-movie-123'), WAIT);
    focus.mockClear();
    await act(async () => navigate.back());
    await waitFor(() => expect(router.getPathname()).toBe('/movie/123'), WAIT);
    await waitFor(() => expect(focus).toHaveBeenCalled(), WAIT);
  });

  it('a sheet not opened from the button leaves the focus alone', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const focus = jest.spyOn(tvFocusModule, 'tvFocus');
    const { router } = await open('/movie/123');
    await screen.findByTestId('movie-download', {}, WAIT);
    await act(async () =>
      navigate.push({ pathname: '/download/[workId]', params: { workId: 'tmdb-movie-123' } })
    );
    await waitFor(() => expect(router.getPathname()).toBe('/download/tmdb-movie-123'), WAIT);
    focus.mockClear();
    await act(async () => navigate.back());
    await waitFor(() => expect(router.getPathname()).toBe('/movie/123'), WAIT);
    expect(focus).not.toHaveBeenCalled();
  });
});
