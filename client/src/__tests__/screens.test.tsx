import { QueryClient } from '@tanstack/react-query';
import { userEvent, within } from '@testing-library/react-native';
import { Stack } from 'expo-router';
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { FlatList } from 'react-native';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import * as probe from '@/api/probe';
import type { AuthOptions } from '@/api/probe';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import i18n, { setLanguagePreference } from '@/i18n';
import { methodLabel } from '@/screens/settings/account-security';
import { DesignProvider } from '@/theme';

import { appRoutes } from '../../jest/app-routes';

// Phone tests override the window (the jest default is tablet-sized).
let mockWindow: { width: number; height: number; scale: number; fontScale: number } | undefined;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => {
  const actual = jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions');
  return { __esModule: true, default: () => mockWindow ?? actual.default() };
});

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

type Handler = (url: URL, request: Request) => Response | Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const never = () => new Promise<Response>(() => undefined);
const failure = () => json(500, { error: { code: 'server_error', message: 'boom' } });
const WAIT = { timeout: 5000 };

const sintel = { workId: 'tmdb-movie-123', mediaType: 'movie', tmdbId: 123, title: 'Sintel' };
const movie = {
  workId: 'tmdb-movie-123',
  tmdbId: 123,
  title: 'Sintel',
  year: 2010,
  watch: { workId: 'tmdb-movie-123', kind: 'movie', played: false },
  access: { allowed: true },
};
const version = (rank: number, recommended: boolean, method: string) => ({
  releaseId: `r${rank}`,
  rank,
  name: `Sintel.2010.${rank === 1 ? '1080p' : '2160p'}.mkv`,
  recommended,
  predictedMethod: method,
  health: null,
});

let handlers: Record<string, Handler> = {};

async function fakeServer(input: Request): Promise<Response> {
  const url = new URL(input.url);
  const handler = handlers[url.pathname];
  if (handler) return handler(url, input);
  return json(404, { error: { code: 'not_found', message: 'nope' } });
}

const baseHandlers = (): Record<string, Handler> => ({
  '/api/v1/viewer/catalog/discover': () =>
    json(200, {
      rows: [{ id: 'trending-movies', kind: 'trending', mediaType: 'movie', items: [sintel] }],
    }),
  '/api/v1/viewer/watch/resume': () => json(200, []),
  '/api/v1/viewer/watch/next-up': () => json(200, { items: [] }),
  '/api/v1/viewer/catalog/movies/123': () => json(200, movie),
  '/api/v1/viewer/catalog/works/tmdb-movie-123/versions': () =>
    json(200, {
      workId: 'tmdb-movie-123',
      versions: [version(1, false, 'transcode'), version(2, true, 'remux')],
    }),
});

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

let store: AccountStore;

function Providers({ children }: { children: ReactNode }) {
  return (
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider
          store={store}
          queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          fetch={fakeServer}>
          {children}
        </AccountsProvider>
      </ToastProvider>
    </DesignProvider>
  );
}

function RootLayout() {
  return (
    <Providers>
      <Stack screenOptions={{ headerShown: false }} />
    </Providers>
  );
}

const routes = { _layout: RootLayout, ...appRoutes };

async function open(initialUrl: string) {
  const anna = await store.addSignedIn(
    { url: 'http://dev.test', name: 'Dev World' },
    { id: 'v-anna', username: 'anna', displayName: 'Anna', mustChangePassword: false },
    {
      sessionId: 's1',
      accessToken: 'sva_1',
      accessExpiresAt: Date.now() + 3_600_000,
      refreshToken: 'svr_1',
      refreshExpiresAt: Date.now() + 3_600_000,
    }
  );
  store.setActive(anna.id);
  const router = renderRouter(routes, { initialUrl });
  await router;
  // Wrapped: returning the thenable result from an async function would unwrap it.
  return { router };
}

beforeEach(async () => {
  handlers = baseHandlers();
  store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
  global.fetch = jest.fn(fakeServer) as unknown as typeof fetch;
  await act(async () => {
    await setLanguagePreference('en');
  });
});

