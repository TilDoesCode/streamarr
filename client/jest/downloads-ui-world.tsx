import { QueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { act, renderRouter } from 'expo-router/testing-library';
import type { ReactNode } from 'react';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import type { OfflineDownload } from '@/downloads';
import { setLanguagePreference } from '@/i18n';
import { DesignProvider } from '@/theme';

import { appRoutes } from './app-routes';
import {
  createTestDownloads,
  DownloadsTestProvider,
  fakeOfflineDownload,
  seedDownloads,
  type TestDownloads,
} from './downloads';

/** Fake viewer server, a signed-in profile (anna @ dev.test = TEST_ACCOUNT_KEY) and the download core with fakes. */
export type Handler = (url: URL, request: Request) => Response | Promise<Response>;
export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export const WAIT = { timeout: 5000 };
export const GB = 1024 ** 3;

export const movie = {
  workId: 'tmdb-movie-123',
  tmdbId: 123,
  title: 'Sintel',
  year: 2010,
  watch: { workId: 'tmdb-movie-123', kind: 'movie', played: false },
  access: { allowed: true },
};
export const version = (rank: number, patch: Record<string, unknown> = {}) => ({
  releaseId: `r${rank}`,
  rank,
  name: `Sintel.2010.${rank === 1 ? '1080p' : '2160p'}.WEB-DL.mkv`,
  resolution: rank === 1 ? '1080p' : '2160p',
  videoCodec: 'hevc',
  source: 'WEB-DL',
  recommended: rank === 1,
  predictedMethod: 'direct',
  health: null,
  ...patch,
});

const ep = (season: number, n: number) => ({
  workId: `tmdb-tv-7-s0${season}e0${n}`,
  episodeNumber: n,
  title: `S${season} Episode ${n}`,
  runtimeMinutes: 50,
  aired: true,
  watch: { played: false },
});
export const series = {
  workId: 'tmdb-tv-7',
  tmdbId: 7,
  title: 'Sherlock',
  seasonCount: 1,
  episodeCount: 3,
  seasons: [{ workId: 'tmdb-tv-7-s01', seasonNumber: 1, title: 'Season 1', episodeCount: 3 }],
  watch: {
    totalEpisodes: 3,
    playedEpisodes: 0,
    nextEpisode: {
      workId: 'tmdb-tv-7-s01e01',
      seasonNumber: 1,
      episodeNumber: 1,
      title: 'S1 Episode 1',
      reason: 'start',
    },
  },
};

export const world = {
  handlers: {} as Record<string, Handler>,
  downloads: null as TestDownloads | null,
};

async function fakeServer(input: Request): Promise<Response> {
  const url = new URL(input.url);
  const handler = world.handlers[`${input.method} ${url.pathname}`] ?? world.handlers[url.pathname];
  if (handler) return handler(url, input);
  return json(404, { error: { code: 'not_found', message: 'nope' } });
}

const baseHandlers = (): Record<string, Handler> => ({
  '/api/v1/viewer/catalog/discover': () => json(200, { rows: [] }),
  '/api/v1/viewer/watch/resume': () => json(200, []),
  '/api/v1/viewer/watch/next-up': () => json(200, { items: [] }),
  '/api/v1/viewer/list/summary': () =>
    json(200, { newCount: 0, total: 0, wantToWatch: 0, watching: 0, caughtUp: 0, watched: 0 }),
  '/api/v1/viewer/catalog/movies/123': () => json(200, movie),
  '/api/v1/viewer/catalog/works/tmdb-movie-123/versions': () =>
    json(200, { workId: 'tmdb-movie-123', versions: [version(1), version(2)] }),
  '/api/v1/viewer/catalog/series/7': () => json(200, series),
  '/api/v1/viewer/catalog/series/7/seasons/1': () =>
    json(200, {
      workId: 'tmdb-tv-7-s01',
      seriesWorkId: 'tmdb-tv-7',
      seasonNumber: 1,
      title: 'Season 1',
      seriesTitle: 'Sherlock',
      episodes: [ep(1, 1), ep(1, 2), ep(1, 3)],
    }),
  ...Object.fromEntries(
    [1, 2, 3].map((n) => [
      `/api/v1/viewer/catalog/works/tmdb-tv-7-s01e0${n}/versions`,
      () => json(200, { workId: `tmdb-tv-7-s01e0${n}`, versions: [version(1)] }),
    ])
  ),
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

export function Providers({ children }: { children: ReactNode }) {
  return (
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider store={store} queryClient={queryClient!} fetch={fakeServer}>
          {world.downloads ? (
            <DownloadsTestProvider test={world.downloads}>{children}</DownloadsTestProvider>
          ) : (
            children
          )}
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

/** Signs anna in (the store only); `open` renders the app, `Providers` wraps a single component. */
export async function signIn() {
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
}

export async function open(initialUrl: string) {
  await signIn();
  const router = renderRouter({ _layout: RootLayout, ...appRoutes }, { initialUrl });
  await router;
  return { router };
}

/** Fresh server, store and download core (with `seed` on the device) before each test. */
export async function resetWorld(seed: Partial<OfflineDownload>[] = []) {
  world.handlers = baseHandlers();
  store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
  global.fetch = jest.fn(fakeServer) as unknown as typeof fetch;
  world.downloads = createTestDownloads();
  seedDownloads(
    world.downloads,
    seed.map((patch) => fakeOfflineDownload(patch))
  );
  await act(async () => {
    await setLanguagePreference('en');
  });
}

export function clearWorld() {
  queryClient?.clear();
  world.downloads = null;
}
