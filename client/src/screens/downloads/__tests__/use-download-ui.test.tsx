import { QueryClient } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { AccountStore } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import { PROGRESS_NOTIFY_MS, createMemoryDownloadsStorage } from '@/downloads/store';
import { DesignProvider } from '@/theme';

import {
  createTestDownloads,
  DownloadsTestProvider,
  fakeOfflineDownload,
  seedDownloads,
} from '../../../../jest/downloads';
import {
  useDownloadsTab,
  useLocalDownload,
  useSeasonDownloadsUi,
  useWorkDownloadUi,
} from '../use-download-ui';

const OWNER = 'http://dev.test#v-anna';

async function setup() {
  const accounts = new AccountStore({
    storage: createMemoryDownloadsStorage(),
    vault: createMemoryVault(),
  });
  const anna = await accounts.addSignedIn(
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
  accounts.setActive(anna.id);
  const test = createTestDownloads();
  seedDownloads(test, [
    fakeOfflineDownload({ id: 'e1', accountKey: OWNER, workId: 'tmdb-tv-5-s01e01' }),
    fakeOfflineDownload({
      id: 'e2',
      accountKey: OWNER,
      workId: 'tmdb-tv-5-s01e02',
      state: 'downloading',
      completedAt: null,
      bytesWritten: 100,
      sizeBytes: 1000,
    }),
  ]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetch = jest.fn(async () => new Response('{}', { status: 404 }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider store={accounts} queryClient={queryClient} fetch={fetch}>
          <DownloadsTestProvider test={test}>{children}</DownloadsTestProvider>
        </AccountsProvider>
      </ToastProvider>
    </DesignProvider>
  );
  return { wrapper, test, queryClient };
}

/** Renders `hook` and counts its renders. */
async function counted<T>(hook: () => T, wrapper: (props: { children: ReactNode }) => ReactNode) {
  const renders = { count: 0 };
  const view = await renderHook(
    () => {
      renders.count += 1;
      return hook();
    },
    { wrapper }
  );
  return { renders, result: view.result };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, PROGRESS_NOTIFY_MS + 100));
  });

describe('download UI hooks re-render only for their own value', () => {
  it('a progress tick moves the live card, not the badge, the season count or a finished title', async () => {
    const { wrapper, test, queryClient } = await setup();
    const tab = await counted(() => useDownloadsTab(), wrapper);
    const season = await counted(() => useSeasonDownloadsUi('tmdb-tv-5-s1'), wrapper);
    const finished = await counted(() => useLocalDownload('tmdb-tv-5-s01e01'), wrapper);
    const page = await counted(() => useWorkDownloadUi('tmdb-tv-5-s01e01'), wrapper);
    const card = await counted(
      () => useWorkDownloadUi('tmdb-tv-5-s01e02', { live: true }),
      wrapper
    );
    await settle();
    expect(tab.result.current).toEqual({ visible: true, count: 1 });
    expect(season.result.current).toEqual({ downloaded: 1, inProgress: 1, failed: 0 });
    expect(finished.result.current?.download.id).toBe('e1');
    const before = [tab, season, finished, page].map((item) => item.renders.count);

    await act(async () => {
      test.store.update('e2', { bytesWritten: 600 }, { persist: false });
    });
    expect(card.result.current.progress).toBeCloseTo(0.6);
    await settle();
    expect([tab, season, finished, page].map((item) => item.renders.count)).toEqual(before);

    await act(async () => {
      test.store.update('e2', { state: 'done', bytesWritten: 1000, completedAt: Date.now() });
    });
    await settle();
    expect(tab.result.current.count).toBe(0);
    expect(season.result.current).toEqual({ downloaded: 2, inProgress: 0, failed: 0 });
    expect(card.result.current.download?.state).toBe('done');
    queryClient.clear();
  });
});