describe('Home', () => {
  it('shows a skeleton while the rows load', async () => {
    handlers['/api/v1/viewer/catalog/discover'] = never;
    await open('/');
    expect(await screen.findByTestId('home-loading')).toBeOnTheScreen();
  });

  it('waits for continue watching before showing rows', async () => {
    handlers['/api/v1/viewer/watch/resume'] = never;
    await open('/');
    expect(await screen.findByTestId('home-loading')).toBeOnTheScreen();
    expect(screen.queryByTestId('home-row-trending-movies')).toBeNull();
  });

  it('shows the empty state without rows', async () => {
    handlers['/api/v1/viewer/catalog/discover'] = () => json(200, { rows: [] });
    await open('/');
    expect(await screen.findByTestId('home-empty')).toBeOnTheScreen();
  });

  it('shows an error with a working retry', async () => {
    let fail = true;
    handlers['/api/v1/viewer/catalog/discover'] = () =>
      fail
        ? failure()
        : baseHandlers()['/api/v1/viewer/catalog/discover']!(
            new URL('http://x'),
            new Request('http://x')
          );
    await open('/');
    expect(await screen.findByTestId('home-error')).toBeOnTheScreen();
    fail = false;
    await userEvent.setup().press(screen.getByText('Try again'));
    expect(await screen.findByTestId('home-row-trending-movies', {}, WAIT)).toBeOnTheScreen();
  });

  it('opens a title from a row', async () => {
    const { router } = await open('/');
    await userEvent.setup().press(await screen.findByTestId('home-card-trending-movies-0'));
    await waitFor(() => expect(router.getPathname()).toBe('/movie/123'));
  });
});

describe('Search', () => {
  it('shows results, loading, empty and error states', async () => {
    let mode: 'ok' | 'empty' | 'error' | 'slow' = 'slow';
    handlers['/api/v1/viewer/catalog/search'] = () =>
      mode === 'slow'
        ? never()
        : mode === 'error'
          ? failure()
          : json(200, { items: mode === 'ok' ? [sintel] : [] });
    await open('/search');
    const user = userEvent.setup();
    const field = await screen.findByTestId('search-field');
    await user.type(field, 'sin');
    expect(await screen.findByTestId('search-loading', {}, WAIT)).toBeOnTheScreen();
    mode = 'ok';
    await user.type(field, 't');
    expect(await screen.findByTestId('search-result-0', {}, WAIT)).toBeOnTheScreen();
    mode = 'empty';
    await user.type(field, 'x');
    expect(await screen.findByTestId('search-empty', {}, WAIT)).toBeOnTheScreen();
    mode = 'error';
    await user.type(field, 'y');
    expect(await screen.findByTestId('search-error', {}, WAIT)).toBeOnTheScreen();
  });

  it('resets the type filter on a profile switch', async () => {
    handlers['/api/v1/viewer/catalog/search'] = () => json(200, { items: [] });
    await open('/search');
    const user = userEvent.setup();
    await user.press(await screen.findByTestId('search-type-movie'));
    expect(screen.getByTestId('search-type-movie')).toBeChecked();
    await act(async () => {
      // Anna's session ends, so Ben is the only signed-in profile (no profile picker).
      await store.signOut(store.getSnapshot().activeId!, 'refresh_token_reused');
      const ben = await store.addSignedIn(
        { url: 'http://dev.test', name: 'Dev World' },
        { id: 'v-ben', username: 'ben', displayName: 'Ben', mustChangePassword: false },
        {
          sessionId: 's2',
          accessToken: 'sva_2',
          accessExpiresAt: Date.now() + 3_600_000,
          refreshToken: 'svr_2',
          refreshExpiresAt: Date.now() + 3_600_000,
        }
      );
      store.setActive(ben.id);
    });
    await waitFor(() => expect(screen.getByTestId('search-type-any')).toBeChecked());
  });
});

