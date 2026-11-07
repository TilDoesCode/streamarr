import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { viewerFromProfile, type ViewerProfile } from '@/accounts/auth-api';
import { createMemoryVault, type Account, type SessionTokens } from '@/accounts/types';
import { syncProfile } from '@/accounts/use-profile-sync';
import type { ApiClient } from '@/api/client';
import type { ResumeRules } from '@/lib/resume-rules';
import { serverOfAccountKey } from '@/lib/server-clock';
import { prepareLocalSource } from '@/screens/player/local-source';

import { createTestDownloads, fakeOfflineDownload, seedDownloads } from '../../../jest/downloads';
import { downloadAccountKey } from '../keys';
import { createMemoryDownloadsStorage } from '../store';

const MOVIE = 'tmdb-movie-603';
const SERVER_A = 'http://a.test';
const SERVER_B = 'http://b.test';
const SHORT_MINIMUM: ResumeRules = {
  playedPercent: 80,
  minResumePercent: 5,
  minResumeDurationSeconds: 60,
};
const DEFAULTS: ResumeRules = {
  playedPercent: 90,
  minResumePercent: 5,
  minResumeDurationSeconds: 300,
};
const tokens: SessionTokens = {
  sessionId: 's1',
  accessToken: 'sva_1',
  accessExpiresAt: 9_999_999_999_999,
  refreshToken: 'svr_1',
  refreshExpiresAt: 9_999_999_999_999,
};
const offlineClient = {
  POST: jest.fn(() => Promise.reject(new Error('offline'))),
} as unknown as ApiClient;

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

/** A /viewer/me or sign-in `viewer` answer; `resume` undefined = an older server without the field. */
const profile = (resume?: ResumeRules) =>
  ({
    id: 'v-anna',
    username: 'anna',
    displayName: 'Anna',
    mustChangePassword: false,
    permissions: {},
    ...(resume ? { resume } : {}),
  }) as ViewerProfile;

/** Anna signed in on `serverUrl`, one finished download of MOVIE there; the manager reads the stored rules. */
async function world(serverUrls: string[], storage = memoryStorage()) {
  const accounts = new AccountStore({ storage, vault: createMemoryVault() });
  const signedIn: Account[] = [];
  for (const url of serverUrls)
    signedIn.push(
      await accounts.addSignedIn({ url, name: url }, viewerFromProfile(profile()), tokens)
    );
  return { accounts, signedIn, ...downloadsFor(accounts, signedIn) };
}

function downloadsFor(
  accounts: AccountStore,
  signedIn: Account[],
  downloads = createMemoryDownloadsStorage()
) {
  const test = createTestDownloads({
    storage: downloads,
    resumeRules: (key) => accounts.resumeRules(serverOfAccountKey(key)),
  });
  seedDownloads(
    test,
    signedIn.map((account, index) =>
      fakeOfflineDownload({
        id: `movie${index}`,
        workId: MOVIE,
        accountKey: downloadAccountKey(account),
      })
    )
  );
  return { test, downloads };
}

async function offlineResume(test: ReturnType<typeof createTestDownloads>, account: Account) {
  const start = await prepareLocalSource({
    workId: MOVIE,
    account,
    client: offlineClient,
    offline: () => true,
    manager: test.manager,
    engine: test.engine,
  });
  if (start.kind !== 'local') throw new Error(`no local start: ${start.kind}`);
  start.source.release?.();
  return start.source.resumeSeconds;
}

