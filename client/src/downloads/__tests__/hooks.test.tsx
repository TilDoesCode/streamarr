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
import {
  useActiveDownloadCount,
  useDownloadFor,
  useDownloadsSupported,
  useLocalPlayTarget,
  useSeasonDownloads,
} from '../hooks';
import { createMemoryDownloadsStorage } from '../store';

const OWNER = 'http://dev.test#v-anna';

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
  const fetch = jest.fn(async (request: Request) =>
    new URL(request.url).pathname === '/api/v1/viewer/me'
      ? new Response(JSON.stringify({ id: 'v-anna', permissions }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      : new Response('{}', { status: 404 })
  );
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
});
