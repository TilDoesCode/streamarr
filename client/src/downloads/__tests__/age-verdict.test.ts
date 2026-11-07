import type { ApiClient } from '@/api/client';

import { ACCESS_VERDICT_MAX_AGE_MS, lockOf } from '../library';
import { resolveLocalPlayTarget } from '../local-play';
import { ACCESS_RETRY_MS, UNRATEABLE_RETRY_MAX_MS } from '../manager';
import { fetchAccessVerdict, fetchWorkSnapshot } from '../server';
import type { ViewerPolicy } from '../types';
import {
  createTestDownloads,
  fakeOfflineDownload,
  seedDownloads,
  TEST_ACCOUNT_KEY,
} from '../../../jest/downloads';

const RESTRICTED: ViewerPolicy = { maxAge: 12, blockUnrated: true, allowDownloads: true, at: 1 };
const OPEN: ViewerPolicy = { maxAge: null, blockUnrated: false, allowDownloads: true, at: 1 };

const target = (test: ReturnType<typeof createTestDownloads>, workId = 'tmdb-movie-603') =>
  resolveLocalPlayTarget(workId, TEST_ACCOUNT_KEY, test.manager, test.engine);

/** DL-C-verify2 C2-08 / C1-21: an unknown age verdict never authorizes a file under a restricted profile. */
describe('age verdict of a download', () => {
  it('C2-08: an unavailable age snapshot does not authorize a file under a restricted offline policy', async () => {
    const client = {
      GET: jest.fn(async (path: string) => {
        if (path.includes('/access/')) throw new TypeError('connection lost');
        return {
          data: { title: 'Adult movie', certification: '18' },
          response: new Response('{}'),
        };
      }),
    } as unknown as ApiClient;
    const snapshot = await fetchWorkSnapshot(client, 'tmdb-movie-603');
    expect(snapshot.meta.accessVerified).toBeUndefined();
    const test = createTestDownloads();
    seedDownloads(test, [fakeOfflineDownload({ id: 'age-unknown', meta: snapshot.meta })]);
    test.store.setPolicy(TEST_ACCOUNT_KEY, { ...RESTRICTED, at: Date.now() });
    expect(target(test)).toBeNull();
    // Locked with its own reason, the file stays.
    expect(lockOf(test.store.get('age-unknown')!, test.store.policy(TEST_ACCOUNT_KEY))).toBe(
      'age_unverified'
    );
    expect(test.store.get('age-unknown')).toBeDefined();
  });

  it('an unrestricted profile needs no verdict', () => {
    const test = createTestDownloads();
    seedDownloads(test, [fakeOfflineDownload({ id: 'open' })]);
    test.store.setPolicy(TEST_ACCOUNT_KEY, OPEN);
    expect(lockOf(test.store.get('open')!, OPEN)).toBeNull();
    expect(target(test)?.download.id).toBe('open');
  });

  it('a verdict read earlier (older records carry its fields) counts; one older than 90 days is checked again', () => {
    const known = fakeOfflineDownload({ meta: { title: 'K', minimumAge: 6, rated: true } });
    expect(lockOf(known, RESTRICTED)).toBeNull();
    const now = 10 * ACCESS_VERDICT_MAX_AGE_MS;
    const old = fakeOfflineDownload({
      meta: { title: 'O', minimumAge: 6, rated: true, accessVerified: true, accessCheckedAt: 0 },
    });
    expect(lockOf(old, RESTRICTED, now)).toBe('age_unverified');
    const fresh = fakeOfflineDownload({
      meta: {
        title: 'F',
        minimumAge: 16,
        rated: true,
        accessVerified: true,
        accessCheckedAt: now - 1000,
      },
    });
    expect(lockOf(fresh, RESTRICTED, now)).toBe('age_restricted');
  });

  it('online launches revalidate unknown verdicts apart from the title and artwork snapshot, with backoff', async () => {
    let now = 1_700_000_000_000;
    const test = createTestDownloads({ now: () => now });
    seedDownloads(test, [
      fakeOfflineDownload({
        id: 'a-kids',
        workId: 'tmdb-movie-603',
        meta: { title: 'Known title' },
        artwork: { poster: 'art/poster.jpg' },
      }),
      fakeOfflineDownload({ id: 'b-adult', workId: 'tmdb-movie-10378', meta: { title: 'Other' } }),
    ]);
    test.store.setPolicy(TEST_ACCOUNT_KEY, RESTRICTED);
    test.server.ages['tmdb-movie-603'] = { minimumAge: 6, rated: true };
    test.server.ages['tmdb-movie-10378'] = { minimumAge: 16, rated: true };
    test.server.failNext('access', new TypeError('connection lost'));
    await test.manager.reconcileServers();
    const policy = test.store.policy(TEST_ACCOUNT_KEY);
    // The snapshot is complete (title + poster): only the verdict is asked.
    expect(test.server.calls).not.toContain('snapshot:tmdb-movie-603');
    expect(lockOf(test.store.get('a-kids')!, policy, now)).toBe('age_unverified');
    expect(lockOf(test.store.get('b-adult')!, policy, now)).toBe('age_restricted');

    // The failed one waits for its backoff, then is asked again.
    await test.manager.reconcileServers();
    expect(test.server.calls.filter((call) => call === 'access:tmdb-movie-603')).toHaveLength(1);
    now += ACCESS_RETRY_MS;
    await test.manager.reconcileServers();
    expect(test.server.calls.filter((call) => call === 'access:tmdb-movie-603')).toHaveLength(2);
    expect(lockOf(test.store.get('a-kids')!, policy, now)).toBeNull();
    expect(target(test)?.download.id).toBe('a-kids');
  });
});

