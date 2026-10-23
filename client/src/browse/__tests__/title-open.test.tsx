import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Text } from 'react-native';

import { accountKey } from '@/query/keys';

import type { DetailQueryContext } from '../queries';
import {
  catalogTitle,
  prefetchTitle,
  PREFETCH_DELAY_MS,
  previewKey,
  titleTargetHref,
  useOpenTitle,
  usePrefetchTitle,
  useTitlePreview,
} from '../title-open';

type Pending = { path: string; resolve: (body: unknown) => void };
let pending: Pending[] = [];

// The detail client: every GET waits until the test answers it.
const GET = jest.fn(
  (path: string, init: { params: { path: Record<string, number> } }) =>
    new Promise((resolve) => {
      const filled = path.replace(/\{(\w+)\}/g, (_, key: string) => String(init.params.path[key]));
      pending.push({ path: filled, resolve: (body) => resolve({ data: body, response: {} }) });
    })
);
const mockActive = { account: { id: 'a1' }, client: { GET } };
jest.mock('@/accounts/accounts-provider', () => ({ useActiveAccount: () => mockActive }));
jest.mock('@/api/client', () => ({
  unwrap: (request: Promise<{ data: unknown }>) => request.then((result) => result.data),
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const context = {
  accountId: 'a1',
  client: { GET },
  language: 'en',
  t: ((key: string) => key) as never,
} as unknown as DetailQueryContext;

const requested = () => pending.map((request) => request.path);
const answer = async (path: string, body: unknown) => {
  const request = pending.find((item) => item.path === path);
  if (!request) throw new Error(`no request for ${path}`);
  pending = pending.filter((item) => item !== request);
  await act(async () => request.resolve(body));
};

const series = (next?: { seasonNumber: number; episodeNumber: number }) => ({
  tmdbId: 7,
  title: 'Sherlock',
  seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }],
  watch: { nextEpisode: next ? { workId: 'w', ...next } : null },
});

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  pending = [];
  GET.mockClear();
  mockPush.mockClear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, retry: false } },
  });
});
afterEach(() => queryClient.clear());

describe('prefetchTitle', () => {
  it('loads a movie detail once; a fresh cache entry is not fetched again', async () => {
    const done = prefetchTitle(queryClient, context, { kind: 'movie', tmdbId: 3 });
    expect(requested()).toEqual(['/api/v1/viewer/catalog/movies/3']);
    await answer('/api/v1/viewer/catalog/movies/3', { tmdbId: 3, title: 'Sintel' });
    await done;
    await prefetchTitle(queryClient, context, { kind: 'movie', tmdbId: 3 });
    expect(GET).toHaveBeenCalledTimes(1);
  });

  it('a deep-linked season loads alongside the series, not after it', async () => {
    const done = prefetchTitle(queryClient, context, {
      kind: 'series',
      tmdbId: 7,
      season: 2,
      episode: 3,
    });
    expect(requested().sort()).toEqual([
      '/api/v1/viewer/catalog/series/7',
      '/api/v1/viewer/catalog/series/7/seasons/2',
    ]);
    await answer('/api/v1/viewer/catalog/series/7', series());
    await answer('/api/v1/viewer/catalog/series/7/seasons/2', { seasonNumber: 2, episodes: [] });
    await done;
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it('without a deep link the season the page opens on follows from the series (its next episode)', async () => {
    const done = prefetchTitle(queryClient, context, { kind: 'series', tmdbId: 7 });
    expect(requested()).toEqual(['/api/v1/viewer/catalog/series/7']);
    await answer('/api/v1/viewer/catalog/series/7', series({ seasonNumber: 3, episodeNumber: 1 }));
    expect(requested()).toEqual(['/api/v1/viewer/catalog/series/7/seasons/3']);
    await answer('/api/v1/viewer/catalog/series/7/seasons/3', { seasonNumber: 3, episodes: [] });
    await done;
    // The same keys the screens read: the page finds both in the cache.
    expect(queryClient.getQueryData(accountKey('a1', 'catalog', 'series', 7, 'en'))).toBeTruthy();
    expect(
      queryClient.getQueryData(accountKey('a1', 'catalog', 'series', 7, 'season', 3, 'en'))
    ).toBeTruthy();
  });
});

describe('usePrefetchTitle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('debounces focus: a D-pad sweep loads only the card the focus rests on', async () => {
    const { result } = await renderHook(() => usePrefetchTitle(), { wrapper });
    await act(() => {
      result.current.schedule({ kind: 'movie', tmdbId: 1 });
      jest.advanceTimersByTime(PREFETCH_DELAY_MS / 2);
      result.current.schedule({ kind: 'movie', tmdbId: 2 });
      jest.advanceTimersByTime(PREFETCH_DELAY_MS - 1);
    });
    expect(GET).not.toHaveBeenCalled();
    await act(async () => void jest.advanceTimersByTime(1));
    expect(requested()).toEqual(['/api/v1/viewer/catalog/movies/2']);
  });

  it('cancel (blur) and unmount drop a pending prefetch', async () => {
    const { result, unmount } = await renderHook(() => usePrefetchTitle(), { wrapper });
    await act(() => {
      result.current.schedule({ kind: 'movie', tmdbId: 1 });
      result.current.cancel();
      jest.advanceTimersByTime(PREFETCH_DELAY_MS * 2);
    });
    await act(() => result.current.schedule({ kind: 'movie', tmdbId: 2 }));
    await unmount();
    await act(async () => void jest.advanceTimersByTime(PREFETCH_DELAY_MS * 2));
    expect(GET).not.toHaveBeenCalled();
  });
});

describe('useOpenTitle', () => {
  const item = {
    workId: 'tmdb-tv-7',
    mediaType: 'tv',
    tmdbId: 7,
    title: 'Sherlock',
    year: 2010,
    backdropUrl: 'https://img/backdrop.jpg',
    overview: 'A detective.',
  } as Parameters<typeof catalogTitle>[0];

  it('pushes in the same press while the detail is still loading, and seeds the preview', async () => {
    const { result } = await renderHook(() => ({ open: useOpenTitle() }), { wrapper });
    const { target, preview } = catalogTitle(item);
    await act(() => result.current.open(target, preview));
    expect(mockPush).toHaveBeenCalledWith(titleTargetHref(target));
    // The queries already run, nothing was awaited.
    expect(requested()).toEqual(['/api/v1/viewer/catalog/series/7']);
    expect(queryClient.getQueryData(previewKey('a1', 'series', 7))).toMatchObject({
      title: 'Sherlock',
      backdropUrl: 'https://img/backdrop.jpg',
      year: 2010,
    });
  });

  it('the detail reads the seeded preview for its first frame', async () => {
    queryClient.setQueryData(previewKey('a1', 'movie', 3), { title: 'Sintel' });
    function Probe() {
      return <Text testID="probe">{useTitlePreview('movie', 3)?.title ?? 'none'}</Text>;
    }
    await render(<Probe />, { wrapper });
    expect(screen.getByTestId('probe')).toHaveTextContent('Sintel');
  });

  it('series targets keep their episode deep link', async () => {
    expect(titleTargetHref({ kind: 'series', tmdbId: 7, season: 2, episode: 3 })).toEqual({
      pathname: '/series/[id]',
      params: { id: '7', season: '2', episode: '3' },
    });
    expect(titleTargetHref({ kind: 'movie', tmdbId: 3, season: 1 })).toEqual({
      pathname: '/movie/[id]',
      params: { id: '3' },
    });
  });
});
