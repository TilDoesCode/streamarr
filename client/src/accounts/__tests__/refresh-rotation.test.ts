import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountSession } from '@/accounts/session';
import { createMemoryVault, type SessionTokens, type TokenVault } from '@/accounts/types';
import { AppError } from '@/api/errors';
import type { FetchLike } from '@/api/http';

const BASE = 'http://server.test';
const HOUR = 3_600_000;
const GRACE_MS = 30_000;

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

/** ViewerSessionService.RefreshAsync: current + previous hash, replay of the last rotation within the grace. */
function rotatingServer(clock: { now: number }, options: { replayUnconfirmed?: boolean } = {}) {
  const state = {
    current: 'svr_1',
    previous: undefined as string | undefined,
    access: 'sva_1',
    rotatedAt: undefined as number | undefined,
    confirmed: true,
    generation: 1,
    revoked: undefined as string | undefined,
    loseNextResponses: 0,
    /** How a lost answer looks to the client: the timeout fetch gives up, or a 200 arrives without a JSON body. */
    lossKind: 'timeout' as 'timeout' | 'garbled',
    /** Connection refused before anything reaches the server (offline). */
    unreachable: false,
    usedAccess: [] as string[],
  };
  const pair = () => ({
    sessionId: 'session-1',
    tokenType: 'Bearer',
    accessToken: state.access,
    accessExpiresAt: new Date(clock.now + HOUR).toISOString(),
    refreshToken: state.current,
    refreshExpiresAt: new Date(clock.now + 30 * 24 * HOUR).toISOString(),
    cookieMode: false,
  });
  const answer = (response: Response) => {
    if (state.loseNextResponses === 0) return response;
    state.loseNextResponses -= 1;
    if (state.lossKind === 'garbled') return new Response('{"accessTok', { status: 200 });
    throw new AppError('timeout');
  };
  const fetch = jest.fn(async (input: Request): Promise<Response> => {
    if (state.unreachable) throw new AppError('network_unreachable');
    const path = new URL(input.url).pathname;
    if (path !== '/api/v1/viewer/auth/refresh') {
      const auth = input.headers.get('Authorization');
      state.usedAccess.push(auth ?? '');
      if (auth === `Bearer ${state.access}`) state.confirmed = true;
      return json(200, {});
    }
    const presented = (JSON.parse(await input.text()) as { refreshToken: string }).refreshToken;
    if (state.revoked) return json(401, { error: { code: 'unauthorized', message: 'revoked' } });
    if (presented === state.previous) {
      const withinGrace = state.rotatedAt !== undefined && clock.now - state.rotatedAt <= GRACE_MS;
      if (withinGrace || (options.replayUnconfirmed && !state.confirmed))
        return answer(json(200, pair()));
      state.revoked = 'refresh_token_reuse';
      return json(401, { error: { code: 'refresh_token_reused', message: 'reused' } });
    }
    if (presented !== state.current)
      return json(401, { error: { code: 'unauthorized', message: 'unknown' } });
    state.generation += 1;
    state.previous = presented;
    state.current = `svr_${state.generation}`;
    state.access = `sva_${state.generation}`;
    state.rotatedAt = clock.now;
    state.confirmed = false;
    return answer(json(200, pair()));
  });
  return { state, fetch };
}

const expired = (now: number): SessionTokens => ({
  sessionId: 'session-1',
  accessToken: 'sva_1',
  accessExpiresAt: now - 1,
  refreshToken: 'svr_1',
  refreshExpiresAt: now + 30 * 24 * HOUR,
});

async function device(
  vault: TokenVault,
  storage: KeyValueStorage,
  fetch: FetchLike,
  clock: { now: number }
) {
  const store = new AccountStore({ storage, vault, now: () => clock.now, newId: () => 'acc1' });
  const session = new AccountSession('acc1', store, {
    baseUrl: BASE,
    fetch,
    now: () => clock.now,
    sleep: async (ms) => void (clock.now += ms),
  });
  return { store, session };
}

async function signedInDevice(options?: { replayUnconfirmed?: boolean }) {
  const clock = { now: 1_000_000_000 };
  const server = rotatingServer(clock, options);
  const vault = createMemoryVault();
  const storage = memoryStorage();
  const { store } = await device(vault, storage, server.fetch, clock);
  await store.addSignedIn(
    { url: BASE, name: 'Dev World' },
    { id: 'v-anna', username: 'anna', displayName: 'Anna', mustChangePassword: false },
    expired(clock.now)
  );
  const restart = () => device(vault, storage, server.fetch, clock);
  return { clock, server, vault, restart };
}

