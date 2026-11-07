import type { ApiClient } from '@/api/client';

import { ACCESS_VERDICT_MAX_AGE_MS, lockOf } from '../library';
import { resolveLocalPlayTarget } from '../local-play';
import { ACCESS_RETRY_MS } from '../manager';
import { fetchWorkSnapshot } from '../server';
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
