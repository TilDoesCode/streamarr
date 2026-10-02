import { QueryClient } from '@tanstack/react-query';
import { userEvent } from '@testing-library/react-native';
import { router as navigate, Stack } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactNode } from 'react';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import { setLanguagePreference } from '@/i18n';
import { readLanguagePreference } from '@/i18n/languages';
import { exitDialogReducer, tvBackAction } from '@/navigation/tv-back';
import { backToChip, libraryBackStep, type LibraryZone } from '@/screens/library/library-back';
import { DesignProvider } from '@/theme';

import { appRoutes } from '../../jest/app-routes';

let mockWindow: { width: number; height: number; scale: number; fontScale: number } | undefined;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => {
  const actual = jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions');
  return { __esModule: true, default: () => mockWindow ?? actual.default() };
});

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const watch = { workId: 'tmdb-movie-123', kind: 'movie', played: false };

/** Catalog, health and sign-out of a fake Dev World. */
async function fakeServer(input: Request): Promise<Response> {
  const path = new URL(input.url).pathname;
  if (path === '/api/v1/viewer/watch/resume') return json(200, []);
  if (path === '/api/v1/viewer/watch/next-up') return json(200, { items: [] });
  if (path === '/api/v1/viewer/catalog/discover')
    return json(200, {
      rows: [
        {
          id: 'trending-movies',
          kind: 'trending',
          mediaType: 'movie',
          items: [{ workId: 'tmdb-movie-123', mediaType: 'movie', tmdbId: 123, title: 'Sintel' }],
        },
      ],
    });
  if (path === '/api/v1/viewer/catalog/movies/123')
    return json(200, {
      workId: 'tmdb-movie-123',
      tmdbId: 123,
      title: 'Sintel',
      year: 2010,
      watch,
      access: { allowed: true },
    });
  if (path === '/api/v1/viewer/catalog/search') {
    // The server rejects more than 20 results per page.
    if (Number(new URL(input.url).searchParams.get('limit')) > 20)
      return json(400, { error: { code: 'invalid_query', message: 'limit' } });
    const more = [124, 125, 126, 127].map((tmdbId) => ({
      workId: `tmdb-movie-${tmdbId}`,
      mediaType: 'movie',
      tmdbId,
      title: `Movie ${tmdbId}`,
    }));
    return json(200, {
      items: [
        { workId: 'tmdb-movie-123', mediaType: 'movie', tmdbId: 123, title: 'Sintel' },
        ...more,
      ],
    });
  }
  if (path === '/api/v1/health') return json(200, { status: 'ok', version: '1.2.3+abc' });
  if (path === '/api/v1/viewer/auth/logout') return new Response(null, { status: 204 });
  return json(404, { error: { code: 'not_found', message: 'nope' } });
}

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

let store: AccountStore;

function RootLayout() {
  return (
    <Providers>
      <Stack screenOptions={{ headerShown: false }} />
    </Providers>
  );
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider store={store} queryClient={new QueryClient()} fetch={fakeServer}>
          {children}
        </AccountsProvider>
      </ToastProvider>
    </DesignProvider>
  );
}

const routes = { _layout: RootLayout, ...appRoutes };

const tokens = () => ({
  sessionId: 's1',
  accessToken: 'sva_1',
  accessExpiresAt: Date.now() + 3_600_000,
  refreshToken: 'svr_1',
  refreshExpiresAt: Date.now() + 3_600_000,
});

async function signIn() {
  const anna = await store.addSignedIn(
    { url: 'http://dev.test', name: 'Dev World' },
    { id: 'v-anna', username: 'anna', displayName: 'Anna', mustChangePassword: false },
    tokens()
  );
  store.setActive(anna.id);
  return anna;
}

beforeEach(async () => {
  store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
  global.fetch = jest.fn(fakeServer) as unknown as typeof fetch;
  await act(async () => {
    await setLanguagePreference('en');
  });
});

it('opens the play route with the work id of the movie', async () => {
  await signIn();
  const router = renderRouter(routes, { initialUrl: '/movie/123' });
  await router;
  const play = await screen.findByTestId('movie-play');
  await userEvent.setup().press(play);
  await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
  expect(router.getSearchParams()).toMatchObject({ workId: 'tmdb-movie-123', title: 'Sintel' });
});

it('sends signed-out visitors of any app route to onboarding', async () => {
  const router = renderRouter(routes, { initialUrl: '/movie/123' });
  await router;
  expect(router.getPathname()).toBe('/server');
});

