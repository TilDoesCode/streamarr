import { QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { AccountStore } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import { DesignProvider } from '@/theme';

import {
  createTestDownloads,
  DownloadsTestProvider,
  fakeOfflineDownload,
  seedDownloads,
} from '../../../jest/downloads';
import { useDownloadCandidates } from '../candidates';
import {
  useActiveDownloadCount,
  useDownloadFor,
  useDownloadsSupported,
  useLocalPlayTarget,
  useSeasonDownloads,
} from '../hooks';
import { createMemoryDownloadsStorage } from '../store';

const OWNER = 'http://dev.test#v-anna';
const GB = 1024 ** 3;
const requests: Record<string, unknown>[] = [];
const candidate = (releaseId: string, sizeBytes: number, playable: boolean) => ({
  version: { releaseId, name: releaseId, rank: 1 },
  offline: { playable, engine: playable ? 'native' : null, reasons: [] },
  sizeBytes,
  sizeExact: releaseId !== 'big',
  sizeSource: 'resolved',
  seasonPack: false,
  recommended: releaseId === 'small',
});
const CANDIDATES = {
  workId: 'tmdb-movie-603',
  mediaType: 'movie',
  candidates: [
    candidate('small', 2 * GB, true),
    candidate('big', 30 * GB, true),
    candidate('remux', GB, false),
  ],
  streamOnlyCount: 1,
  checkedAt: '2026-11-06T10:00:00Z',
};

async function setup(permissions: Record<string, unknown> = {}) {
  const store = new AccountStore({
    storage: createMemoryDownloadsStorage(),
    vault: createMemoryVault(),
  });
  const anna = await store.addSignedIn(
    { url: 'http://dev.test', name: 'Dev World' },
    { id: 'v-anna', username: 'anna', displayName: 'Anna', mustChangePassword: false },
    {
      sessionId: 's1',
      accessToken: 'a',
      accessExpiresAt: Date.now() + 3_600_000,
      refreshToken: 'r',
      refreshExpiresAt: Date.now() + 3_600_000,
    }
  );
  store.setActive(anna.id);
  const answer = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const fetch = jest.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/viewer/me') return answer({ id: 'v-anna', permissions });
    if (path === '/api/v1/viewer/downloads/candidates') {
      requests.push(JSON.parse(await request.text()));
      return answer(CANDIDATES);
    }
    return new Response('{}', { status: 404 });
  });
  const test = createTestDownloads();
  seedDownloads(test, [
    fakeOfflineDownload({ id: 'e1', accountKey: OWNER, workId: 'tmdb-tv-5-s01e01' }),
    fakeOfflineDownload({
      id: 'e2',
      accountKey: OWNER,
      workId: 'tmdb-tv-5-s01e02',
      state: 'downloading',
      bytesWritten: 512,
      sizeBytes: 1024,
    }),
    fakeOfflineDownload({
      id: 'x',
      accountKey: 'http://dev.test#v-ben',
      workId: 'tmdb-tv-5-s01e03',
    }),
  ]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider store={store} queryClient={queryClient} fetch={fetch}>
          <DownloadsTestProvider test={test}>{children}</DownloadsTestProvider>
        </AccountsProvider>
      </ToastProvider>
    </DesignProvider>
  );
  return { wrapper, test, queryClient };
}

describe('download hooks', () => {
  it('a download being removed is shown by useDownloadFor but counts nowhere', async () => {
    const { wrapper, test, queryClient } = await setup();
    const { result } = await renderHook(
      () => ({ season: useSeasonDownloads('tmdb-tv-5-s1'), badge: useActiveDownloadCount() }),
      { wrapper }
    );
    const before = result.current;
    seedDownloads(test, [
      fakeOfflineDownload({
        id: 'e4',
        accountKey: OWNER,
        workId: 'tmdb-tv-5-s01e04',
        state: 'removing',
        sizeBytes: GB,
        bytesWritten: GB / 2,
      }),
    ]);
    const removing = await renderHook(
      () => ({
        work: useDownloadFor('tmdb-tv-5-s01e04'),
        season: useSeasonDownloads('tmdb-tv-5-s1'),
        badge: useActiveDownloadCount(),
      }),
      { wrapper }
    );
    expect(removing.result.current.work).toMatchObject({ state: 'removing', playable: false });
    expect(removing.result.current.season).toMatchObject({
      downloaded: before.season.downloaded,
      inProgress: before.season.inProgress,
      failed: before.season.failed,
      bytes: before.season.bytes,
    });
    expect(removing.result.current.badge).toBe(before.badge);
    queryClient.clear();
  });

  it('report a work, a season and the badge count for the active profile only', async () => {
    const { wrapper, queryClient } = await setup();
    const { result } = await renderHook(
      () => ({
        done: useDownloadFor('tmdb-tv-5-s01e01'),
        running: useDownloadFor('tmdb-tv-5-s01e02'),
        other: useDownloadFor('tmdb-tv-5-s01e03'),
        season: useSeasonDownloads('tmdb-tv-5-s1'),
        badge: useActiveDownloadCount(),
        local: useLocalPlayTarget('tmdb-tv-5-s01e01'),
      }),
      { wrapper }
    );
    expect(result.current.done).toMatchObject({ state: 'done', playable: true, progress: 1 });
    expect(result.current.running).toMatchObject({ state: 'downloading', progress: 0.5 });
    expect(result.current.other.download).toBeNull();
    expect(result.current.season).toMatchObject({ downloaded: 1, inProgress: 1, failed: 0 });
    expect(result.current.badge).toBe(1);
    expect(result.current.local).toMatchObject({
      engine: 'native',
      uri: expect.stringMatching(/^file:\/\/.*tmdb-tv-5-s01e01\.mkv$/),
    });
    queryClient.clear();
  });

  it('downloads are supported until the admin turns them off for the viewer', async () => {
    const allowed = await setup({ allowDownloads: true });
    const on = await renderHook(() => useDownloadsSupported(), { wrapper: allowed.wrapper });
    expect(on.result.current).toEqual({ supported: true, reason: null });
    allowed.queryClient.clear();

    const denied = await setup({ allowDownloads: false });
    const off = await renderHook(() => useDownloadsSupported(), { wrapper: denied.wrapper });
    await waitFor(() =>
      expect(off.result.current).toEqual({ supported: false, reason: 'permission' })
    );
    denied.queryClient.clear();
  });

  it('candidates carry a space verdict that counts what queued downloads still need', async () => {
    const { wrapper, test, queryClient } = await setup();
    test.engine.controls.setStorage({ freeBytes: 10 * GB });
    const { result } = await renderHook(() => useDownloadCandidates('tmdb-movie-603'), { wrapper });
    await waitFor(() => expect(result.current.data?.candidates).toHaveLength(3), { timeout: 5000 });
    const [small, big] = result.current.data!.candidates;
    // 10 GB free − 512 bytes the running episode still needs − 256 MiB reserve.
    expect(small!.space).toMatchObject({ fits: true, estimate: false });
    expect(big!.space).toMatchObject({ fits: false, estimate: true });
    expect(big!.space.missingBytes).toBe(30 * GB - big!.space.availableBytes);
    expect(result.current.data!.downloadable.map((item) => item.version.releaseId)).toEqual([
      'small',
      'big',
    ]);
    expect(requests.at(-1)).toMatchObject({ workId: 'tmdb-movie-603', engine: 'auto' });
    queryClient.clear();
  });
});
