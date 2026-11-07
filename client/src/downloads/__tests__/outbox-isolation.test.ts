import { QueryClient } from '@tanstack/react-query';

import { AccountStore } from '@/accounts/account-store';
import { createAccountsApi } from '@/accounts/accounts-api';
import { createMemoryVault } from '@/accounts/types';
import { downloadAccountKey } from '@/downloads/keys';
import { createAppDownloadManager } from '@/downloads/provider';
import { createMemoryDownloadsStorage } from '@/downloads/store';

import { createTestDownloads } from '../../../jest/downloads';

/** DL-C-verify2 positive check: each profile's outbox only ever uses its own owner's token. */
it('outboxes for two servers with the same viewer and download ids use only their owner token even while another profile is active', async () => {
  const store = new AccountStore({
    storage: createMemoryDownloadsStorage(),
    vault: createMemoryVault(),
  });
  const add = (host: string, accessToken: string) =>
    store.addSignedIn(
      { url: `http://${host}.test`, name: host },
      { id: 'viewer', username: host, displayName: host, mustChangePassword: false },
      {
        sessionId: host,
        accessToken,
        refreshToken: `refresh-${host}`,
        accessExpiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 86_400_000,
      }
    );
  const a = await add('server-a', 'token-a');
  const b = await add('server-b', 'token-b');
  const sent: { origin: string; token: string | null }[] = [];
  const queryClient = new QueryClient();
  const api = createAccountsApi({
    store,
    queryClient,
    fetch: async (request) => {
      if (request.method === 'DELETE') {
        sent.push({
          origin: new URL(request.url).origin,
          token: request.headers.get('Authorization'),
        });
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ items: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  api.activate(b.id);
  const test = createTestDownloads();
  const manager = createAppDownloadManager(api, test.engine, test.store, test.artwork);
  try {
    test.store.setPendingDeletes(
      [a, b].map((account) => ({ accountKey: downloadAccountKey(account), downloadId: 'same-id' }))
    );
    await manager.reconcileServers();
    expect(sent).toEqual(
      expect.arrayContaining([
        { origin: 'http://server-a.test', token: 'Bearer token-a' },
        { origin: 'http://server-b.test', token: 'Bearer token-b' },
      ])
    );
    expect(sent).toHaveLength(2);
    expect(test.store.pendingDeletes()).toEqual([]);
    await store.signOut(a.id);
    test.store.setPendingDeletes([{ accountKey: downloadAccountKey(a), downloadId: 'signed-out' }]);
    await manager.reconcileServers();
    expect(sent).toHaveLength(2);
    expect(test.store.pendingDeletes()).toHaveLength(1);
  } finally {
    manager.dispose();
    queryClient.clear();
  }
});