describe('Library', () => {
  const browseItem = (id: number, title: string) => ({
    workId: `tmdb-movie-${id}`,
    mediaType: 'movie',
    tmdbId: id,
    title,
  });
  const page = (items: unknown[], pageNumber: number, hasMore: boolean) =>
    json(200, { items, page: pageNumber, totalPages: 3, hasMore });

  beforeEach(() => {
    handlers['/api/v1/viewer/catalog/genres'] = () =>
      json(200, { genres: [{ id: 27, name: 'Horror' }] });
  });

  it('shows a skeleton grid with the URL genre selected while loading', async () => {
    handlers['/api/v1/viewer/catalog/browse'] = never;
    await open('/movies?genre=27');
    expect(await screen.findByTestId('library-loading', {}, WAIT)).toBeOnTheScreen();
    expect(await screen.findByTestId('library-genre-27', {}, WAIT)).toBeChecked();
  });

  it('shows an error, then the empty state after a retry', async () => {
    let fail = true;
    handlers['/api/v1/viewer/catalog/browse'] = () => (fail ? failure() : page([], 1, false));
    await open('/movies?genre=27');
    expect(await screen.findByTestId('library-error', {}, WAIT)).toBeOnTheScreen();
    fail = false;
    const user = userEvent.setup();
    await user.press(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByTestId('library-empty', {}, WAIT)).toBeOnTheScreen();
  });

  it('pages on hasMore, follows empty gated pages and drops duplicates', async () => {
    handlers['/api/v1/viewer/catalog/browse'] = (url) => {
      const n = Number(url.searchParams.get('page'));
      if (n === 1) return page([browseItem(1, 'Sintel')], 1, true);
      if (n === 2) return page([], 2, true);
      return page([browseItem(1, 'Sintel'), browseItem(3, 'Wing It!')], 3, false);
    };
    await open('/movies');
    expect(await screen.findByTestId('library-item-1', {}, WAIT)).toHaveTextContent(/Wing It!/);
    expect(screen.queryByTestId('library-item-2')).toBeNull();
    expect(screen.queryByTestId('library-empty')).toBeNull();
  });

  it('starts a new genre at the top of the page', async () => {
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset');
    handlers['/api/v1/viewer/catalog/browse'] = () => page([browseItem(1, 'Sintel')], 1, false);
    await open('/movies');
    expect(await screen.findByTestId('library-item-0', {}, WAIT)).toBeOnTheScreen();
    expect(scrollToOffset).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.press(screen.getByTestId('library-genre-27'));
    await waitFor(() => expect(screen.getByTestId('library-genre-27')).toBeChecked(), WAIT);
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
    scrollToOffset.mockRestore();
  });

  it('puts the sort into the title line and the genres into one horizontal row', async () => {
    handlers['/api/v1/viewer/catalog/browse'] = () => page([browseItem(1, 'Sintel')], 1, false);
    await open('/movies');
    expect(await screen.findByTestId('library-item-0', {}, WAIT)).toBeOnTheScreen();
    const line = screen.getByTestId('library-title-line');
    expect(within(line).getByRole('heading', { name: 'Movies' })).toBeOnTheScreen();
    expect(within(line).getByTestId('library-sort')).toBeOnTheScreen();
    const row = within(screen.getByTestId('library-genres')).getByTestId('library-genres-scroll');
    expect(row).toHaveProp('horizontal', true);
    expect(within(row).getByTestId('library-genre-27')).toBeOnTheScreen();
  });

  it('falls back to All for a genre the server does not list', async () => {
    handlers['/api/v1/viewer/catalog/browse'] = () => page([browseItem(1, 'Sintel')], 1, false);
    await open('/movies?genre=99&sort=top_rated');
    await waitFor(() => expect(screen.getByTestId('library-genre-all')).toBeChecked(), WAIT);
    expect(screen.getByTestId('library-sort-top_rated')).toBeChecked();
    expect(await screen.findByTestId('library-item-0', {}, WAIT)).toBeOnTheScreen();
  });
});

describe('Movie detail', () => {
  it('shows a skeleton, then the title with Play', async () => {
    let release: (() => void) | undefined;
    handlers['/api/v1/viewer/catalog/movies/123'] = () =>
      new Promise((resolve) => (release = () => resolve(json(200, movie))));
    await open('/movie/123');
    expect(await screen.findByTestId('hero-skeleton')).toBeOnTheScreen();
    await act(async () => release?.());
    expect(await screen.findByTestId('movie-play')).toBeOnTheScreen();
  });

  it('shows an error with retry', async () => {
    handlers['/api/v1/viewer/catalog/movies/123'] = failure;
    await open('/movie/123');
    expect(await screen.findByTestId('detail-error')).toBeOnTheScreen();
  });

  it('offers no Play without versions', async () => {
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = () =>
      json(200, { workId: 'tmdb-movie-123', versions: [] });
    await open('/movie/123');
    expect(await screen.findByTestId('movie-no-versions', {}, WAIT)).toBeOnTheScreen();
    expect(screen.queryByTestId('movie-play')).toBeNull();
  });

  it('offers Watch again for a played movie and resumes a rewatch', async () => {
    handlers['/api/v1/viewer/catalog/movies/123'] = () =>
      json(200, { ...movie, watch: { ...movie.watch, played: true } });
    await open('/movie/123');
    expect(await screen.findByText('Watch again')).toBeOnTheScreen();
  });

  it('names the movie in the watched toast', async () => {
    handlers['/api/v1/viewer/watch/played'] = () => json(200, {});
    await open('/movie/123');
    await userEvent.setup().press(await screen.findByTestId('movie-mark'));
    expect(await screen.findByText('“Sintel” marked as watched')).toBeOnTheScreen();
  });
});

