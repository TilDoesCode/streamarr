import { QueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { act, renderRouter } from 'expo-router/testing-library';
import type { ReactNode } from 'react';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import { setLanguagePreference } from '@/i18n';
import { DesignProvider } from '@/theme';

import { appRoutes } from './app-routes';

/** Fake viewer server and app shell for the My List screen tests. */
export type Handler = (url: URL, request: Request) => Response | Promise<Response>;
export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export const noContent = () => new Response(null, { status: 204 });
export const WAIT = { timeout: 5000 };

const added = '2026-10-01T10:00:00Z';
export const ITEMS = [
  {
    workId: 'tmdb-tv-600',
    kind: 'series',
    tmdbId: 600,
    title: 'Weekly Show',
    status: 'watching',
    source: 'auto',
    isNew: true,
    newEpisodeWorkId: 'tmdb-tv-600-s01e04',
    playedEpisodes: 3,
    totalEpisodes: 4,
    nextEpisode: {
      workId: 'tmdb-tv-600-s01e04',
      seasonNumber: 1,
      episodeNumber: 4,
      reason: 'next',
      available: true,
    },
    addedAt: added,
  },
  {
    workId: 'tmdb-movie-701',
    kind: 'movie',
    tmdbId: 701,
    title: 'List Movie',
    year: 2024,
    status: 'watching',
    source: 'manual',
    positionTicks: 30,
    durationTicks: 60,
    addedAt: added,
  },
  {
    workId: 'tmdb-movie-702',
    kind: 'movie',
    tmdbId: 702,
    title: 'Later Movie',
    status: 'want_to_watch',
    source: 'manual',
    addedAt: added,
  },
  {
    workId: 'tmdb-tv-720',
    kind: 'series',
    tmdbId: 720,
    title: 'Season Show',
    status: 'caught_up',
    source: 'auto',
    playedEpisodes: 10,
    totalEpisodes: 10,
    upcomingEpisode: {
      workId: 'tmdb-tv-720-s02e01',
      seasonNumber: 2,
      episodeNumber: 1,
      reason: 'upcoming',
      airDate: '2026-11-01',
    },
    addedAt: added,
  },
  {
    workId: 'tmdb-tv-710-s01',
    kind: 'season',
    tmdbId: 710,
    seasonNumber: 1,
    title: 'Season 1',
    seriesTitle: 'Ended Show',
    status: 'watched',
    source: 'manual',
    playedEpisodes: 2,
    totalEpisodes: 2,
    addedAt: added,
  },
];

const movie = {
  workId: 'tmdb-movie-123',
  tmdbId: 123,
  title: 'Sintel',
  year: 2010,
  watch: { workId: 'tmdb-movie-123', kind: 'movie', played: false },
  access: { allowed: true },
};

/** The fake server's routes ('GET /path' or '/path') and every request it saw ('METHOD /path'). */
export const world = { handlers: {} as Record<string, Handler>, requests: [] as string[] };

async function fakeServer(input: Request): Promise<Response> {
  const url = new URL(input.url);
  world.requests.push(`${input.method} ${url.pathname}`);
  const handler = world.handlers[`${input.method} ${url.pathname}`] ?? world.handlers[url.pathname];
  if (handler) return handler(url, input);
  return json(404, { error: { code: 'not_found', message: 'nope' } });
}

const baseHandlers = (): Record<string, Handler> => ({
  '/api/v1/viewer/list': () => json(200, { items: ITEMS, total: ITEMS.length, incomplete: false }),
  '/api/v1/viewer/list/summary': () =>
    json(200, { newCount: 1, total: 5, wantToWatch: 1, watching: 2, caughtUp: 1, watched: 1 }),
  '/api/v1/viewer/watch/resume': () => json(200, []),
  '/api/v1/viewer/watch/next-up': () => json(200, { items: [] }),
  '/api/v1/viewer/catalog/movies/123': () => json(200, movie),
  '/api/v1/viewer/catalog/works/tmdb-movie-123/versions': () =>
    json(200, { workId: 'tmdb-movie-123', versions: [] }),
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
let queryClient: QueryClient | undefined;

function Providers({ children }: { children: ReactNode }) {
  return (
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider store={store} queryClient={queryClient!} fetch={fakeServer}>
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

/** Signs anna in and renders the app at `initialUrl` (large shell unless the test overrides the window). */
export async function open(initialUrl: string) {
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
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = renderRouter({ _layout: RootLayout, ...appRoutes }, { initialUrl });
  await router;
  // Wrapped: returning the thenable from an async function would unwrap it.
  return { router };
}

/** Fresh routes, account store and language before each test. */
export async function resetWorld() {
  world.handlers = baseHandlers();
  world.requests = [];
  store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
  global.fetch = jest.fn(fakeServer) as unknown as typeof fetch;
  await act(async () => {
    await setLanguagePreference('en');
  });
}

/** The badge polls: a finished test's client must not keep its interval running. */
export function clearWorld() {
  queryClient?.clear();
}
