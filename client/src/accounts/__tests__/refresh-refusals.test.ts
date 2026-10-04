import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { parseEndedReason } from '@/accounts/ended-reason';
import { AccountSession } from '@/accounts/session';
import { createMemoryVault } from '@/accounts/types';

const BASE = 'http://server.test';
const HOUR = 3_600_000;

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

/** A signed-in device whose next refresh gets `answer` (B11 refresh refusals). */
async function refusedWith(answer: unknown) {
  const store = new AccountStore({
    storage: memoryStorage(),
    vault: createMemoryVault(),
    newId: () => 'acc1',
  });
  await store.addSignedIn(
    { url: BASE, name: 'Dev World' },
    { id: 'v-anna', username: 'anna', displayName: 'Anna', mustChangePassword: false },
    {
      sessionId: 's1',
      accessToken: 'sva_1',
      accessExpiresAt: Date.now() - 1,
      refreshToken: 'svr_1',
      refreshExpiresAt: Date.now() + 30 * 24 * HOUR,
    }
  );
  const fetch = jest.fn(
    async () =>
      new Response(JSON.stringify(answer), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
  );
  const ended: string[] = [];
  store.onSessionEnded((_account, reason) => ended.push(reason));
  const session = new AccountSession('acc1', store, { baseUrl: BASE, fetch });
  const error = await session.accessToken().catch((caught: unknown) => caught);
  return { store, ended, error };
}

describe("refresh refusals end the session with the server's reason (B11, F8 S7)", () => {
  it('keeps the revoke reason, so the picker and the sign-in screen can say why', async () => {
    const { store, ended, error } = await refusedWith({
      error: {
        code: 'refresh_session_revoked',
        message: 'The viewer session was ended. Sign in again.',
        params: { reason: 'session_limit' },
      },
    });
    expect(error).toMatchObject({ code: 'refresh_session_revoked', status: 401 });
    expect(store.get('acc1')).toMatchObject({
      signedIn: false,
      endedReason: 'refresh_session_revoked:session_limit',
    });
    expect(ended).toEqual(['refresh_session_revoked:session_limit']);
    expect(parseEndedReason(ended[0]!)).toEqual({
      code: 'refresh_session_revoked',
      params: { reason: 'session_limit' },
    });
  });

  it.each(['refresh_token_unknown', 'refresh_session_expired', 'refresh_token_reused'])(
    'stores %s as it is',
    async (code) => {
      const { store } = await refusedWith({ error: { code, message: 'refused' } });
      expect(store.get('acc1')).toMatchObject({ signedIn: false, endedReason: code });
    }
  );

  it('an older server\'s plain 401 ("unauthorized", no reason) gets the neutral "signed out" text', async () => {
    const { store } = await refusedWith({ error: { code: 'unauthorized', message: 'no session' } });
    expect(store.get('acc1')).toMatchObject({ signedIn: false, endedReason: 'session_ended' });
  });

  it('ignores a reason that is not a plain word (stored values stay parseable)', async () => {
    const { store } = await refusedWith({
      error: { code: 'refresh_session_revoked', message: 'x', params: { reason: 'a:b c' } },
    });
    expect(store.get('acc1')).toMatchObject({ endedReason: 'refresh_session_revoked' });
  });
});