/** An `/access` answer with `reason` (and its ages), as the server sends it (§ 13). */
function accessClient(body: Record<string, unknown> | Error) {
  return {
    GET: jest.fn(async () => {
      if (body instanceof Error) throw body;
      return { data: { workId: 'tmdb-movie-603', ...body }, response: new Response('{}') };
    }),
  } as unknown as ApiClient;
}

/** DL-C-verify3 C3-04: the server's access reason and verification state are kept; an unrateable title never plays. */
describe('every access reason of § 13 (C3-04)', () => {
  const SOME_RULES: ViewerPolicy = { maxAge: 12, blockUnrated: false, allowDownloads: true, at: 1 };
  const cases: [string, Record<string, unknown>, (string | null)[]][] = [
    // reason + answer → lock under RESTRICTED (12, unrated blocked), SOME_RULES (12), OPEN
    ['within_age_limit', { allowed: true, minimumAge: 6, rating: 'FSK 6' }, [null, null, null]],
    [
      'above_age_limit',
      { allowed: false, minimumAge: 16, rating: 'FSK 16' },
      ['age_restricted', 'age_restricted', null],
    ],
    ['unrated_allowed', { allowed: true, minimumAge: null }, ['age_restricted', null, null]],
    ['unrated_blocked', { allowed: false, minimumAge: null }, ['age_restricted', null, null]],
    [
      'rating_unavailable',
      { allowed: false, minimumAge: null },
      ['age_unverified', 'age_unverified', null],
    ],
    [
      'unrestricted',
      { allowed: true, minimumAge: 16, rating: 'FSK 16' },
      ['age_restricted', 'age_restricted', null],
    ],
    [
      'unrestricted',
      { allowed: true, minimumAge: null },
      ['age_unverified', 'age_unverified', null],
    ],
  ];

  it.each(cases)('%s (%j) locks as the server decides', async (reason, answer, locks) => {
    const verdict = await fetchAccessVerdict(
      accessClient({ reason, ...answer }),
      'tmdb-movie-603',
      5
    );
    expect(verdict.accessReason).toBe(reason);
    expect(verdict.accessCheckedAt).toBe(5);
    const download = fakeOfflineDownload({ meta: { title: 'Title', ...verdict } });
    const now = 10;
    expect([RESTRICTED, SOME_RULES, OPEN].map((policy) => lockOf(download, policy, now))).toEqual(
      locks
    );
  });

  it('rating_unavailable is no verified verdict: rated false, unverified, the file stays and never plays', async () => {
    const verdict = await fetchAccessVerdict(
      accessClient({
        allowed: false,
        reason: 'rating_unavailable',
        minimumAge: null,
        viewerMaxAge: 12,
      }),
      'tmdb-movie-603'
    );
    expect(verdict).toMatchObject({ rated: false, accessVerified: false, minimumAge: null });
    const test = createTestDownloads();
    seedDownloads(test, [
      fakeOfflineDownload({ id: 'rating-unknown', meta: { title: 'Title', ...verdict } }),
    ]);
    test.store.setPolicy(TEST_ACCOUNT_KEY, { ...RESTRICTED, at: Date.now() });
    expect(lockOf(test.store.get('rating-unknown')!, test.store.policy(TEST_ACCOUNT_KEY))).toBe(
      'age_unverified'
    );
    expect(target(test)).toBeNull();
    expect(test.store.get('rating-unknown')).toMatchObject({ state: 'done' });
    test.store.setPolicy(TEST_ACCOUNT_KEY, { ...OPEN, at: Date.now() });
    expect(target(test)?.download.id).toBe('rating-unknown');
  });

  it('a title the server does not know (404) or cannot rate right now (503) gives no verdict', async () => {
    const { AppError } = jest.requireActual<typeof import('@/api/errors')>('@/api/errors');
    for (const error of [
      new AppError('title_not_found', { status: 404 }),
      new AppError('catalog_unavailable', { status: 503 }),
    ])
      await expect(fetchAccessVerdict(accessClient(error), 'tmdb-movie-603')).rejects.toBeDefined();
  });

  it('a profile without age rules asks for no verdicts; once restricted, it asks at once', async () => {
    const test = createTestDownloads();
    seedDownloads(test, [fakeOfflineDownload({ id: 'm', meta: { title: 'Title' } })]);
    test.store.setPolicy(TEST_ACCOUNT_KEY, OPEN);
    await test.manager.reconcileServers();
    expect(test.server.calls.filter((call) => call.startsWith('access:'))).toEqual([]);
    test.server.ages['tmdb-movie-603'] = { minimumAge: 6, rated: true };
    test.manager.notePolicy(TEST_ACCOUNT_KEY, { ...RESTRICTED, at: 2 });
    await test.manager.revalidateAccess(TEST_ACCOUNT_KEY);
    expect(test.server.calls).toContain('access:tmdb-movie-603');
    expect(lockOf(test.store.get('m')!, test.store.policy(TEST_ACCOUNT_KEY))).toBeNull();
  });
});