/** DL-S 8: each server's own thresholds (from sign-in and every /viewer/me), kept for offline playback. */
describe('resume thresholds per server', () => {
  it('a 180 s file stopped at 99 s resumes on a server with a 60 s minimum, not on one with the defaults', async () => {
    const { accounts, signedIn, test } = await world([SERVER_A, SERVER_B]);
    const [onA, onB] = signedIn as [Account, Account];
    syncProfile({ store: accounts }, onA, profile(SHORT_MINIMUM));
    syncProfile({ store: accounts }, onB, profile(DEFAULTS));

    expect(test.manager.recordPosition(downloadAccountKey(onA), MOVIE, 99, 180)).toMatchObject({
      seconds: 99,
      played: false,
    });
    expect(test.manager.recordPosition(downloadAccountKey(onB), MOVIE, 99, 180)).toMatchObject({
      seconds: 0,
      played: false,
    });
    expect(await offlineResume(test, onA)).toBe(99);
    expect(await offlineResume(test, onB)).toBe(0);

    // The played mark follows the same server: 150 of 180 s is played at 80 %, not at 90 %.
    expect(test.manager.recordPosition(downloadAccountKey(onA), MOVIE, 150, 180).played).toBe(true);
    expect(test.manager.recordPosition(downloadAccountKey(onB), MOVIE, 150, 180).played).toBe(
      false
    );
  });

  it('the sign-in answer brings them; an admin change seen on the next /viewer/me replaces them', async () => {
    const storage = memoryStorage();
    const accounts = new AccountStore({ storage, vault: createMemoryVault() });
    const onA = await accounts.addSignedIn(
      { url: SERVER_A, name: 'A' },
      viewerFromProfile(profile(DEFAULTS)),
      tokens
    );
    const { test } = downloadsFor(accounts, [onA]);
    expect(accounts.resumeRules(SERVER_A)).toEqual(DEFAULTS);
    test.manager.recordPosition(downloadAccountKey(onA), MOVIE, 99, 180);
    expect(await offlineResume(test, onA)).toBe(0);

    syncProfile({ store: accounts }, onA, profile(SHORT_MINIMUM));
    expect(accounts.resumeRules(`${SERVER_A}/`)).toEqual(SHORT_MINIMUM);
    test.manager.recordPosition(downloadAccountKey(onA), MOVIE, 99, 180);
    expect(await offlineResume(test, onA)).toBe(99);
  });

  it('an offline cold start uses the persisted values', async () => {
    const storage = memoryStorage();
    const { accounts, signedIn, test, downloads } = await world([SERVER_A], storage);
    const onA = signedIn[0]!;
    syncProfile({ store: accounts }, onA, profile(SHORT_MINIMUM));
    test.manager.recordPosition(downloadAccountKey(onA), MOVIE, 99, 180);

    // A new process: the account list and the downloads come back from storage, no server answers.
    const reopened = new AccountStore({ storage, vault: createMemoryVault() });
    const cold = createTestDownloads({
      storage: downloads,
      engine: test.engine,
      resumeRules: (key) => reopened.resumeRules(serverOfAccountKey(key)),
    });
    expect(reopened.resumeRules(SERVER_A)).toEqual(SHORT_MINIMUM);
    expect(await offlineResume(cold, onA)).toBe(99);
  });

  it('an older server without the field falls back to the defaults and never wipes known values', async () => {
    const { accounts, signedIn, test } = await world([SERVER_A, SERVER_B]);
    const [onA, onB] = signedIn as [Account, Account];
    expect(viewerFromProfile(profile()).resume).toBeNull();
    expect(accounts.resumeRules(SERVER_B)).toBeNull();
    expect(test.manager.resumeRules(downloadAccountKey(onB))).toEqual(DEFAULTS);
    test.manager.recordPosition(downloadAccountKey(onB), MOVIE, 99, 180);
    expect(await offlineResume(test, onB)).toBe(0);
    test.manager.recordPosition(downloadAccountKey(onB), MOVIE, 600, 1_800);
    expect(await offlineResume(test, onB)).toBe(600);

    syncProfile({ store: accounts }, onA, profile(SHORT_MINIMUM));
    syncProfile({ store: accounts }, onA, profile());
    expect(accounts.resumeRules(SERVER_A)).toEqual(SHORT_MINIMUM);
  });
});
