import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, userEvent, within } from '@testing-library/react-native';
import { router as appRouter, Stack } from 'expo-router';
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { ActionSheetIOS, FlatList } from 'react-native';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import * as probe from '@/api/probe';
import type { AuthOptions } from '@/api/probe';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import i18n, { setLanguagePreference } from '@/i18n';
import { aboutSheetHost } from '@/screens/detail/about-sheet';
import { versionSheetHost } from '@/browse/version-sheet';
import { methodLabel } from '@/screens/settings/account-security';
import { colors, DesignProvider } from '@/theme';

import { appRoutes } from '../../jest/app-routes';

// Counts MovieScreen mounts: a new title must remount the page (TV focus memory lives in its focus guides).
const mockMovieMounts = { count: 0 };
jest.mock('@/screens/detail/movie-screen', () => {
  const actual = jest.requireActual('@/screens/detail/movie-screen');
  const { useEffect } = jest.requireActual('react');
  return {
    ...actual,
    MovieScreen: () => {
      useEffect(() => void (mockMovieMounts.count += 1), []);
      return actual.MovieScreen();
    },
  };
});

// Phone tests override the window (the jest default is tablet-sized).
let mockWindow: { width: number; height: number; scale: number; fontScale: number } | undefined;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => {
  const actual = jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions');
  return { __esModule: true, default: () => mockWindow ?? actual.default() };
});
afterEach(() => {
  mockWindow = undefined;
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

describe('Movie Bühne chip row', () => {
  const resumeWatch = (lastReleaseId: string) => ({
    ...movie.watch,
    positionTicks: 60 * 10_000_000,
    durationTicks: 600 * 10_000_000,
    lastReleaseId,
  });

  it('names the recommended version Play starts, without a releaseId', async () => {
    const { router } = await open('/movie/123');
    const method = await screen.findByTestId('play-chips-method', {}, WAIT);
    expect(method).toHaveTextContent('Direct stream');
    expect(screen.queryByTestId('play-chips-last-played')).toBeNull();
    expect(screen.getByRole('button', { name: /^Plays: Direct stream/ })).toHaveProp(
      'accessibilityHint',
      'Opens the versions'
    );
    expect(screen.queryByTestId('version-panel')).toBeNull();
    await userEvent.setup().press(screen.getByTestId('movie-play'));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams().releaseId).toBeUndefined();
  });

  it('Resume shows and starts the last played version with the marker', async () => {
    handlers['/api/v1/viewer/catalog/movies/123'] = () =>
      json(200, { ...movie, watch: resumeWatch('r1') });
    const { router } = await open('/movie/123');
    expect(await screen.findByTestId('play-chips-method', {}, WAIT)).toHaveTextContent(
      'Transcoded'
    );
    const marker = screen.getByTestId('play-chips-last-played');
    expect(marker).toHaveTextContent('Last played');
    // Outlined and muted: a filled white pill would read as a focused button on TV.
    expect(marker).toHaveStyle({ borderColor: colors.foreground.subtle });
    expect(marker).not.toHaveStyle({ backgroundColor: colors.foreground.DEFAULT });
    await userEvent.setup().press(screen.getByTestId('movie-play'));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams()).toMatchObject({ releaseId: 'r1', start: '60' });
  });

  it('Start over starts the same version as Resume', async () => {
    handlers['/api/v1/viewer/catalog/movies/123'] = () =>
      json(200, { ...movie, watch: resumeWatch('r1') });
    const { router } = await open('/movie/123');
    await screen.findByTestId('play-chips-last-played', {}, WAIT);
    await userEvent.setup().press(screen.getByTestId('movie-start-over'));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams()).toMatchObject({ releaseId: 'r1', start: '0' });
  });

  it('falls back to the recommendation when the last played version is gone', async () => {
    handlers['/api/v1/viewer/catalog/movies/123'] = () =>
      json(200, { ...movie, watch: resumeWatch('vanished') });
    const { router } = await open('/movie/123');
    expect(await screen.findByTestId('play-chips-reasons', {}, WAIT)).toHaveTextContent(
      /Last played version no longer available/
    );
    expect(screen.getByTestId('play-chips-method')).toHaveTextContent('Direct stream');
    await userEvent.setup().press(screen.getByTestId('movie-play'));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams().releaseId).toBeUndefined();
  });

  it('names a transcode with its reasons and drops chips instead of wrapping', async () => {
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = () =>
      json(200, {
        workId: 'tmdb-movie-123',
        versions: [
          {
            ...version(1, true, 'transcode'),
            resolution: '2160p',
            hdr: 'HDR10',
            hdrFormats: ['HDR10'],
            videoCodec: 'hevc',
            bitDepth: 10,
            audioCodec: 'truehd',
            audioChannels: '7.1',
            atmos: true,
            source: 'Remux',
            sizeBytes: 60_000_000_000,
            predictionReasons: [
              { code: 'audio_codec_unsupported', params: { codec: 'truehd' } },
              { code: 'hdr_unsupported', params: { hdr: 'HDR10' } },
              { code: 'subtitle_burned_in' },
            ],
          },
        ],
      });
    await open('/movie/123');
    expect(await screen.findByTestId('play-chips-method', {}, WAIT)).toHaveTextContent(
      'Transcoded'
    );
    const reasons = screen.getByTestId('play-chips-reasons');
    expect(reasons).toHaveTextContent(/HDR10 → SDR/);
    expect(reasons).toHaveTextContent(/Audio is converted \(TrueHD\)/);
    expect(reasons).not.toHaveTextContent(/Subtitles/);
    for (const key of ['resolution', 'hdr', 'video', 'audio', 'source', 'size'])
      expect(screen.getByTestId(`play-chips-${key}`)).toBeOnTheScreen();
    const layout = (width: number) =>
      act(async () =>
        fireEvent(screen.getByTestId('play-chips'), 'layout', {
          nativeEvent: { layout: { width, height: 104, x: 0, y: 0 } },
        })
      );
    const shown = (key: string) => !!screen.queryByTestId(`play-chips-${key}`);
    const steps: string[] = [];
    for (let width = 600; width >= 100; width -= 10) {
      await layout(width);
      for (const key of ['method', 'resolution', 'hdr']) expect(shown(key)).toBe(true);
      const state = !shown('video')
        ? 'video'
        : !within(screen.getByTestId('play-chips-audio')).queryByText(/TrueHD/)
          ? 'audio'
          : !shown('source')
            ? 'source'
            : !shown('size')
              ? 'size'
              : 'all';
      if (steps[steps.length - 1] !== state) steps.push(state);
    }
    expect(steps).toEqual(['all', 'size', 'source', 'audio', 'video']);
  });

  it('shows the loading, none and error states in the same block', async () => {
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = never;
    await open('/movie/123');
    expect(await screen.findByTestId('play-chips-loading', {}, WAIT)).toBeOnTheScreen();
    cleanup();
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = () =>
      json(200, { workId: 'tmdb-movie-123', versions: [] });
    await open('/movie/123');
    expect(await screen.findByTestId('play-chips-none', {}, WAIT)).toHaveTextContent(
      /no playable version of this movie/
    );
    cleanup();
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = failure;
    await open('/movie/123');
    expect(await screen.findByTestId('play-chips-reasons', {}, WAIT)).toHaveTextContent(
      /Versions not loaded/
    );
    expect(screen.getByTestId('play-chips-method')).toHaveTextContent('Unchecked');
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
      json(200, {
        seasonNumber: 1,
        title: 'Season 1',
        seriesTitle: 'Sherlock',
        episodes: [
          { workId: 'tmdb-tv-7-s01e01', episodeNumber: 1, title: 'Pink', watch: { played: true } },
        ],
      });
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

describe('Series Bühne', () => {
  const ep = (season: number, n: number, extra: Record<string, unknown> = {}) => ({
    workId: `tmdb-tv-7-s0${season}e0${n}`,
    episodeNumber: n,
    title: `S${season} Episode ${n}`,
    overview: `Overview of S${season}E${n}`,
    runtimeMinutes: 90,
    aired: true,
    watch: { played: false },
    ...extra,
  });
  const seasonOne = [
    ep(1, 1, { watch: { played: true } }),
    ep(1, 2, {
      watch: { played: false, positionTicks: 600_000_000, durationTicks: 54_000_000_000 },
    }),
    ep(1, 3),
    ep(1, 4, { versionCount: 0 }),
    ep(1, 5, { aired: false, airDate: '2027-01-12' }),
  ];
  const seasonTwo = [ep(2, 1, { watch: { played: true } }), ep(2, 2), ep(2, 3)];
  const series = {
    workId: 'tmdb-tv-7',
    tmdbId: 7,
    title: 'Sherlock',
    overview: 'A detective in London.',
    seasonCount: 2,
    episodeCount: 8,
    seasons: [
      { seasonNumber: 0, title: 'Specials', episodeCount: 1, airDate: '2016-01-01' },
      {
        seasonNumber: 1,
        title: 'Season 1',
        episodeCount: 5,
        playedCount: 1,
        airDate: '2010-07-25',
      },
      {
        seasonNumber: 2,
        title: 'Season 2',
        episodeCount: 3,
        playedCount: 1,
        airDate: '2012-01-01',
      },
    ],
    watch: {
      totalEpisodes: 8,
      playedEpisodes: 2,
      nextEpisode: {
        workId: 'tmdb-tv-7-s01e02',
        seasonNumber: 1,
        episodeNumber: 2,
        title: 'S1 Episode 2',
        positionTicks: 600_000_000,
        durationTicks: 54_000_000_000,
        reason: 'resume',
      },
    },
  };
  const versionsOf = (workId: string, method: string) => () =>
    json(200, {
      workId,
      versions: [{ ...version(1, true, method), resolution: '1080p', source: 'WEB-DL' }],
    });

  beforeEach(() => {
    handlers['/api/v1/viewer/catalog/series/7'] = () => json(200, series);
    const seasons: Record<number, unknown[]> = { 0: [ep(0, 1)], 1: seasonOne, 2: seasonTwo };
    for (const n of [0, 1, 2])
      handlers[`/api/v1/viewer/catalog/series/7/seasons/${n}`] = () =>
        json(200, {
          seasonNumber: n,
          title: `Season ${n}`,
          seriesTitle: 'Sherlock',
          episodes: seasons[n],
        });
    for (const episode of [...seasonOne, ...seasonTwo, ep(0, 1)])
      handlers[`/api/v1/viewer/catalog/works/${episode.workId}/versions`] = versionsOf(
        episode.workId,
        episode.episodeNumber === 3 ? 'transcode' : 'direct'
      );
    handlers['/api/v1/viewer/catalog/works/tmdb-tv-7-s01e04/versions'] = () =>
      json(200, { workId: 'tmdb-tv-7-s01e04', versions: [] });
  });

  const heading = () => screen.getByTestId('stage-heading');

  it('starts on the next episode with its buttons, chips and the strip marked', async () => {
    // Wide enough for the info column (narrow windows show a button instead).
    mockWindow = { width: 1366, height: 1024, scale: 2, fontScale: 1 };
    await open('/series/7');
    await waitFor(() => expect(heading()).toHaveTextContent('S1 Episode 2'), WAIT);
    expect(screen.getByText('Season 1 · Episode 2 · Up next')).toBeOnTheScreen();
    // One line, remounted per label: the episode number can never end up on a hidden second line.
    const pill = screen.getByTestId('stage-pill');
    expect(pill.props.numberOfLines).toBe(1);
    expect(screen.getByTestId('series-play')).toHaveTextContent('Resume');
    expect(screen.getByTestId('series-start-over')).toBeOnTheScreen();
    await waitFor(
      () => expect(screen.getByTestId('play-chips-method')).toHaveTextContent('Direct'),
      WAIT
    );
    expect(screen.getByTestId('episode-card-2-selected')).toBeOnTheScreen();
    expect(screen.queryByTestId('episode-card-1-selected')).toBeNull();
    expect(screen.getByTestId('series-episode-position')).toHaveTextContent('Episode 2 of 5');
    // Specials come last; the info column names the series.
    const chips = within(screen.getByTestId('series-seasons')).getAllByRole('button');
    expect(chips.map((chip) => chip.props.accessibilityLabel)).toEqual([
      'Season 1 · 1/5',
      'Season 2 · 1/3',
      'Specials',
    ]);
    expect(screen.getByTestId('series-info-progress')).toHaveTextContent('2 of 8 watched');
    expect(screen.getByTestId('detail-info')).toHaveTextContent(/2010 – 2016|2010 – 2012/);
  });

  it('shows every card state in the strip', async () => {
    await open('/series/7');
    const card = async (n: number) => screen.findByTestId(`episode-card-${n}`, {}, WAIT);
    expect(await card(1)).toHaveAccessibleName(/Watched/);
    expect(await card(2)).toHaveAccessibleName(/1 hr 29 min left|left.*Up next/);
    expect(await card(3)).toHaveAccessibleName(/Episode 3 · S1 Episode 3 · 1 h 30 min/);
    expect(await card(4)).toHaveAccessibleName(/No version/);
    expect(await card(5)).toHaveAccessibleName(/From/);
  });

  it('never navigates when episodes and seasons change (10 episode + 3 season changes)', async () => {
    const { router } = await open('/series/7');
    const { router: imperative } = jest.requireActual<typeof import('expo-router')>('expo-router');
    const spies = (['push', 'replace', 'setParams', 'navigate', 'back', 'dismiss'] as const).map(
      (name) => jest.spyOn(imperative, name)
    );
    const routeKeys = () => JSON.stringify(router.getRouterState()).match(/"key":"[^"]+"/g);
    await waitFor(() => expect(heading()).toHaveTextContent('S1 Episode 2'), WAIT);
    const before = routeKeys();
    const user = userEvent.setup();
    for (const n of [1, 3, 4, 5, 2, 1, 3, 2, 4, 1]) {
      await user.press(await screen.findByTestId(`episode-card-${n}`, {}, WAIT));
      await waitFor(() => expect(heading()).toHaveTextContent(`S1 Episode ${n}`), WAIT);
    }
    for (const n of [2, 0, 1]) {
      await user.press(screen.getByTestId(`season-${n}`));
      await waitFor(() => expect(heading()).toHaveTextContent(new RegExp(`S${n} Episode`)), WAIT);
    }
    expect(router.getPathname()).toBe('/series/7');
    expect(routeKeys()).toEqual(before);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    spies.forEach((spy) => spy.mockRestore());
  });

  it('updates the copy and the chip row for the selected episode, with a skeleton while loading', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    handlers['/api/v1/viewer/catalog/works/tmdb-tv-7-s01e03/versions'] = async () => {
      await gate;
      return versionsOf('tmdb-tv-7-s01e03', 'transcode')();
    };
    await open('/series/7');
    const user = userEvent.setup();
    await user.press(await screen.findByTestId('episode-card-3', {}, WAIT));
    await waitFor(() => expect(heading()).toHaveTextContent('S1 Episode 3'), WAIT);
    expect(screen.getByText('Overview of S1E3')).toBeOnTheScreen();
    expect(screen.getByTestId('series-play')).toHaveTextContent('Play');
    expect(screen.queryByTestId('series-start-over')).toBeNull();
    expect(await screen.findByTestId('play-chips-loading', {}, WAIT)).toBeOnTheScreen();
    await act(async () => release());
    await waitFor(
      () => expect(screen.getByTestId('play-chips-method')).toHaveTextContent('Transcoded'),
      WAIT
    );
    // No version: the main button is the inert note, the chip row the "none" state.
    await user.press(screen.getByTestId('episode-card-4'));
    await waitFor(() => expect(heading()).toHaveTextContent('S1 Episode 4'), WAIT);
    expect(await screen.findByTestId('series-no-versions', {}, WAIT)).toBeOnTheScreen();
    // Not aired: a note instead of Play and no chip row.
    await user.press(screen.getByTestId('episode-card-5'));
    await waitFor(() => expect(screen.getByTestId('series-not-aired')).toBeOnTheScreen(), WAIT);
    expect(screen.queryByTestId('play-chips')).toBeNull();
  });

  it('resets the selection to the first unwatched episode when the season changes', async () => {
    await open('/series/7');
    await waitFor(() => expect(heading()).toHaveTextContent('S1 Episode 2'), WAIT);
    await userEvent.setup().press(screen.getByTestId('season-2'));
    await waitFor(() => expect(heading()).toHaveTextContent('S2 Episode 2'), WAIT);
    expect(screen.getByText('Season 2 · Episode 2')).toBeOnTheScreen();
    expect(screen.getByTestId('episode-card-2-selected')).toBeOnTheScreen();
  });

  it('plays the marked episode from ▶ with its resume point', async () => {
    const { router } = await open('/series/7');
    const { router: imperative } = jest.requireActual<typeof import('expo-router')>('expo-router');
    const push = jest.spyOn(imperative, 'push');
    await userEvent.setup().press(await screen.findByTestId('episode-card-2-play', {}, WAIT));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    // The same spy the no-navigation test relies on sees a real navigation.
    expect(push).toHaveBeenCalledTimes(1);
    push.mockRestore();
    expect(router.getSearchParams()).toMatchObject({ workId: 'tmdb-tv-7-s01e02', start: '60' });
  });

  it('opens "About the series" from the info column; web keeps it in the page', async () => {
    // Wide enough for the info column (narrow windows show a button instead).
    mockWindow = { width: 1366, height: 1024, scale: 2, fontScale: 1 };
    const inPage = jest.spyOn(aboutSheetHost, 'inPage').mockReturnValue(true);
    const { router } = await open('/series/7');
    const user = userEvent.setup();
    const column = await screen.findByTestId('detail-info-open', {}, WAIT);
    expect(column).toHaveTextContent(/More about the series/);
    await user.press(column);
    const sheet = await screen.findByTestId('about-sheet', {}, WAIT);
    expect(within(sheet).getByTestId('about-facts')).toHaveTextContent(
      '2010 – 2012 · 2 seasons · 8 episodes'
    );
    expect(within(sheet).getByText('2 of 8 watched')).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/series/7');
    await user.press(within(sheet).getByTestId('about-sheet-close'));
    await waitFor(() => expect(screen.queryByTestId('about-sheet')).toBeNull());
    expect(router.getPathname()).toBe('/series/7');
    inPage.mockRestore();
  });

  it('shows ▶ on a hovered card (pointer) and hides it when the pointer leaves', async () => {
    await open('/series/7');
    const card = await screen.findByTestId('episode-card-3', {}, WAIT);
    expect(screen.queryByTestId('episode-card-3-play')).toBeNull();
    await act(async () => fireEvent(card, 'hoverIn'));
    expect(screen.getByTestId('episode-card-3-play')).toBeOnTheScreen();
    expect(screen.queryByTestId('episode-card-3-selected')).toBeNull();
    await act(async () => fireEvent(card, 'hoverOut'));
    await waitFor(() => expect(screen.queryByTestId('episode-card-3-play')).toBeNull());
    expect(screen.getByTestId('episode-card-2-play')).toBeOnTheScreen();
  });

  it('offers Resume · Start over · Versions on a long press (iPad context menu)', async () => {
    const menu = jest
      .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation(() => undefined);
    const { router } = await open('/series/7');
    const card = await screen.findByTestId('episode-card-2', {}, WAIT);
    await act(async () => fireEvent(card, 'longPress', { nativeEvent: { target: 42 } }));
    expect(menu).toHaveBeenCalledTimes(1);
    const [options, choose] = menu.mock.calls[0]!;
    expect(options).toMatchObject({
      options: ['Resume', 'Start over', 'Versions', 'Cancel'],
      cancelButtonIndex: 3,
      anchor: 42,
    });
    await act(async () => choose(1));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams()).toMatchObject({ workId: 'tmdb-tv-7-s01e02', start: '0' });
    menu.mockRestore();
  });

  it('keeps the strip cards while the next season loads (the focused card never vanishes)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    handlers['/api/v1/viewer/catalog/series/7/seasons/2'] = async () => {
      await gate;
      return json(200, {
        seasonNumber: 2,
        title: 'Season 2',
        seriesTitle: 'Sherlock',
        episodes: seasonTwo,
      });
    };
    await open('/series/7');
    await userEvent.setup().press(await screen.findByTestId('episode-strip-continue', {}, WAIT));
    expect(screen.queryByTestId('episode-strip-loading')).toBeNull();
    expect(screen.getByTestId('episode-strip-continue')).toBeOnTheScreen();
    expect(screen.getByTestId('episode-card-1')).toBeOnTheScreen();
    await act(async () => release());
    await waitFor(() => expect(heading()).toHaveTextContent('S2 Episode 2'), WAIT);
  });

  it('shortens the overview to two lines under a two-line episode title', async () => {
    await open('/series/7');
    await waitFor(() => expect(heading()).toHaveTextContent('S1 Episode 2'), WAIT);
    expect(screen.getByTestId('stage-overview')).toHaveProp('numberOfLines', 3);
    await act(async () => fireEvent(heading(), 'textLayout', { nativeEvent: { lines: [{}, {}] } }));
    expect(screen.getByTestId('stage-overview')).toHaveProp('numberOfLines', 2);
  });

  it('opens the season route as the Bühne with that season preselected', async () => {
    await open('/series/7/season/2');
    await waitFor(() => expect(heading()).toHaveTextContent('S2 Episode 2'), WAIT);
    expect(screen.getByTestId('season-2')).toBeSelected();
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
    // Bühne: no permanent panel; the sheet carries the cards.
    expect(screen.queryByTestId('version-panel')).toBeNull();
    await userEvent.setup().press(await screen.findByTestId('movie-versions', {}, WAIT));
    const card = await screen.findByTestId('version-2', {}, WAIT);
    expect(card).toHaveTextContent(/Recommended/);
    expect(card).toHaveTextContent(/Last played/);
  });

  it('plays the picked version', async () => {
    const { router } = await open('/movie/123');
    const user = userEvent.setup();
    await user.press(await screen.findByTestId('movie-versions', {}, WAIT));
    await user.press(await screen.findByTestId('version-1', {}, WAIT));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams()).toMatchObject({ releaseId: 'r1' });
  });

  it('a link to another movie over an open detail starts a fresh page (focus memory per route)', async () => {
    handlers['/api/v1/viewer/catalog/movies/456'] = () =>
      json(200, { ...movie, tmdbId: 456, workId: 'tmdb-movie-456', title: 'Wing It!' });
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-456/versions'] = () =>
      json(200, { workId: 'tmdb-movie-456', versions: [version(1, true, 'direct')] });
    await open('/movie/123');
    await screen.findByTestId('movie-play', {}, WAIT);
    const mounts = mockMovieMounts.count;
    await act(async () => appRouter.setParams({ id: '456' }));
    await screen.findByTestId('movie-play', {}, WAIT);
    expect(mockMovieMounts.count).toBe(mounts + 1);
  });

  it('shows a skeleton while versions load', async () => {
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = never;
    await open('/versions/tmdb-movie-123?title=Sintel');
    expect((await screen.findAllByTestId('versions-loading', {}, WAIT)).length).toBeGreaterThan(0);
  });

  it('keeps the main button and adds Versions only once the versions arrived (TV focus)', async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => (answer = resolve));
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = () =>
      pending.then((response) => response.clone());
    await open('/movie/123');
    const main = await screen.findByTestId('movie-play', {}, WAIT);
    expect(screen.queryByTestId('movie-versions')).toBeNull();
    await act(async () => answer(json(200, { workId: 'tmdb-movie-123', versions: [] })));
    const none = await screen.findByTestId('movie-no-versions', {}, WAIT);
    expect(none).toBe(main);
    expect(screen.queryByTestId('movie-versions')).toBeNull();
  });

  it('shows an error with retry', async () => {
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = failure;
    await open('/movie/123');
    await userEvent.setup().press(await screen.findByTestId('movie-versions', {}, WAIT));
    expect(await screen.findByTestId('versions-error', {}, WAIT)).toBeOnTheScreen();
  });
});