it('opens a deep link to a movie on top of Home', async () => {
  await signIn();
  const router = renderRouter(routes, { initialUrl: '/movie/123' });
  await router;
  expect(router.getPathname()).toBe('/movie/123');
  expect(router.getSegments()).toEqual(['(app)', '(tabs)', '(home)', 'movie', '[id]']);
  expect(await screen.findByTestId('movie-screen-123')).toBeOnTheScreen();
  expect(await screen.findByText('Sintel')).toBeOnTheScreen();
  expect(navigate.canGoBack()).toBe(true);
  await act(async () => {
    navigate.back();
  });
  expect(router.getPathname()).toBe('/');
  expect(screen.getByTestId('home-screen')).toBeOnTheScreen();
});

it('keeps every tab switch in the back history (web: one browser entry each)', async () => {
  const user = userEvent.setup();
  await signIn();
  const router = renderRouter(routes, { initialUrl: '/' });
  await router;
  await user.press(await screen.findByTestId('nav-search'));
  await user.press(screen.getByTestId('nav-home'));
  await user.press(screen.getByTestId('nav-search'));
  expect(router.getPathname()).toBe('/search');
  for (const path of ['/', '/search', '/']) {
    await act(async () => {
      navigate.back();
    });
    expect(router.getPathname()).toBe(path);
  }
});

it('switches tabs and pops a tab to its first screen', async () => {
  const user = userEvent.setup();
  await signIn();
  const router = renderRouter(routes, { initialUrl: '/' });
  await router;
  await user.press(await screen.findByTestId('home-card-trending-movies-0'));
  await waitFor(() => expect(router.getPathname()).toBe('/movie/123'));
  // The pushed screen must render (a memoized shell once kept the tab slot on the old state).
  expect(await screen.findByTestId('movie-screen-123')).toBeOnTheScreen();

  await user.press(screen.getByTestId('nav-search'));
  expect(router.getPathname()).toBe('/search');
  expect(screen.getByTestId('search-idle')).toBeOnTheScreen();
  await user.press(screen.getByTestId('nav-settings'));
  expect(router.getPathname()).toBe('/settings');

  // Home kept its stack; pressing the active tab again returns to its first screen.
  await user.press(screen.getByTestId('nav-home'));
  expect(router.getPathname()).toBe('/movie/123');
  await user.press(screen.getByTestId('nav-home'));
  await waitFor(() => expect(router.getPathname()).toBe('/'));
});

it.each([
  ['/', 'home-screen'],
  ['/movies', 'library-movie'],
  ['/search', 'search-screen'],
  ['/settings', 'settings-screen'],
])(
  'renders the phone tab root %s as a scroll view (iOS adopts it for the bar minimise)',
  async (url, id) => {
    await signIn();
    mockWindow = { width: 390, height: 844, scale: 3, fontScale: 1 };
    try {
      await renderRouter(routes, { initialUrl: url });
      expect((await screen.findByTestId(id)).type).toBe('RCTScrollView');
    } finally {
      mockWindow = undefined;
    }
  }
);

it('draws the Settings heading on the page in the large shell (tablet: no native header under the rail)', async () => {
  await signIn();
  await renderRouter(routes, { initialUrl: '/settings' });
  expect(
    await screen.findByRole('heading', { name: /^(Settings|Einstellungen)$/ })
  ).toBeOnTheScreen();
});

it('searches and pushes a result inside the Search tab', async () => {
  const user = userEvent.setup();
  await signIn();
  const router = renderRouter(routes, { initialUrl: '/search' });
  await router;
  await user.type(screen.getByTestId('search-field'), 'sintel');
  expect(await screen.findByTestId('search-result-4')).toBeOnTheScreen();
  // A narrower layout changes the column count without remounting the list header (TV kept focus on the field).
  const field = screen.getByTestId('search-field');
  await act(async () => {
    fireEvent(screen.getByTestId('search-screen'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 800 } },
    });
  });
  expect(screen.getByTestId('search-field')).toBe(field);
  expect(screen.getByTestId('search-result-4')).toBeOnTheScreen();
  await user.press(screen.getByTestId('search-result-0'));
  await waitFor(() => expect(router.getPathname()).toBe('/movie/123'));
  expect(router.getSegments()).toEqual(['(app)', '(tabs)', '(search)', 'movie', '[id]']);
  await act(async () => {
    navigate.back();
  });
  expect(router.getPathname()).toBe('/search');
  expect(screen.getByTestId('search-result-0')).toBeOnTheScreen();
});

