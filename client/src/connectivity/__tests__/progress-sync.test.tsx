import { QueryClient } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react-native';

import { AccountStore } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import { createMemoryDownloadsStorage } from '@/downloads/store';
import { enqueueProgress, pendingProgress } from '@/player/progress-queue';
import { DesignProvider } from '@/theme';

import { ConnectivityMonitor } from '../monitor';
import { ProgressSync } from '../progress-sync';
import { ConnectivityProvider } from '../provider';

const report = (seconds: number) => ({
  event: 'stop',
  workId: 'tmdb-movie-603',
  playbackId: `local-${seconds}`,
  positionTicks: seconds * 10_000_000,
});

it('C1-24: the mounted ProgressSync sends queued progress at launch and again on reconnect', async () => {
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
  const sent: { occurredAt?: string }[] = [];
  const fetch = jest.fn(async (request: Request) => {
    if (new URL(request.url).pathname === '/api/v1/viewer/watch/progress') {
      sent.push(JSON.parse(await request.text()));
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 404 });
  });
  let healthy = true;
  const monitor = new ConnectivityMonitor({ probe: async () => healthy });
  const queryClient = new QueryClient();
  enqueueProgress(anna.id, report(10), Date.parse('2026-11-01T10:00:00Z'));
  const view = await render(
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider store={store} queryClient={queryClient} fetch={fetch}>
          <ConnectivityProvider enabled monitor={monitor}>
            <ProgressSync />
          </ConnectivityProvider>
        </AccountsProvider>
      </ToastProvider>
    </DesignProvider>
  );
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]!.occurredAt).toBe('2026-11-01T10:00:00.000Z');

  healthy = false;
  await act(() => monitor.retry());
  expect(monitor.offline).toBe(true);
  enqueueProgress(anna.id, report(20), Date.parse('2026-11-02T10:00:00Z'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(sent).toHaveLength(1);

  healthy = true;
  await act(() => monitor.retry());
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]!.occurredAt).toBe('2026-11-02T10:00:00.000Z');
  expect(pendingProgress(anna.id)).toBe(0);
  monitor.stop();
  queryClient.clear();
  await view.unmount();
});
