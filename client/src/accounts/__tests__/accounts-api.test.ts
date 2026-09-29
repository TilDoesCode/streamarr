import { QueryClient } from '@tanstack/react-query';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { createAccountsApi } from '@/accounts/accounts-api';
import { signInFlow } from '@/accounts/sign-in-flow';
import { createMemoryVault, type SessionTokens } from '@/accounts/types';
import { deleteAccountCache } from '@/query/persist';

jest.mock('@/query/persist', () => ({
  ...jest.requireActual('@/query/persist'),
  deleteAccountCache: jest.fn(),
}));

const SERVER = { url: 'http://server.test', name: 'Test' };
const HOUR = 3_600_000;

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

const tokens = (n: number): SessionTokens => ({
  sessionId: `session-${n}`,
  accessToken: `sva_${n}`,
  accessExpiresAt: Date.now() + HOUR,
  refreshToken: `svr_${n}`,
  refreshExpiresAt: Date.now() + 30 * 24 * HOUR,
});

const viewer = (id: string, username: string) => ({
  id,
  username,
  displayName: username,
  mustChangePassword: false,
});

function setup() {
  const logouts: { refreshToken: string; auth: string | null }[] = [];
  const fetch = jest.fn(async (input: Request) => {
    if (input.url.endsWith('/api/v1/viewer/auth/logout')) {
      const body = (await input.json()) as { refreshToken: string };
      logouts.push({ refreshToken: body.refreshToken, auth: input.headers.get('Authorization') });
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  let n = 0;
  const vault = createMemoryVault();
  const store = new AccountStore({
    storage: memoryStorage(),
    vault,
    newId: () => `acc${(n += 1)}`,
  });
  const queryClient = new QueryClient();
  const onChosen = jest.fn();
  const api = createAccountsApi({ store, queryClient, fetch, onChosen });
  return { api, store, vault, queryClient, fetch, logouts, onChosen };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('account actions', () => {
  it('completeSignIn stores the account, activates it and marks the profile as chosen', async () => {
    const { api, store, onChosen } = setup();
    const anna = await api.completeSignIn(SERVER, viewer('v1', 'anna'), tokens(1));
    expect(store.getSnapshot().activeId).toBe(anna.id);
    expect(onChosen).toHaveBeenCalledTimes(1);
  });

  it('switching profiles clears the whole query cache (keys stay partitioned by account)', async () => {
    const { api, queryClient } = setup();
    const anna = await api.completeSignIn(SERVER, viewer('v1', 'anna'), tokens(1));
    const ben = await api.completeSignIn(SERVER, viewer('v2', 'ben'), tokens(2));
    queryClient.setQueryData(['account', anna.id, 'catalog', 'discover'], ['anna rows']);
    queryClient.setQueryData(['account', ben.id, 'catalog', 'discover'], ['ben rows']);
    api.activate(anna.id);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('signing in again ends the replaced session on the server', async () => {
    const { api, store, logouts } = setup();
    const first = await api.completeSignIn(SERVER, viewer('v1', 'anna'), tokens(1));
    const again = await api.completeSignIn(SERVER, viewer('v1', 'anna'), tokens(2));
    await flush();
    expect(again.id).toBe(first.id);
    expect(logouts).toEqual([{ refreshToken: 'svr_1', auth: 'Bearer sva_1' }]);
    await expect(store.readTokens(first.id)).resolves.toMatchObject({ refreshToken: 'svr_2' });
  });

  it('sign-out keeps the profile, forgets tokens and its queries, and ends the server session', async () => {
    const { api, store, queryClient, logouts } = setup();
    const anna = await api.completeSignIn(SERVER, viewer('v1', 'anna'), tokens(1));
    queryClient.setQueryData(['account', anna.id, 'me'], { username: 'anna' });
    await api.signOut(anna.id);
    await flush();
    expect(store.get(anna.id)).toMatchObject({ signedIn: false });
    await expect(store.readTokens(anna.id)).resolves.toBeNull();
    expect(queryClient.getQueryData(['account', anna.id, 'me'])).toBeUndefined();
    expect(logouts).toEqual([{ refreshToken: 'svr_1', auth: 'Bearer sva_1' }]);
  });

  it('sign-out forgets a password kept for a forced change', async () => {
    const { api } = setup();
    const anna = await api.completeSignIn(SERVER, viewer('v1', 'anna'), tokens(1));
    signInFlow.rememberPassword(anna.id, 'streamarr');
    await api.signOut(anna.id);
    expect(signInFlow.takePassword(anna.id)).toBeUndefined();
  });

  it('sign-out ends the pair another tab rotated to', async () => {
    const { api, store, vault, logouts } = setup();
    const anna = await api.completeSignIn(SERVER, viewer('v1', 'anna'), tokens(1));
    // The shared vault moved on; this tab's memory still has the first pair.
    await store.readTokens(anna.id);
    await vault.set(anna.id, tokens(2));
    await api.signOut(anna.id);
    await flush();
    expect(logouts).toEqual([{ refreshToken: 'svr_2', auth: 'Bearer sva_2' }]);
  });

  it('remove forgets the profile and deletes its persisted cache', async () => {
    const { api, store } = setup();
    const anna = await api.completeSignIn(SERVER, viewer('v1', 'anna'), tokens(1));
    const ben = await api.completeSignIn(SERVER, viewer('v2', 'ben'), tokens(2));
    await api.remove(anna.id);
    expect(store.get(anna.id)).toBeUndefined();
    expect(store.get(ben.id)).toBeDefined();
    expect(deleteAccountCache).toHaveBeenCalledWith(anna.id);
  });

  it('gives every account its own client', async () => {
    const { api } = setup();
    const anna = await api.completeSignIn(SERVER, viewer('v1', 'anna'), tokens(1));
    const ben = await api.completeSignIn(SERVER, viewer('v2', 'ben'), tokens(2));
    expect(api.clientFor(anna.id)).toBe(api.clientFor(anna.id));
    expect(api.clientFor(anna.id)).not.toBe(api.clientFor(ben.id));
    expect(() => api.clientFor('missing')).toThrow();
  });
});
