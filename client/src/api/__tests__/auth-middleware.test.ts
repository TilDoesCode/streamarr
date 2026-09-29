import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountSession, EXPIRY_SKEW_MS } from '@/accounts/session';
import { createMemoryVault, type SessionTokens } from '@/accounts/types';
import { createApiClient, unwrap } from '@/api/client';
import { AppError } from '@/api/errors';

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

function tokens(n: number, now: number, accessMs = HOUR): SessionTokens {
  return {
    sessionId: 'session-1',
    accessToken: `sva_${n}`,
    accessExpiresAt: now + accessMs,
    refreshToken: `svr_${n}`,
    refreshExpiresAt: now + 30 * 24 * HOUR,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type RefreshMode = 'rotate' | 'reused' | 'expired' | 'offline';

/** A tiny viewer server: one valid access token, refresh rotation with a configurable outcome. */
function fakeServer(now: () => number) {
  const state = {
    validAccess: 'sva_1',
    refreshToken: 'svr_1',
    generation: 1,
    refreshCalls: 0,
    refreshMode: 'rotate' as RefreshMode,
    seen: [] as { path: string; auth: string | null; body: string }[],
  };
  const fetch = jest.fn(async (input: Request): Promise<Response> => {
    const path = new URL(input.url).pathname;
    const body = input.method === 'GET' ? '' : await input.text();
    state.seen.push({ path, auth: input.headers.get('Authorization'), body });
    if (path === '/api/v1/viewer/auth/refresh') {
      state.refreshCalls += 1;
      // Let every concurrent 401 arrive while this refresh is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (state.refreshMode === 'offline') throw new TypeError('Network request failed');
      if (state.refreshMode === 'reused')
        return json(401, { error: { code: 'refresh_token_reused', message: 'reused' } });
      if (state.refreshMode === 'expired')
        return json(401, { error: { code: 'refresh_session_expired', message: 'expired' } });
      const presented = (JSON.parse(body) as { refreshToken: string }).refreshToken;
      if (presented !== state.refreshToken)
        return json(401, { error: { code: 'refresh_token_reused', message: 'reused' } });
      state.generation += 1;
      const next = tokens(state.generation, now());
      state.validAccess = next.accessToken;
      state.refreshToken = next.refreshToken;
      return json(200, {
        sessionId: next.sessionId,
        tokenType: 'Bearer',
        accessToken: next.accessToken,
        accessExpiresAt: new Date(next.accessExpiresAt).toISOString(),
        refreshToken: next.refreshToken,
        refreshExpiresAt: new Date(next.refreshExpiresAt).toISOString(),
        cookieMode: false,
      });
    }
    if (input.headers.get('Authorization') !== `Bearer ${state.validAccess}`)
      return json(401, { error: { code: 'unauthorized', message: 'no session' } });
    if (path === '/api/v1/viewer/me') return json(200, { id: 'v1', username: 'anna' });
    if (path === '/api/v1/viewer/me/password')
      return json(403, { error: { code: 'password_change_required', message: 'change' } });
    if (path === '/api/v1/viewer/watch/state') return json(200, JSON.parse(body));
    return json(404, { error: { code: 'not_found', message: 'nope' } });
  });
  return { state, fetch };
}

/** Mimics expo/fetch (RN's global fetch): a response object that is not `instanceof Response`. */
function foreign(response: Response): Response {
  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    headers: response.headers,
    text: () => response.text(),
    json: () => response.json(),
  } as unknown as Response;
}

async function setup({
  accessMs = HOUR,
  expoFetch = false,
}: { accessMs?: number; expoFetch?: boolean } = {}) {
  let clock = Date.parse('2026-09-29T12:00:00Z');
  const now = () => clock;
  const vault = createMemoryVault();
  const storage = memoryStorage();
  const store = new AccountStore({ storage, vault, now, newId: () => 'acc1' });
  await store.addSignedIn(
    { url: BASE, name: 'Test' },
    { id: 'v1', username: 'anna', displayName: 'Anna', mustChangePassword: false },
    tokens(1, clock, accessMs)
  );
  const server = fakeServer(now);
  const fetch = expoFetch
    ? async (input: Request) => foreign(await server.fetch(input))
    : server.fetch;
  const session = new AccountSession('acc1', store, { baseUrl: BASE, fetch, now });
  const client = createApiClient({ baseUrl: BASE, session, fetch });
  const ended = jest.fn();
  store.onSessionEnded(ended);
  return {
    store,
    storage,
    vault,
    server,
    client,
    ended,
    advance: (ms: number) => (clock += ms),
    me: () => unwrap(client.GET('/api/v1/viewer/me')),
  };
}

describe('auth middleware', () => {
  it('attaches the bearer token', async () => {
    const { me, server } = await setup();
    await expect(me()).resolves.toMatchObject({ username: 'anna' });
    expect(server.state.seen[0]).toMatchObject({ path: '/api/v1/viewer/me', auth: 'Bearer sva_1' });
    expect(server.state.refreshCalls).toBe(0);
  });

  it('answers concurrent 401s with exactly one refresh and replays every request', async () => {
    const { me, server, vault } = await setup();
    server.state.validAccess = 'sva_revoked_on_server';
    const results = await Promise.all([me(), me(), me(), me(), me()]);
    expect(results).toHaveLength(5);
    expect(server.state.refreshCalls).toBe(1);
    const replays = server.state.seen.filter(
      (entry) => entry.path === '/api/v1/viewer/me' && entry.auth === 'Bearer sva_2'
    );
    expect(replays).toHaveLength(5);
    expect(vault.entries.get('acc1')).toMatchObject({
      accessToken: 'sva_2',
      refreshToken: 'svr_2',
    });
  });

  it('a later 401 with the already replaced token does not refresh again', async () => {
    const { me, server } = await setup();
    server.state.validAccess = 'sva_revoked_on_server';
    await me();
    await me();
    expect(server.state.refreshCalls).toBe(1);
  });

  it('replays the request body after a refresh', async () => {
    const { client, server } = await setup();
    server.state.validAccess = 'sva_revoked_on_server';
    const body = { workIds: ['tmdb-movie-1', 'tmdb-movie-2'] };
    await expect(unwrap(client.POST('/api/v1/viewer/watch/state', { body }))).resolves.toEqual(
      body
    );
    const posts = server.state.seen.filter((entry) => entry.path === '/api/v1/viewer/watch/state');
    expect(posts.map((entry) => JSON.parse(entry.body))).toEqual([body, body]);
  });

  it('refresh_token_reused signs the account out and fails every waiting request', async () => {
    const { me, server, store, vault, ended } = await setup();
    server.state.validAccess = 'sva_revoked_on_server';
    server.state.refreshMode = 'reused';
    const results = await Promise.allSettled([me(), me(), me()]);
    expect(server.state.refreshCalls).toBe(1);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        code: 'refresh_token_reused',
      });
    }
    expect(store.get('acc1')).toMatchObject({
      signedIn: false,
      endedReason: 'refresh_token_reused',
    });
    expect(vault.entries.has('acc1')).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
    // Nothing is sent once the session is gone, and the first reason stays.
    const before = server.state.seen.length;
    await expect(me()).rejects.toMatchObject({ code: 'session_ended' });
    expect(server.state.seen.length).toBe(before);
    expect(store.get('acc1')).toMatchObject({ endedReason: 'refresh_token_reused' });
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('a tab whose account was signed out in another tab fails quietly', async () => {
    const { me, server, store, storage, vault, ended } = await setup();
    await me();
    // Another tab (same storage and vault) signed out; the server ended the session.
    await new AccountStore({ storage, vault }).signOut('acc1');
    server.state.validAccess = 'sva_ended';
    server.state.refreshToken = 'svr_ended';
    await expect(me()).rejects.toMatchObject({ code: 'session_ended' });
    expect(server.state.refreshCalls).toBe(0);
    expect(store.get('acc1')).toMatchObject({ signedIn: false });
    expect(store.get('acc1')?.endedReason).toBeUndefined();
    expect(ended).not.toHaveBeenCalled();
  });

  it('an expired or revoked refresh session signs the account out', async () => {
    const { me, server, store } = await setup();
    server.state.validAccess = 'sva_revoked_on_server';
    server.state.refreshMode = 'expired';
    await expect(me()).rejects.toMatchObject({ code: 'refresh_session_expired' });
    expect(store.get('acc1')).toMatchObject({ signedIn: false });
  });

  it('a refresh that cannot reach the server keeps the session', async () => {
    const { me, server, store, vault } = await setup();
    server.state.validAccess = 'sva_revoked_on_server';
    server.state.refreshMode = 'offline';
    const error = await me().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'network_unreachable', status: 0 });
    expect(store.get('acc1')).toMatchObject({ signedIn: true });
    expect(vault.entries.get('acc1')).toMatchObject({ refreshToken: 'svr_1' });
  });

  it('refreshes before the request when the access token is about to expire', async () => {
    const { me, server } = await setup({ accessMs: EXPIRY_SKEW_MS - 1_000 });
    await me();
    expect(server.state.seen.map((entry) => entry.path)).toEqual([
      '/api/v1/viewer/auth/refresh',
      '/api/v1/viewer/me',
    ]);
    expect(server.state.seen[1]?.auth).toBe('Bearer sva_2');
  });

  it('adopts tokens another tab already rotated instead of replaying the old refresh token', async () => {
    const { me, server, vault, advance } = await setup();
    // Another tab rotated: the server and the shared vault moved on, this tab's memory did not.
    await me();
    server.state.validAccess = 'sva_9';
    server.state.refreshToken = 'svr_9';
    advance(1_000);
    await vault.set('acc1', { ...tokens(9, Date.parse('2026-09-29T12:00:01Z')) });
    await expect(me()).resolves.toMatchObject({ username: 'anna' });
    expect(server.state.refreshCalls).toBe(0);
  });

  it('replays through a fetch whose responses are not `instanceof Response` (expo/fetch)', async () => {
    const { me, server, client, store } = await setup({ expoFetch: true });
    server.state.validAccess = 'sva_revoked_on_server';
    await expect(Promise.all([me(), me(), me()])).resolves.toHaveLength(3);
    expect(server.state.refreshCalls).toBe(1);
    await expect(
      unwrap(
        client.POST('/api/v1/viewer/me/password', {
          body: { currentPassword: 'a', newPassword: 'b' },
        })
      )
    ).rejects.toMatchObject({ code: 'password_change_required' });
    expect(store.get('acc1')).toMatchObject({ mustChangePassword: true });
  });

  it('403 password_change_required flags the account', async () => {
    const { client, store } = await setup();
    await expect(
      unwrap(
        client.POST('/api/v1/viewer/me/password', {
          body: { currentPassword: 'a', newPassword: 'b' },
        })
      )
    ).rejects.toMatchObject({ code: 'password_change_required', status: 403 });
    expect(store.get('acc1')).toMatchObject({ mustChangePassword: true });
  });
});
