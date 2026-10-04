import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountSession } from '@/accounts/session';
import type { SessionTokens } from '@/accounts/types';
import { tokenVault } from '@/accounts/vault';

const mockSecureStore = {
  items: new Map<string, string>(),
  failReads: false,
  removed: [] as string[],
};

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: jest.fn(async (key: string) => {
    // What expo-secure-store throws for a Keystore/Keychain system error (it returns null for a lost key itself).
    if (mockSecureStore.failReads) throw new Error('DecryptException: Keystore operation failed');
    return mockSecureStore.items.get(key) ?? null;
  }),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStore.items.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStore.removed.push(key);
    mockSecureStore.items.delete(key);
  }),
}));

const HOUR = 3_600_000;
const BASE = 'http://server.test';

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function tokens(n: number, accessExpiresAt: number): SessionTokens {
  return {
    sessionId: 's1',
    accessToken: `sva_${n}`,
    accessExpiresAt,
    refreshToken: `svr_${n}`,
    refreshExpiresAt: Date.now() + 30 * 24 * HOUR,
  };
}

/** A device that signed in earlier: tokens in the (mocked) Keychain/Keystore, a fresh app process. */
async function device(accessExpiresAt: number) {
  mockSecureStore.items.clear();
  mockSecureStore.removed = [];
  mockSecureStore.failReads = false;
  const storage = memoryStorage();
  const first = new AccountStore({ storage, vault: tokenVault, newId: () => 'acc1' });
  await first.addSignedIn(
    { url: BASE, name: 'Dev World' },
    { id: 'v-anna', username: 'anna', displayName: 'Anna', mustChangePassword: false },
    tokens(1, accessExpiresAt)
  );
  const fetch = jest.fn(async () =>
    json(200, {
      sessionId: 's1',
      tokenType: 'Bearer',
      accessToken: 'sva_2',
      accessExpiresAt: new Date(Date.now() + HOUR).toISOString(),
      refreshToken: 'svr_2',
      refreshExpiresAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
      cookieMode: false,
    })
  );
  const store = new AccountStore({ storage, vault: tokenVault, newId: () => 'acc1' });
  const session = new AccountSession('acc1', store, { baseUrl: BASE, fetch });
  return { store, session, fetch };
}

describe('a Keychain/Keystore read error is not "signed out" (F8 S6, Android "Your session has ended")', () => {
  it('fails the request as transient, keeps the account signed in and the tokens stored', async () => {
    const { store, session } = await device(Date.now() + HOUR);
    mockSecureStore.failReads = true;
    await expect(session.accessToken()).rejects.toMatchObject({
      code: 'token_storage_unavailable',
      isTransient: true,
    });
    expect(store.get('acc1')).toMatchObject({ signedIn: true });
    expect(mockSecureStore.removed).toEqual([]);
    mockSecureStore.failReads = false;
    await expect(session.accessToken()).resolves.toBe('sva_1');
  });

  it('a refresh whose fresh vault read fails uses the pair this process already holds', async () => {
    const { store, session, fetch } = await device(Date.now() + HOUR);
    await expect(session.accessToken()).resolves.toBe('sva_1');
    mockSecureStore.failReads = true;
    await expect(session.refreshAfter('sva_1')).resolves.toBe('sva_2');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.get('acc1')).toMatchObject({ signedIn: true });
    expect(mockSecureStore.removed).toEqual([]);
  });

  it('an entry that is really gone (no item) still ends the session on this device', async () => {
    const { store, session } = await device(Date.now() + HOUR);
    mockSecureStore.items.clear();
    await expect(session.accessToken()).rejects.toMatchObject({ code: 'session_ended' });
    expect(store.get('acc1')).toMatchObject({ signedIn: false, endedReason: 'session_ended' });
  });
});
