import { userEvent } from '@testing-library/react-native';
import { router as navigate } from 'expo-router';
import { act, screen, waitFor } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { redirectSystemPath } from '@/app/+native-intent';
import * as tvFocusModule from '@/components/focus/tv-focus';
import { deviceSettings } from '@/lib/storage';
import { AppTabs } from '@/navigation/app-tabs';
import { routeFromUrl } from '@/navigation/title-link';
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

describe('the Downloads link (tap on the download notification)', () => {
  const LINK = 'streamarr://downloads';
  const TABS = { '(app)/(tabs)/_layout': AppTabs };
  const asTv = () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  };
  // As the running app does: the native intent first, then the router opens what it returns.
  const follow = async () => {
    const path = redirectSystemPath({ path: LINK, initial: false });
    expect(path).toBe(LINK);
    await act(async () => navigate.navigate(routeFromUrl(path!) as never));
  };

  it('resolves to the Downloads tab route, cold and warm', () => {
    expect(redirectSystemPath({ path: LINK, initial: true })).toBe(LINK);
    expect(routeFromUrl(LINK)).toBe('/downloads');
    expect(routeFromUrl('streamarr:///downloads')).toBe('/downloads');
  });

  it('phone, cold start: opens the Downloads tab', async () => {
    mockWindow = PHONE;
    // Jest has no app manifest for expo-linking's scheme: start at the path the link resolves to.
    const { router } = await open(routeFromUrl(LINK), TABS);
    expect(await screen.findByTestId('downloads-screen', {}, WAIT)).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/downloads');
    expect(router.getSegments()).toEqual(['(app)', '(tabs)', '(downloads)', 'downloads']);
  });

  it('phone, warm start: switches from a title in Home to the Downloads tab', async () => {
    mockWindow = PHONE;
    const { router } = await open('/series/7', TABS);
    await screen.findByTestId('series-screen-7', {}, WAIT);
    await follow();
    await waitFor(() => expect(router.getPathname()).toBe('/downloads'), WAIT);
    expect(router.getSegments()[2]).toBe('(downloads)');
    expect(await screen.findByTestId('downloads-screen', {}, WAIT)).toBeOnTheScreen();
  });

  it('Android TV, cold start: the Downloads rail entry is the selected one', async () => {
    asTv();
    const { router } = await open(routeFromUrl(LINK));
    expect(await screen.findByTestId('downloads-screen', {}, WAIT)).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/downloads');
    expect(screen.getByTestId('nav-downloads')).toBeSelected();
    expect(screen.getByTestId('nav-home')).not.toBeSelected();
  });

  it('Android TV, warm start: from a movie page to the Downloads rail entry', async () => {
    asTv();
    const { router } = await open('/movie/123');
    await screen.findByTestId('movie-download', {}, WAIT);
    expect(screen.getByTestId('nav-home')).toBeSelected();
    await follow();
    await waitFor(() => expect(router.getPathname()).toBe('/downloads'), WAIT);
    expect(await screen.findByTestId('downloads-screen', {}, WAIT)).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByTestId('nav-downloads')).toBeSelected(), WAIT);
    expect(screen.getByTestId('nav-home')).not.toBeSelected();
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