/** DL-C-verify3 C3-03: a due age check runs by itself while the app is open and online. */
describe('age check retries while the app stays open (C3-03)', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    cleanups.splice(0).forEach((dispose) => dispose());
    jest.useRealTimers();
  });
  function unknownAge() {
    const test = createTestDownloads();
    seedDownloads(test, [
      fakeOfflineDownload({
        id: 'unknown-age',
        meta: { title: 'Title', accessVerified: false },
        artwork: { poster: null },
      }),
    ]);
    test.store.setPolicy(TEST_ACCOUNT_KEY, { ...RESTRICTED, at: Date.now() });
    return test;
  }
  const lock = (test: ReturnType<typeof createTestDownloads>) =>
    lockOf(test.store.get('unknown-age')!, test.store.policy(TEST_ACCOUNT_KEY));
  const asked = (test: ReturnType<typeof createTestDownloads>) =>
    test.server.calls.filter((call) => call === 'access:tmdb-movie-603').length;

  it('a transient failure, then the server answers: the title unlocks without a relaunch or reconnect', async () => {
    jest.useFakeTimers();
    const test = unknownAge();
    test.server.ages['tmdb-movie-603'] = { minimumAge: 6, rated: true };
    test.server.failNext('access', new TypeError('connection lost'));
    cleanups.push(test.manager.attach());
    await jest.advanceTimersByTimeAsync(100);
    expect(lock(test)).toBe('age_unverified');
    expect(asked(test)).toBe(1);
    await jest.advanceTimersByTimeAsync(ACCESS_RETRY_MS);
    expect(asked(test)).toBe(2);
    expect(lock(test)).toBeNull();
  });

  it('offline no timer runs; the reconnect asks again', async () => {
    jest.useFakeTimers();
    const test = unknownAge();
    test.server.ages['tmdb-movie-603'] = { minimumAge: 6, rated: true };
    test.server.failNext('access', new TypeError('connection lost'));
    cleanups.push(test.manager.attach());
    await jest.advanceTimersByTimeAsync(100);
    test.manager.setOnline(false);
    await jest.advanceTimersByTimeAsync(10 * ACCESS_RETRY_MS);
    expect(asked(test)).toBe(1);
    test.manager.setOnline(true);
    test.manager.wake();
    await jest.advanceTimersByTimeAsync(100);
    expect(asked(test)).toBe(2);
    expect(lock(test)).toBeNull();
  });

  it('one run per profile at a time; a title the server cannot rate is asked again at most daily', async () => {
    jest.useFakeTimers();
    const test = unknownAge();
    test.server.ages['tmdb-movie-603'] = {
      minimumAge: null,
      rated: false,
      accessVerified: false,
      accessReason: 'rating_unavailable',
    };
    cleanups.push(test.manager.attach());
    await Promise.all([
      test.manager.revalidateAccess(TEST_ACCOUNT_KEY),
      test.manager.revalidateAccess(TEST_ACCOUNT_KEY),
    ]);
    await jest.advanceTimersByTimeAsync(100);
    expect(asked(test)).toBe(1);
    expect(lock(test)).toBe('age_unverified');
    // The backoff doubles and stops at a day (not the 90-day window of a real verdict).
    for (let step = 0; step < 14; step += 1)
      await jest.advanceTimersByTimeAsync(UNRATEABLE_RETRY_MAX_MS);
    const count = asked(test);
    expect(count).toBeGreaterThan(8);
    await jest.advanceTimersByTimeAsync(UNRATEABLE_RETRY_MAX_MS);
    expect(asked(test)).toBe(count + 1);
    test.server.ages['tmdb-movie-603'] = {
      minimumAge: 6,
      rated: true,
      accessReason: 'within_age_limit',
    };
    await jest.advanceTimersByTimeAsync(UNRATEABLE_RETRY_MAX_MS);
    expect(lock(test)).toBeNull();
  });
});