describe('refresh rotation interrupted (Google TV sign-outs)', () => {
  it('a refresh whose response is lost is retried within the server grace, so the session survives', async () => {
    const { clock, server, vault, restart } = await signedInDevice();
    const { store, session } = await restart();
    server.state.loseNextResponses = 1;
    await expect(session.accessToken()).resolves.toBe('sva_2');
    expect(vault.entries.get('acc1')).toMatchObject({ refreshToken: 'svr_2' });
    clock.now += 2 * HOUR;
    await expect(session.accessToken()).resolves.toBe('sva_3');
    expect(server.state.revoked).toBeUndefined();
    expect(store.get('acc1')).toMatchObject({ signedIn: true });
  });

  it('a refresh that never answers keeps the old pair and fails without signing out', async () => {
    const { server, vault, restart } = await signedInDevice();
    const { store, session } = await restart();
    server.state.loseNextResponses = 10;
    await expect(session.accessToken()).rejects.toMatchObject({ code: 'timeout' });
    expect(vault.entries.get('acc1')).toMatchObject({ refreshToken: 'svr_1' });
    expect(store.get('acc1')).toMatchObject({ signedIn: true });
  });

  it('a 200 answer without a readable body counts as lost and is re-sent (review S1)', async () => {
    const { server, vault, restart } = await signedInDevice();
    const { store, session } = await restart();
    server.state.lossKind = 'garbled';
    server.state.loseNextResponses = 1;
    await expect(session.accessToken()).resolves.toBe('sva_2');
    expect(vault.entries.get('acc1')).toMatchObject({ refreshToken: 'svr_2' });
    expect(store.get('acc1')).toMatchObject({ signedIn: true });
  });

  it('offline (nothing reached the server) fails at once instead of waiting for the retries (review S1)', async () => {
    const { clock, server, restart } = await signedInDevice();
    const { store, session } = await restart();
    server.state.unreachable = true;
    const before = clock.now;
    await expect(session.accessToken()).rejects.toMatchObject({ code: 'network_unreachable' });
    expect(clock.now - before).toBe(0);
    expect(server.fetch).toHaveBeenCalledTimes(1);
    expect(store.get('acc1')).toMatchObject({ signedIn: true });
    server.state.unreachable = false;
    await expect(session.accessToken()).resolves.toBe('sva_2');
  });

  it('persists the rotated pair before any request uses the new access token', async () => {
    const { server, vault, restart } = await signedInDevice();
    const writes: string[] = [];
    const set = vault.set.bind(vault);
    vault.set = async (id, tokens) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      writes.push(tokens.accessToken);
      await set(id, tokens);
    };
    const { store, session } = await restart();
    const refreshing = session.accessToken();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await store.readTokens('acc1'))?.accessToken).toBe('sva_1');
    await refreshing;
    expect(writes).toEqual(['sva_2']);
    expect(server.state.usedAccess).toEqual([]);
  });

  it('a failing vault write keeps the rotated pair for this run and stores it later (review S1)', async () => {
    const { clock, server, vault, restart } = await signedInDevice();
    const set = vault.set.bind(vault);
    let failing = true;
    vault.set = async (id, tokens) => {
      if (failing) throw new Error('Keystore unavailable');
      await set(id, tokens);
    };
    const { store, session } = await restart();
    await expect(session.accessToken()).resolves.toBe('sva_2');
    expect(vault.entries.get('acc1')).toMatchObject({ refreshToken: 'svr_1' });
    clock.now += 2 * HOUR;
    failing = false;
    await expect(session.accessToken()).resolves.toBe('sva_3');
    expect(server.state.revoked).toBeUndefined();
    expect(vault.entries.get('acc1')).toMatchObject({ refreshToken: 'svr_3' });
    expect(store.get('acc1')).toMatchObject({ signedIn: true });
  });

  it('an app kill after the server rotated ends the session with the current 30 s grace', async () => {
    const { clock, server, restart } = await signedInDevice();
    const first = await restart();
    server.state.loseNextResponses = 10;
    await first.session.accessToken().catch(() => undefined);
    server.state.loseNextResponses = 0;
    clock.now += 2 * 60_000;
    const next = await restart();
    await expect(next.session.accessToken()).rejects.toMatchObject({
      code: 'refresh_token_reused',
    });
    expect(next.store.get('acc1')).toMatchObject({
      signedIn: false,
      endedReason: 'refresh_token_reused',
    });
  });

  it('an app kill after the server rotated keeps the session once the server replays unconfirmed rotations', async () => {
    const { clock, server, restart } = await signedInDevice({ replayUnconfirmed: true });
    const first = await restart();
    server.state.loseNextResponses = 10;
    await first.session.accessToken().catch(() => undefined);
    server.state.loseNextResponses = 0;
    clock.now += 10 * 60_000;
    const next = await restart();
    await expect(next.session.accessToken()).resolves.toBe('sva_2');
    expect(next.store.get('acc1')).toMatchObject({ signedIn: true });
  });
});
