import { QueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';

import { AccountStore } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import { createMemoryDownloadsStorage } from '@/downloads/store';
import { DesignProvider } from '@/theme';

import {
  createTestDownloads,
  DownloadsTestProvider,
  fakeOfflineDownload,
  seedDownloads,
} from '../../../../jest/downloads';
import { SignInDownloadsHint } from '../sign-in-downloads-hint';

const OWNER = 'http://dev.test#v-anna';

async function renderHint(login: string) {
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
  await store.signOut(anna.id, 'refresh_session_revoked:admin');
  const test = createTestDownloads();
  seedDownloads(test, [
    fakeOfflineDownload({
      id: 'waiting',
      accountKey: OWNER,
      workId: 'tmdb-movie-603',
      state: 'waiting_server',
      error: { code: 'signed_out', at: 1, status: 401 },
    }),
    fakeOfflineDownload({
      id: 'queued',
      accountKey: OWNER,
      workId: 'tmdb-movie-604',
      state: 'queued',
    }),
    fakeOfflineDownload({ id: 'done', accountKey: OWNER, workId: 'tmdb-movie-605' }),
    fakeOfflineDownload({
      id: 'ben',
      accountKey: 'http://dev.test#v-ben',
      workId: 'tmdb-movie-606',
      state: 'waiting_server',
    }),
  ]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider store={store} queryClient={queryClient} fetch={jest.fn()}>
          <DownloadsTestProvider test={test}>
            <SignInDownloadsHint serverUrl="http://dev.test/" login={login} />
          </DownloadsTestProvider>
        </AccountsProvider>
      </ToastProvider>
    </DesignProvider>
  );
  queryClient.clear();
}

describe('sign-in downloads hint', () => {
  it("says how many of the profile's unfinished downloads continue after the sign-in", async () => {
    await renderHint(' Anna ');
    expect(screen.getByTestId('sign-in-downloads-waiting')).toHaveTextContent(
      '2 downloads continue after you sign in again.'
    );
  });

  it('stays hidden for another login or a profile without unfinished downloads', async () => {
    await renderHint('carl');
    expect(screen.queryByTestId('sign-in-downloads-waiting')).toBeNull();
  });
});
