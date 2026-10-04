import { QueryClient } from '@tanstack/react-query';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { createAccountsApi } from '@/accounts/accounts-api';
import type { SessionTokens } from '@/accounts/types';
import { tokenVault } from '@/accounts/vault';

const mockSecureStore = {
  items: new Map<string, string>(),
  failReads: false,
  failDeletes: false,
};

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: jest.fn(async (key: string) => {
    if (mockSecureStore.failReads) throw new Error('DecryptException: Keystore operation failed');
    return mockSecureStore.items.get(key) ?? null;
  }),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStore.items.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    if (mockSecureStore.failDeletes) throw new Error('DeleteException: Keystore operation failed');
    mockSecureStore.items.delete(key);
  }),
}));

jest.mock('@/query/persist', () => ({
  ...jest.requireActual('@/query/persist'),
  deleteAccountCache: jest.fn(),
}));

const SERVER = { url: 'http://server.test', name: 'Dev World' };
const HOUR = 3_600_000;
const ANNA = { id: 'v-anna', username: 'anna', displayName: 'Anna', mustChangePassword: false };

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

const stored = (id: string) => mockSecureStore.items.get(`streamarr.tokens.${id}`);

/** anna signed in earlier; a new app process whose Keystore now fails every read. */
async function relaunchedWithBrokenStorage() {
  mockSecureStore.items.clear();
  mockSecureStore.failReads = false;
  mockSecureStore.failDeletes = false;
  const storage = memoryStorage();
  const first = new AccountStore({ storage, vault: tokenVault, newId: () => 'acc1' });
  await first.addSignedIn(SERVER, ANNA, tokens(1));
  const logouts: string[] = [];
  const fetch = jest.fn(async (input: Request) => {
    if (input.url.endsWith('/api/v1/viewer/auth/logout'))
      logouts.push(((await input.json()) as { refreshToken: string }).refreshToken);
    return new Response(null, { status: 204 });
  });
  const store = new AccountStore({ storage, vault: tokenVault, newId: () => 'acc1' });
  const api = createAccountsApi({ store, queryClient: new QueryClient(), fetch });
  mockSecureStore.failReads = true;
  return { store, api, logouts };
}

describe('sign-out and sign-in while the secure storage cannot be read (F8 S7, S6 follow-up)', () => {
  it('signs out locally even though the tokens cannot be read', async () => {
    const { store, api, logouts } = await relaunchedWithBrokenStorage();
    await expect(api.signOut('acc1')).resolves.toBeUndefined();
    expect(store.get('acc1')).toMatchObject({ signedIn: false });
    expect(stored('acc1')).toBeUndefined();
    // Nothing to send without the refresh token: the server session ends by expiry or by "sign out other devices".
    expect(logouts).toEqual([]);
  });

  it('signs out locally even when deleting the stored pair fails too', async () => {
    const { store, api } = await relaunchedWithBrokenStorage();
    mockSecureStore.failDeletes = true;
    await expect(api.signOut('acc1')).resolves.toBeUndefined();
    expect(store.get('acc1')).toMatchObject({ signedIn: false });
    await expect(store.readTokens('acc1')).rejects.toMatchObject({
      code: 'token_storage_unavailable',
    });
  });

  it('a pair this process still holds is ended on the server and dropped from memory', async () => {
    const { store, api, logouts } = await relaunchedWithBrokenStorage();
    mockSecureStore.failReads = false;
    await store.readTokens('acc1');
    mockSecureStore.failReads = true;
    await api.signOut('acc1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logouts).toEqual(['svr_1']);
    expect(store.get('acc1')).toMatchObject({ signedIn: false });
    mockSecureStore.failReads = false;
    expect(await store.readTokens('acc1')).toBeNull();
  });

  it('signing in again overwrites the old pair cleanly', async () => {
    const { store, api } = await relaunchedWithBrokenStorage();
    await expect(api.completeSignIn(SERVER, ANNA, tokens(2))).resolves.toMatchObject({
      id: 'acc1',
      signedIn: true,
    });
    expect(JSON.parse(stored('acc1') ?? '{}')).toMatchObject({ refreshToken: 'svr_2' });
    expect(await store.readTokens('acc1')).toMatchObject({ refreshToken: 'svr_2' });
  });
});