/** DL-C-verify4 C4-01: a retry that can no longer do work is dropped; nothing is rescheduled at 0 ms. */
describe('age check retries never churn (C4-01)', () => {
  const OPEN_NOW = () => ({ ...OPEN, at: Date.now() });
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    cleanups.splice(0).forEach((dispose) => dispose());
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  function failedOnce() {
    const test = createTestDownloads();
    seedDownloads(test, [
      fakeOfflineDownload({
        id: 'age-retry',
        meta: { title: 'Movie', accessVerified: false },
        artwork: { poster: null },
      }),
    ]);
    test.store.setPolicy(TEST_ACCOUNT_KEY, { ...RESTRICTED, at: Date.now() });
    test.server.failNext('access', new TypeError('offline once'));
    return test;
  }
  const asked = (test: ReturnType<typeof createTestDownloads>) =>
    test.server.calls.filter((call) => call.startsWith('access:')).length;

  it('a profile that becomes unrestricted stops its pending retry (the repro: 121 runs → at most 1)', async () => {
    jest.useFakeTimers();
    const test = failedOnce();
    cleanups.push(test.manager.attach());
    await jest.advanceTimersByTimeAsync(100);
    expect(asked(test)).toBe(1);
    test.manager.notePolicy(TEST_ACCOUNT_KEY, OPEN_NOW());
    const runs = jest.spyOn(test.manager, 'revalidateAccess');
    await jest.advanceTimersByTimeAsync(ACCESS_RETRY_MS + 20);
    expect(runs.mock.calls.length).toBeLessThanOrEqual(1);
    await jest.advanceTimersByTimeAsync(10 * ACCESS_RETRY_MS);
    expect(runs.mock.calls.length).toBeLessThanOrEqual(1);
    expect(asked(test)).toBe(1);
  });

  it.each([
    ['removed', (test: ReturnType<typeof createTestDownloads>) => test.manager.remove('age-retry')],
    [
      'verified meanwhile',
      async (test: ReturnType<typeof createTestDownloads>) => {
        test.store.update('age-retry', {
          meta: {
            ...test.store.get('age-retry')!.meta,
            accessVerified: true,
            accessCheckedAt: Date.now(),
            minimumAge: 6,
            rated: true,
          },
        });
      },
    ],
  ])('a record %s drops its retry: no further runs', async (_, change) => {
    jest.useFakeTimers();
    const test = failedOnce();
    cleanups.push(test.manager.attach());
    await jest.advanceTimersByTimeAsync(100);
    await change(test);
    const runs = jest.spyOn(test.manager, 'revalidateAccess');
    await jest.advanceTimersByTimeAsync(5 * ACCESS_RETRY_MS);
    expect(runs.mock.calls.length).toBeLessThanOrEqual(1);
    expect(asked(test)).toBe(1);
  });

  it('a check that outlasts its backoff waits the next step, never 0 ms', async () => {
    jest.useFakeTimers();
    const test = failedOnce();
    cleanups.push(test.manager.attach());
    await jest.advanceTimersByTimeAsync(100);
    // The retry's request hangs longer than its own backoff, then fails again.
    const access = test.server.access.bind(test.server);
    jest.spyOn(test.server, 'access').mockImplementationOnce(async (workId) => {
      await new Promise((resolve) => setTimeout(resolve, 3 * ACCESS_RETRY_MS));
      await access(workId).catch(() => undefined);
      throw new TypeError('timed out');
    });
    const runs = jest.spyOn(test.manager, 'revalidateAccess');
    await jest.advanceTimersByTimeAsync(ACCESS_RETRY_MS + 3 * ACCESS_RETRY_MS + 100);
    const after = runs.mock.calls.length;
    expect(after).toBe(1);
    // Due again only after the next backoff step (120 s), not at once.
    await jest.advanceTimersByTimeAsync(ACCESS_RETRY_MS);
    expect(runs.mock.calls.length).toBe(after);
    await jest.advanceTimersByTimeAsync(ACCESS_RETRY_MS + 100);
    expect(runs.mock.calls.length).toBe(after + 1);
  });
});