it('settings switch the profile, change the language and sign out', async () => {
  const user = userEvent.setup();
  const anna = await signIn();
  const router = renderRouter(routes, { initialUrl: '/settings' });
  await router;
  expect(await screen.findByTestId('settings-account-name')).toHaveTextContent('Anna');
  expect(await screen.findByText('1.2.3')).toBeOnTheScreen();

  await user.press(screen.getByTestId('settings-language-de'));
  await waitFor(() => expect(screen.getByTestId('nav-home')).toHaveAccessibleName('Start'));
  expect(readLanguagePreference()).toBe('de');
  await user.press(screen.getByTestId('settings-language-system'));

  await user.press(screen.getByTestId('settings-switch-profile'));
  await waitFor(() => expect(router.getPathname()).toBe('/profiles'));
  await act(async () => {
    navigate.back();
  });
  expect(router.getPathname()).toBe('/settings');

  await user.press(screen.getByTestId('settings-sign-out'));
  expect(screen.getByTestId('sign-out-dialog')).toBeOnTheScreen();
  await user.press(screen.getAllByRole('button', { name: /sign out|abmelden/i }).at(-1)!);
  await waitFor(() => expect(router.getPathname()).toBe('/profiles'));
  expect(store.get(anna.id)).toMatchObject({ signedIn: false });
});

describe('TV back chain', () => {
  it('closes the rail, then navigates, then confirms the exit', () => {
    expect(tvBackAction({ railFocused: true, canGoBack: true })).toBe('closeRail');
    expect(tvBackAction({ railFocused: true, canGoBack: false })).toBe('closeRail');
    expect(tvBackAction({ railFocused: false, canGoBack: true })).toBe('navigate');
    expect(tvBackAction({ railFocused: false, canGoBack: false })).toBe('confirmExit');
    expect(tvBackAction({ railFocused: false, canGoBack: false, atHome: false })).toBe('home');
  });

  it('takes a tab page (Settings) through the rail before Home', () => {
    const page = { canGoBack: true, atHome: false, atTabPage: true };
    expect(tvBackAction({ ...page, railFocused: false })).toBe('rail');
    expect(tvBackAction({ ...page, railFocused: true, railByBack: true })).toBe('navigate');
    expect(tvBackAction({ ...page, railFocused: true })).toBe('closeRail');
    expect(tvBackAction({ ...page, canGoBack: false, railFocused: true, railByBack: true })).toBe(
      'home'
    );
  });

  it('leaves a library page for Home once its own steps handed focus to the rail', () => {
    let zone: LibraryZone = 'grid';
    const back = () => {
      const result = libraryBackStep(zone);
      zone = result.zone;
      return result.step;
    };
    expect(back()).toBe('chip');
    zone = 'genres'; // the selected chip took focus
    expect(back()).toBe('rail');
    expect(back()).toBeNull();
    const shell = { railFocused: true, railByBack: true, canGoBack: false };
    expect(tvBackAction({ ...shell, atHome: false })).toBe('home');
    expect(tvBackAction({ ...shell, atHome: true })).toBe('confirmExit');
    expect(libraryBackStep('sort').step).toBe('chip');
  });

  it('scrolls a lifted grid back to the top before the chip takes focus', () => {
    const calls: string[] = [];
    const frames: (() => void)[] = [];
    const list = { scrollToOffset: (p: { offset: number }) => calls.push(`scroll ${p.offset}`) };
    const chip = { requestTVFocus: () => calls.push('focus') };
    backToChip(
      list,
      () => chip,
      (run) => frames.push(run)
    );
    expect(calls).toEqual(['scroll 0']);
    frames.forEach((run) => run());
    expect(calls).toEqual(['scroll 0', 'focus']);
  });
});

describe('TV exit dialog across route changes', () => {
  it('does not reopen when a deep link leaves Home and Back returns there', () => {
    let openAt = exitDialogReducer(null, { type: 'open', path: '/' });
    expect(openAt).toBe('/');
    openAt = exitDialogReducer(openAt, { type: 'route', path: '/movie/10378' });
    expect(openAt).toBeNull();
    openAt = exitDialogReducer(openAt, { type: 'route', path: '/' });
    expect(openAt).toBeNull();
  });

  it('stays open while the path is unchanged and closes on request', () => {
    const openAt = exitDialogReducer(null, { type: 'open', path: '/' });
    expect(exitDialogReducer(openAt, { type: 'route', path: '/' })).toBe('/');
    expect(exitDialogReducer(openAt, { type: 'close' })).toBeNull();
  });
});