describe('Series detail', () => {
  const series = {
    workId: 'tmdb-tv-7',
    tmdbId: 7,
    title: 'Sherlock',
    seasonCount: 1,
    seasons: [{ seasonNumber: 1, title: 'Season 1', episodeCount: 1 }],
    watch: { totalEpisodes: 1, playedEpisodes: 1, nextEpisode: null },
  };

  it('offers Watch again from S1E1 when every episode is watched', async () => {
    handlers['/api/v1/viewer/catalog/series/7'] = () => json(200, series);
    handlers['/api/v1/viewer/catalog/series/7/seasons/1'] = () =>
      json(200, { seasonNumber: 1, title: 'Season 1', seriesTitle: 'Sherlock', episodes: [] });
    handlers['/api/v1/viewer/catalog/works/tmdb-tv-7-s01e01/versions'] = () =>
      json(200, { workId: 'tmdb-tv-7-s01e01', versions: [version(1, true, 'direct')] });
    const { router } = await open('/series/7');
    const play = await screen.findByTestId('series-play', {}, WAIT);
    expect(play).toHaveTextContent('Watch again');
    await userEvent.setup().press(play);
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams()).toMatchObject({ workId: 'tmdb-tv-7-s01e01', start: '0' });
  });

  it('localizes generic season names in German', async () => {
    await act(async () => {
      await setLanguagePreference('de');
    });
    handlers['/api/v1/viewer/catalog/series/7'] = () => json(200, series);
    handlers['/api/v1/viewer/catalog/series/7/seasons/1'] = () =>
      json(200, { seasonNumber: 1, title: 'Season 1', seriesTitle: 'Sherlock', episodes: [] });
    await open('/series/7');
    expect(await screen.findByTestId('season-1', {}, WAIT)).toHaveTextContent(/Staffel 1/);
  });

  it('shows an error with retry', async () => {
    handlers['/api/v1/viewer/catalog/series/7'] = failure;
    await open('/series/7');
    expect(await screen.findByTestId('detail-error')).toBeOnTheScreen();
  });
});

describe('Version picker', () => {
  it('marks the recommended version, plain wording and the release name in the panel', async () => {
    await open('/movie/123');
    await userEvent.setup().press(await screen.findByTestId('movie-versions', {}, WAIT));
    const recommended = await screen.findByTestId('version-2', {}, WAIT);
    expect(recommended).toHaveTextContent(/Recommended/);
    expect(screen.getByTestId('version-2-plain')).toHaveTextContent(/only repackages/);
    // Large shell: the always-visible panel shows the release name (mono) without a details toggle.
    expect(screen.getByTestId('version-2-name')).toHaveTextContent('Sintel.2010.2160p.mkv');
  });

  it('shows Recommended and Last played together on one card', async () => {
    handlers['/api/v1/viewer/catalog/movies/123'] = () =>
      json(200, { ...movie, watch: { ...movie.watch, lastReleaseId: 'r2' } });
    await open('/movie/123');
    const card = await screen.findByTestId('version-2', {}, WAIT);
    expect(card).toHaveTextContent(/Recommended/);
    expect(card).toHaveTextContent(/Last played/);
    expect(screen.getByTestId('version-panel')).toBeOnTheScreen();
  });

  it('plays the picked version', async () => {
    const { router } = await open('/movie/123');
    const user = userEvent.setup();
    await user.press(await screen.findByTestId('movie-versions', {}, WAIT));
    await user.press(await screen.findByTestId('version-1', {}, WAIT));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams()).toMatchObject({ releaseId: 'r1' });
  });

  it('shows a skeleton while versions load', async () => {
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = never;
    await open('/movie/123');
    await userEvent.setup().press(await screen.findByTestId('movie-versions', {}, WAIT));
    expect((await screen.findAllByTestId('versions-loading', {}, WAIT)).length).toBeGreaterThan(0);
  });

  it('shows an error with retry', async () => {
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = failure;
    await open('/movie/123');
    await userEvent.setup().press(await screen.findByTestId('movie-versions', {}, WAIT));
    expect(await screen.findByTestId('versions-error', {}, WAIT)).toBeOnTheScreen();
  });
});