describe('Version sheet', () => {
  const routeCount = (router: { getRouterState(): unknown }) =>
    JSON.stringify(router.getRouterState()).match(/"key":/g)?.length ?? 0;

  it('opens the About sheet from the Details column with the full overview and credits', async () => {
    // Wide enough for the info column (narrow windows show a button instead).
    mockWindow = { width: 1366, height: 1024, scale: 2, fontScale: 1 };
    handlers['/api/v1/viewer/catalog/movies/123'] = () =>
      json(200, {
        ...movie,
        overview: 'A long overview. '.repeat(20).trim(),
        tagline: 'Hold your dragon.',
        runtimeMinutes: 14,
        genres: ['Animation', 'Fantasy', 'Adventure', 'Short'],
        voteAverage: 7.1,
        people: [
          { name: 'Colin Levy', type: 'Director', sortOrder: 0 },
          ...['A', 'B', 'C', 'D', 'E'].map((name, index) => ({
            name: `Actor ${name}`,
            type: 'Cast',
            sortOrder: index + 1,
          })),
        ],
      });
    const { router } = await open('/movie/123');
    const user = userEvent.setup();
    const column = await screen.findByTestId('detail-info-open', {}, WAIT);
    expect(column).toHaveTextContent(/All details/);
    await user.press(column);
    await waitFor(() => expect(router.getPathname()).toBe('/about/movie/123'));
    const sheet = await screen.findByTestId('about-sheet', {}, WAIT);
    expect(within(sheet).getByText('Details')).toBeOnTheScreen();
    expect(within(sheet).getByTestId('about-overview')).toHaveTextContent(/A long overview\./);
    expect(within(sheet).getByTestId('about-facts')).toHaveTextContent('2010 · 14 min');
    expect(within(sheet).getByText('Animation, Fantasy, Adventure, Short')).toBeOnTheScreen();
    // The sheet lists more cast than the column (up to 8).
    expect(
      within(sheet).getByText('Actor A, Actor B, Actor C, Actor D, Actor E')
    ).toBeOnTheScreen();
    await user.press(within(sheet).getByTestId('about-sheet-close'));
    await waitFor(() => expect(router.getPathname()).toBe('/movie/123'));
  });

  it('narrow windows (iPad portrait): the Details column becomes a button in the action row', async () => {
    mockWindow = { width: 820, height: 1180, scale: 2, fontScale: 1 };
    try {
      const { router } = await open('/movie/123');
      const button = await screen.findByTestId('detail-info-button', {}, WAIT);
      expect(screen.queryByTestId('detail-info')).toBeNull();
      expect(button).toHaveAccessibleName('All details');
      await userEvent.setup().press(button);
      await waitFor(() => expect(router.getPathname()).toBe('/about/movie/123'));
    } finally {
      mockWindow = undefined;
    }
  });

  it('opens versions/[workId] from "Versions · N" with both specs and the entry card', async () => {
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = () =>
      json(200, {
        workId: 'tmdb-movie-123',
        versions: [
          {
            ...version(1, false, 'transcode'),
            resolution: '2160p',
            hdrFormats: ['hdr10'],
            qualityRank: 1,
          },
          { ...version(2, true, 'remux'), resolution: '1080p', qualityRank: 2 },
        ],
      });
    const { router } = await open('/movie/123');
    const user = userEvent.setup();
    await waitFor(
      () => expect(screen.getByTestId('movie-versions')).toHaveAccessibleName('Versions · 2'),
      WAIT
    );
    await user.press(screen.getByTestId('movie-versions'));
    await waitFor(() => expect(router.getPathname()).toBe('/versions/tmdb-movie-123'));
    const sheet = await screen.findByTestId('version-sheet', {}, WAIT);
    const specs = await within(sheet).findByTestId('version-sheet-specs', {}, WAIT);
    expect(specs).toHaveTextContent(/Best picture.*4K · HDR10.*On this device.*1080p · SDR/);
    expect(within(screen.getByTestId('version-sheet-entry')).getByTestId('version-2')).toBeTruthy();
    await user.press(within(sheet).getByTestId('version-sheet-close'));
    await waitFor(() => expect(router.getPathname()).toBe('/movie/123'));
  });

  it('plays the picked version from the sheet with the resume point', async () => {
    handlers['/api/v1/viewer/catalog/movies/123'] = () =>
      json(200, {
        ...movie,
        watch: { ...movie.watch, positionTicks: 600_000_000, durationTicks: 9_000_000_000 },
      });
    const { router } = await open('/movie/123');
    const user = userEvent.setup();
    await user.press(await screen.findByTestId('movie-versions', {}, WAIT));
    const sheet = await screen.findByTestId('version-sheet', {}, WAIT);
    await user.press(await within(sheet).findByTestId('version-1', {}, WAIT));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams()).toMatchObject({ releaseId: 'r1', start: '60' });
  });

  it('shows loading, error with retry and empty states', async () => {
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = never;
    await open('/versions/tmdb-movie-123?title=Sintel');
    expect((await screen.findAllByTestId('versions-loading', {}, WAIT)).length).toBe(3);
    screen.unmount();

    let calls = 0;
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = () =>
      ++calls === 1 ? failure() : json(200, { workId: 'tmdb-movie-123', versions: [] });
    await open('/versions/tmdb-movie-123?title=Sintel');
    const user = userEvent.setup();
    const error = await screen.findByTestId('versions-error', {}, WAIT);
    await user.press(within(error).getByRole('button'));
    expect(await screen.findByTestId('versions-empty', {}, WAIT)).toBeOnTheScreen();
  });

  it('labels the entry "Details" for a single version', async () => {
    handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = () =>
      json(200, { workId: 'tmdb-movie-123', versions: [version(1, true, 'direct')] });
    await open('/movie/123');
    await waitFor(
      () => expect(screen.getByTestId('movie-versions')).toHaveAccessibleName('Details'),
      WAIT
    );
  });

  describe('web drawer', () => {
    let inPage: jest.SpyInstance;
    beforeEach(() => {
      inPage = jest.spyOn(versionSheetHost, 'inPage').mockReturnValue(true);
    });
    afterEach(() => inPage.mockRestore());

    it('opens and closes without a navigation or history entry', async () => {
      const { router } = await open('/movie/123');
      const user = userEvent.setup();
      const before = routeCount(router);
      await user.press(await screen.findByTestId('movie-versions', {}, WAIT));
      const sheet = await screen.findByTestId('version-sheet', {}, WAIT);
      expect(await within(sheet).findByTestId('version-2', {}, WAIT)).toBeOnTheScreen();
      expect(router.getPathname()).toBe('/movie/123');
      expect(routeCount(router)).toBe(before);
      await user.press(within(sheet).getByTestId('version-sheet-close'));
      await waitFor(() => expect(screen.queryByTestId('version-sheet')).toBeNull());
      expect(router.getPathname()).toBe('/movie/123');
      expect(routeCount(router)).toBe(before);
    });

    it('plays the picked version from the drawer', async () => {
      const { router } = await open('/movie/123');
      const user = userEvent.setup();
      await user.press(await screen.findByTestId('movie-versions', {}, WAIT));
      const sheet = await screen.findByTestId('version-sheet', {}, WAIT);
      await user.press(await within(sheet).findByTestId('version-1', {}, WAIT));
      await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
      expect(router.getSearchParams()).toMatchObject({ releaseId: 'r1' });
      expect(screen.queryByTestId('version-sheet')).toBeNull();
    });
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

  it('Resume on a phone starts the last played version its version card names', async () => {
    handlers['/api/v1/viewer/catalog/movies/123'] = () =>
      json(200, {
        ...movie,
        watch: {
          ...movie.watch,
          positionTicks: 60 * 10_000_000,
          durationTicks: 600 * 10_000_000,
          lastReleaseId: 'r1',
        },
      });
    const { router } = await open('/movie/123');
    const card = await screen.findByTestId('versions-summary', {}, WAIT);
    expect(card).toHaveTextContent(/Sintel\.2010\.1080p\.mkv/);
    expect(within(card).getByTestId('versions-summary-method')).toHaveTextContent('Transcode');
    expect(within(card).getByTestId('versions-summary-last')).toHaveTextContent('Last played');
    await userEvent.setup().press(screen.getByTestId('movie-play'));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams()).toMatchObject({ releaseId: 'r1', start: '60' });
  });

  it('names the recommendation on a phone when Play starts it', async () => {
    handlers['/api/v1/viewer/catalog/movies/123'] = () =>
      json(200, { ...movie, watch: { ...movie.watch, lastReleaseId: 'r1' } });
    const { router } = await open('/movie/123');
    const card = await screen.findByTestId('versions-summary', {}, WAIT);
    expect(card).toHaveTextContent(/Sintel\.2010\.2160p\.mkv/);
    expect(within(card).getByTestId('versions-summary-last')).toHaveTextContent(/Last played: /);
    await userEvent.setup().press(screen.getByTestId('movie-play'));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams().releaseId).toBeUndefined();
  });

  it('keeps the series episode list on phones (no Bühne strip)', async () => {
    handlers['/api/v1/viewer/catalog/series/7'] = () =>
      json(200, {
        workId: 'tmdb-tv-7',
        tmdbId: 7,
        title: 'Sherlock',
        seasons: [{ seasonNumber: 1, title: 'Season 1', episodeCount: 1 }],
        watch: { totalEpisodes: 1, playedEpisodes: 0, nextEpisode: null },
      });
    handlers['/api/v1/viewer/catalog/series/7/seasons/1'] = () =>
      json(200, {
        seasonNumber: 1,
        seriesTitle: 'Sherlock',
        episodes: [{ workId: 'tmdb-tv-7-s01e01', episodeNumber: 1, title: 'Pink', watch: {} }],
      });
    await open('/series/7');
    expect(await screen.findByTestId('episode-1', {}, WAIT)).toBeOnTheScreen();
    expect(screen.queryByTestId('episode-strip')).toBeNull();
    expect(screen.queryByTestId('stage-heading')).toBeNull();
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
