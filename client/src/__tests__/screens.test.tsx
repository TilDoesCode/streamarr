import { QueryClient } from '@tanstack/react-query';
import { userEvent } from '@testing-library/react-native';
import { Stack } from 'expo-router';
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactNode } from 'react';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import { setLanguagePreference } from '@/i18n';
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