describe('Phone detail', () => {
  beforeEach(() => {
    mockWindow = { width: 390, height: 844, scale: 3, fontScale: 1 };
  });
  afterEach(() => {
    mockWindow = undefined;
  });

  it('shows the compact detail with Play, the Version card and the watched action', async () => {
    handlers['/api/v1/viewer/watch/played'] = () => json(200, {});
    await open('/movie/123');
    expect(await screen.findByTestId('movie-play', {}, WAIT)).toBeOnTheScreen();
    expect(await screen.findByTestId('versions-summary', {}, WAIT)).toHaveTextContent(/Version/);
    expect(screen.queryByTestId('version-panel')).toBeNull();
    await userEvent.setup().press(screen.getByTestId('movie-mark'));
    expect(await screen.findByText('“Sintel” marked as watched')).toBeOnTheScreen();
  });

  it('opens the native version sheet on iPhone and plays the picked version', async () => {
    const { router } = await open('/movie/123');
    const user = userEvent.setup();
    await user.press(await screen.findByTestId('versions-summary', {}, WAIT));
    await waitFor(() => expect(router.getPathname()).toBe('/versions/tmdb-movie-123'));
    await user.press(await screen.findByTestId('version-1', {}, WAIT));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams()).toMatchObject({ releaseId: 'r1', workId: 'tmdb-movie-123' });
  });
});

describe('Settings account', () => {
  const profile = {
    id: 'v-anna',
    username: 'anna',
    displayName: 'Anna',
    email: 'anna@example.test',
    emailVerified: true,
    twoFactorEnabled: false,
    recoveryCodesRemaining: 0,
    permissions: {},
  };
  const sessions = [
    {
      id: 's1',
      deviceName: 'Pixel (Android)',
      clientName: 'Streamarr Android',
      authMethod: 'password',
      lastSeenAt: '2026-10-01T01:00:00Z',
      current: true,
    },
    {
      id: 's2',
      deviceName: 'Chrome (Web)',
      clientName: 'Streamarr Web',
      authMethod: 'password',
      lastSeenAt: '2026-09-30T20:00:00Z',
      current: false,
    },
  ];
  beforeEach(() => {
    handlers['/api/v1/health'] = () => json(200, { version: '1.0.0' });
    handlers['/api/v1/viewer/me'] = () => json(200, profile);
    handlers['/api/v1/viewer/me/sessions'] = () => json(200, sessions);
  });
  afterEach(() => jest.restoreAllMocks());

  it('shows loading states for devices and security', async () => {
    handlers['/api/v1/viewer/me/sessions'] = never;
    handlers['/api/v1/viewer/me'] = never;
    await open('/settings');
    expect(await screen.findByTestId('settings-devices-loading')).toBeOnTheScreen();
    expect(screen.getByTestId('settings-security-loading')).toBeOnTheScreen();
  });

  it('lists devices with this device marked and signs out another one', async () => {
    const deleted: string[] = [];
    let list = sessions;
    handlers['/api/v1/viewer/me/sessions'] = () => json(200, list);
    handlers['/api/v1/viewer/me/sessions/s2'] = (_url, request) => {
      deleted.push(request.method);
      list = sessions.filter((s) => s.id !== 's2');
      return new Response(null, { status: 204 });
    };
    await open('/settings');
    expect(await screen.findByTestId('settings-device-current')).toBeOnTheScreen();
    expect(screen.getByText('Chrome (Web)')).toBeOnTheScreen();
    await userEvent.setup().press(screen.getByTestId('settings-device-sign-out-s2'));
    expect(await screen.findByTestId('settings-devices-empty', {}, WAIT)).toBeOnTheScreen();
    expect(deleted).toEqual(['DELETE']);
  });

  it('shows the device list error with retry', async () => {
    let fail = true;
    handlers['/api/v1/viewer/me/sessions'] = () => (fail ? failure() : json(200, sessions));
    await open('/settings');
    expect(await screen.findByTestId('settings-devices-error')).toBeOnTheScreen();
    fail = false;
    await userEvent
      .setup()
      .press(within(screen.getByTestId('settings-devices-error')).getByText('Try again'));
    expect(await screen.findByTestId('settings-device-current', {}, WAIT)).toBeOnTheScreen();
  });

  it('maps a wrong current password, then changes the password', async () => {
    let wrong = true;
    handlers['/api/v1/viewer/me/password'] = () =>
      wrong
        ? json(400, { error: { code: 'invalid_credentials', message: 'x' } })
        : new Response(null, { status: 204 });
    // The server's configured minimum feeds the hint (the probe uses XHR, not the fake fetch).
    jest.spyOn(probe, 'probeServer').mockResolvedValue({
      baseUrl: 'http://dev.test',
      name: 'Dev World',
      options: { passwordLogin: true, passwordMinLength: 12 } as AuthOptions,
      insecure: false,
    });
    await open('/settings');
    const user = userEvent.setup();
    await user.press(await screen.findByTestId('settings-password-toggle'));
    expect(
      await screen.findByText('At least 12 characters, not your username.', {}, WAIT)
    ).toBeOnTheScreen();
    await user.type(screen.getByTestId('settings-password-current'), 'nope');
    await user.type(screen.getByTestId('settings-password-new'), 'a-new-password');
    await user.press(screen.getByTestId('settings-password-submit'));
    expect(
      await screen.findByTestId('settings-password-error-invalid_credentials', {}, WAIT)
    ).toBeOnTheScreen();
    expect(screen.getByText('Wrong current password')).toBeOnTheScreen();
    wrong = false;
    await user.press(screen.getByTestId('settings-password-submit'));
    expect(await screen.findByText(/Password changed/, {}, WAIT)).toBeOnTheScreen();
  });

  it('requests an e-mail code and verifies it', async () => {
    let verified = false;
    handlers['/api/v1/viewer/me/email'] = () =>
      json(200, { verificationSent: true, pendingEmail: 'new@example.test' });
    handlers['/api/v1/viewer/me/email/verify'] = async (_url, request) => {
      const body = (await request.json()) as { code: string };
      if (body.code !== 'ABCD-EFGH')
        return json(400, { error: { code: 'invalid_code', message: 'x' } });
      verified = true;
      return json(200, { ...profile, email: 'new@example.test' });
    };
    await open('/settings');
    const user = userEvent.setup();
    await user.press(await screen.findByTestId('settings-email-toggle'));
    await user.type(screen.getByTestId('settings-email-address'), 'new@example.test');
    await user.type(screen.getByTestId('settings-email-password'), 'streamarr');
    await user.press(screen.getByTestId('settings-email-submit'));
    expect(await screen.findByTestId('settings-email-sent', {}, WAIT)).toBeOnTheScreen();
    await user.type(screen.getByTestId('settings-email-code'), 'WRONG');
    await user.press(screen.getByTestId('settings-email-verify'));
    expect(
      await screen.findByTestId('settings-email-verify-error-invalid_code', {}, WAIT)
    ).toBeOnTheScreen();
    await user.clear(screen.getByTestId('settings-email-code'));
    await user.type(screen.getByTestId('settings-email-code'), 'ABCD-EFGH');
    await user.press(screen.getByTestId('settings-email-verify'));
    expect(await screen.findByText('E-mail address confirmed.', {}, WAIT)).toBeOnTheScreen();
    expect(verified).toBe(true);
  });

  it('sets up two-factor with a QR code and shows the recovery codes once', async () => {
    handlers['/api/v1/viewer/me/two-factor/setup'] = () =>
      json(200, {
        secret: 'JBSWY3DPEHPK3PXP',
        otpAuthUri: 'otpauth://totp/Streamarr:anna?secret=JBSWY3DPEHPK3PXP&issuer=Streamarr',
        issuer: 'Streamarr',
        accountName: 'anna',
      });
    handlers['/api/v1/viewer/me/two-factor/enable'] = () =>
      json(200, { recoveryCodes: ['aaaa-bbbb', 'cccc-dddd'] });
    await open('/settings');
    const user = userEvent.setup();
    await user.press(await screen.findByTestId('settings-two-factor-toggle'));
    await user.type(screen.getByTestId('settings-two-factor-password'), 'streamarr');
    await user.press(screen.getByTestId('settings-two-factor-start'));
    expect(await screen.findByTestId('settings-two-factor-qr', {}, WAIT)).toBeOnTheScreen();
    expect(screen.getByTestId('settings-two-factor-secret')).toHaveTextContent(
      'JBSW Y3DP EHPK 3PXP'
    );
    await user.type(screen.getByTestId('settings-two-factor-code'), '123456');
    await user.press(screen.getByTestId('settings-two-factor-enable'));
    expect(await screen.findByText('aaaa-bbbb', {}, WAIT)).toBeOnTheScreen();
    expect(screen.getByTestId('settings-two-factor-toggle')).toHaveTextContent('Done');
    await user.press(screen.getByTestId('settings-recovery-done'));
    // Saved: the panel closes instead of falling back to the password step.
    expect(screen.getByTestId('settings-two-factor-toggle')).toHaveTextContent('Set up');
    expect(screen.queryByText('aaaa-bbbb')).toBeNull();
    expect(screen.queryByTestId('settings-two-factor-password')).toBeNull();
  });

  it('offers new recovery codes and turning off when two-factor is on', async () => {
    handlers['/api/v1/viewer/me'] = () =>
      json(200, { ...profile, twoFactorEnabled: true, recoveryCodesRemaining: 7 });
    let wrong = true;
    handlers['/api/v1/viewer/me/two-factor/disable'] = () =>
      wrong
        ? json(400, { error: { code: 'invalid_credentials', message: 'x' } })
        : new Response(null, { status: 204 });
    await open('/settings');
    expect(await screen.findByText('On · 7 recovery codes left')).toBeOnTheScreen();
    const user = userEvent.setup();
    await user.press(screen.getByTestId('settings-two-factor-toggle'));
    expect(screen.getByTestId('settings-two-factor-regenerate')).toBeOnTheScreen();
    await user.type(screen.getByTestId('settings-two-factor-password'), 'nope');
    await user.press(screen.getByTestId('settings-two-factor-disable'));
    expect(
      await screen.findByTestId('settings-two-factor-error-invalid_credentials', {}, WAIT)
    ).toBeOnTheScreen();
    wrong = false;
    await user.press(screen.getByTestId('settings-two-factor-disable'));
    await waitFor(
      () => expect(screen.queryByTestId('settings-two-factor-password')).toBeNull(),
      WAIT
    );
  });

  it('refetches devices and security when the Settings tab is shown again', async () => {
    let list = sessions;
    let me = profile;
    handlers['/api/v1/viewer/me/sessions'] = () => json(200, list);
    handlers['/api/v1/viewer/me'] = () => json(200, me);
    const { router } = await open('/settings');
    expect(await screen.findByText('Chrome (Web)')).toBeOnTheScreen();
    const user = userEvent.setup();
    await user.press(screen.getByTestId('nav-movies'));
    await waitFor(() => expect(router.getPathname()).toBe('/movies'));
    list = [...sessions, { ...sessions[1]!, id: 's3', deviceName: 'iPad' }];
    me = { ...profile, twoFactorEnabled: true, recoveryCodesRemaining: 10 };
    await user.press(screen.getByTestId('nav-settings'));
    await waitFor(() => expect(router.getPathname()).toBe('/settings'));
    expect(await screen.findByText('iPad', {}, WAIT)).toBeOnTheScreen();
    expect(await screen.findByText(/10 recovery codes/, {}, WAIT)).toBeOnTheScreen();
  });

  it('signs out every other device with one request and refreshes the list', async () => {
    const calls: string[] = [];
    let list = [
      ...sessions,
      { ...sessions[1]!, id: 's3', deviceName: 'iPad', authMethod: 'email_code+2fa' },
    ];
    handlers['/api/v1/viewer/me/sessions'] = () => json(200, list);
    handlers['/api/v1/viewer/me/sessions/sign-out-others'] = (_url, request) => {
      calls.push(request.method);
      list = list.filter((s) => s.current);
      return json(200, { signedOut: 2 });
    };
    await open('/settings');
    const button = await screen.findByTestId('settings-devices-sign-out-others');
    expect(screen.getByText(/E-mail code \+ two-step code/)).toBeOnTheScreen();
    await userEvent.setup().press(button);
    expect(await screen.findByTestId('settings-devices-empty', {}, WAIT)).toBeOnTheScreen();
    expect(screen.getByText('2 devices signed out')).toBeOnTheScreen();
    expect(calls).toEqual(['POST']);
  });

  it('names sign-in methods in the app language', () => {
    const t = i18n.getFixedT('en');
    expect(methodLabel(t, 'password+2fa')).toBe('Password + two-step code');
    expect(methodLabel(t, 'email_code')).toBe('E-mail code');
    expect(methodLabel(t, 'passkey')).toBe('Other');
    expect(methodLabel(i18n.getFixedT('de'), 'password+2fa')).toBe('Passwort + Bestätigungscode');
  });

  it('edits the display name and avatar colour', async () => {
    const bodies: unknown[] = [];
    handlers['/api/v1/viewer/me'] = async (_url, request) => {
      if (request.method !== 'PATCH') return json(200, profile);
      const body = (await request.json()) as { displayName: string | null; avatarKey: string };
      bodies.push(body);
      return json(200, { ...profile, displayName: body.displayName, avatarKey: body.avatarKey });
    };
    await open('/settings');
    const user = userEvent.setup();
    await user.press(await screen.findByTestId('settings-edit-profile'));
    const name = screen.getByTestId('settings-profile-name');
    await user.clear(name);
    await user.type(name, 'Anna B.');
    await user.press(screen.getByTestId('settings-profile-avatar-coral'));
    expect(screen.getByTestId('settings-profile-avatar-coral')).toBeChecked();
    await user.press(screen.getByTestId('settings-profile-save'));
    expect(await screen.findByText('Profile saved', {}, WAIT)).toBeOnTheScreen();
    expect(bodies).toEqual([{ displayName: 'Anna B.', avatarKey: 'coral' }]);
    expect(screen.queryByTestId('settings-profile-editor')).toBeNull();
    expect(screen.getByTestId('settings-account-name')).toHaveTextContent('Anna B.');
    expect(store.active()).toMatchObject({ displayName: 'Anna B.', avatarKey: 'coral', color: 5 });
  });

  it('shows the invalid name error from the server', async () => {
    handlers['/api/v1/viewer/me'] = (_url, request) =>
      request.method === 'PATCH'
        ? json(400, { error: { code: 'invalid_display_name', message: 'x' } })
        : json(200, profile);
    await open('/settings');
    const user = userEvent.setup();
    await user.press(await screen.findByTestId('settings-edit-profile'));
    await user.press(screen.getByTestId('settings-profile-save'));
    expect(
      await screen.findByText('Names can have up to 64 printable characters.', {}, WAIT)
    ).toBeOnTheScreen();
    expect(screen.getByTestId('settings-profile-editor')).toBeOnTheScreen();
    await user.press(screen.getByTestId('settings-profile-cancel'));
    expect(screen.queryByTestId('settings-profile-editor')).toBeNull();
    expect(screen.getByTestId('settings-sign-out')).toBeOnTheScreen();
  });

  it('counts down the e-mail code cooldown in Settings', async () => {
    handlers['/api/v1/viewer/me/email'] = () =>
      new Response(
        JSON.stringify({
          error: { code: 'email_code_cooldown', message: 'x', retryAfterSeconds: 2 },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } }
      );
    await open('/settings');
    const user = userEvent.setup();
    await user.press(await screen.findByTestId('settings-email-toggle'));
    await user.type(screen.getByTestId('settings-email-address'), 'new@example.test');
    await user.type(screen.getByTestId('settings-email-password'), 'streamarr');
    await user.press(screen.getByTestId('settings-email-submit'));
    expect(
      await screen.findByTestId('settings-email-error-email_code_cooldown', {}, WAIT)
    ).toHaveProp('role', 'status');
    expect(screen.getByTestId('settings-email-submit')).toHaveTextContent('Wait 2 s');
    expect(screen.getByTestId('settings-email-submit')).toBeDisabled();
    await waitFor(
      () => expect(screen.getByTestId('settings-email-submit')).toHaveTextContent('Send code'),
      WAIT
    );
    expect(screen.queryByTestId('settings-email-error-email_code_cooldown')).toBeNull();
  });
});
