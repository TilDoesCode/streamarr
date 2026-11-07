import {
  createTestDownloads,
  fakeOfflineDownload,
  TEST_ACCOUNT_KEY,
  type TestDownloads,
} from '../../../jest/downloads';
import { AppError } from '@/api/errors';

import { allowedAgain, isBlockedDownload } from '../blocked';
import { resolveLocalPlayTarget } from '../local-play';
import type { DownloadManager } from '../manager';
import type { ViewerPolicy } from '../types';

const GB = 1024 ** 3;
const MOVIE = 'tmdb-movie-603';
const policy = (patch: Partial<ViewerPolicy> = {}): ViewerPolicy => ({
  maxAge: null,
  blockUnrated: false,
  allowDownloads: true,
  at: 1,
  ...patch,
});

async function settle(rounds = 12) {
  for (let round = 0; round < rounds; round += 1) await new Promise((r) => setTimeout(r, 0));
}

const detachers: (() => void)[] = [];
function attach(manager: DownloadManager) {
  detachers.push(manager.attach());
  return manager;
}
afterEach(() => detachers.splice(0).forEach((detach) => detach()));

async function transferring(test: TestDownloads) {
  attach(test.manager);
  const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
    { workId: MOVIE, releaseId: 'r' },
  ]);
  await settle();
  test.engine.controls.progress(download!.id, GB / 3);
  return download!.id;
}

const starts = (test: TestDownloads) =>
  test.engine.controls.calls.filter((call) => call.startsWith('start:')).length;

describe('blocked downloads come back by themselves (downloads off, age rules)', () => {
  it('off → blocked without Retry → on → continues on its bytes, never downloaded again', async () => {
    const test = createTestDownloads();
    const id = await transferring(test);
    test.server.viewerPolicy = policy({ allowDownloads: false });
    test.engine.controls.httpStatus(id, 403);
    await settle();
    expect(test.store.get(id)).toMatchObject({
      state: 'failed',
      error: { code: 'downloads_not_allowed', actions: ['remove'] },
      bytesWritten: GB / 3,
    });
    expect(isBlockedDownload(test.store.get(id)!)).toBe(true);

    // Launch, reconnect, foreground: still off, nothing is asked.
    const renewals = () => test.server.calls.filter((call) => call === 'renew:srv-1').length;
    const asked = renewals();
    test.manager.wake();
    await test.manager.recheckBlocked(undefined, true);
    await settle();
    expect(renewals()).toBe(asked);

    // The admin turns downloads on; the next /viewer/me answer brings it back.
    test.server.viewerPolicy = policy();
    test.manager.notePolicy(TEST_ACCOUNT_KEY, policy({ at: 2 }));
    await settle();
    expect(renewals()).toBe(asked + 1);
    expect(test.store.get(id)).toMatchObject({ state: 'downloading', error: null, restarts: 0 });
    expect(test.engine.controls.tasks()[0]).toMatchObject({ id, bytesWritten: GB / 3 });
    test.engine.controls.complete(id);
    await settle();
    expect(test.store.get(id)).toMatchObject({ state: 'done', bytesWritten: GB });
    expect(starts(test)).toBe(1);
  });

  it('an age refusal waits until the limit really allows the title, then continues', async () => {
    const test = createTestDownloads();
    const id = await transferring(test);
    const refusal = { reason: 'above_age_limit', minimumAge: '16', viewerMaxAge: '12' };
    test.server.viewerPolicy = policy({ maxAge: 12 });
    test.server.restrictedWorks[MOVIE] = refusal;
    test.engine.controls.httpStatus(id, 403);
    await settle();
    expect(test.store.get(id)).toMatchObject({
      state: 'failed',
      error: { code: 'age_restricted', params: refusal, actions: ['remove'] },
    });
    const renewals = () => test.server.calls.filter((call) => call === 'renew:srv-1').length;
    const asked = renewals();

    test.server.viewerPolicy = policy({ maxAge: 14 });
    test.manager.notePolicy(TEST_ACCOUNT_KEY, policy({ maxAge: 14 }));
    await settle();
    expect(renewals()).toBe(asked);
    expect(stateOf(test, id)).toBe('failed');

    delete test.server.restrictedWorks[MOVIE];
    test.server.viewerPolicy = policy({ maxAge: 16 });
    test.manager.notePolicy(TEST_ACCOUNT_KEY, policy({ maxAge: 16 }));
    await settle();
    expect(renewals()).toBe(asked + 1);
    expect(test.store.get(id)).toMatchObject({
      state: 'downloading',
      error: null,
      bytesWritten: GB / 3,
    });
    expect(starts(test)).toBe(1);
  });

  it('turned on again is noticed on the next wake (reconnect, foreground) without the profile refresh', async () => {
    const test = createTestDownloads();
    const id = await transferring(test);
    test.server.viewerPolicy = policy({ allowDownloads: false });
    test.engine.controls.httpStatus(id, 403);
    await settle();
    test.server.viewerPolicy = policy();
    test.manager.wake();
    await settle(20);
    expect(test.server.calls).toContain('policy:');
    expect(test.store.get(id)).toMatchObject({
      state: 'downloading',
      error: null,
      bytesWritten: GB / 3,
    });
    expect(starts(test)).toBe(1);
  });

  it('a disabled account (sessions ended): the transfer waits for the sign-in and continues on the same link', async () => {
    const test = createTestDownloads();
    const id = await transferring(test);
    const url = test.engine.controls.tasks()[0]!.url;
    test.server.failNext('renew', new AppError('refresh_session_revoked', { status: 401 }));
    test.engine.controls.httpStatus(id, 403);
    await settle();
    expect(test.store.get(id)).toMatchObject({
      state: 'waiting_server',
      error: { code: 'signed_out', status: 401 },
      bytesWritten: GB / 3,
    });
    expect(isBlockedDownload(test.store.get(id)!)).toBe(false);
    // Enabled again, the viewer signs in: same file URL, same bytes.
    test.manager.resumeSignedOut([TEST_ACCOUNT_KEY]);
    await settle(20);
    expect(test.store.get(id)).toMatchObject({
      state: 'downloading',
      error: null,
      bytesWritten: GB / 3,
    });
    expect(test.engine.controls.tasks()[0]!.url).toBe(url);
    expect(starts(test)).toBe(1);
  });

  it('still refused by the server: it stays blocked with the server answer', async () => {
    const test = createTestDownloads();
    const id = await transferring(test);
    test.server.viewerPolicy = policy({ allowDownloads: false });
    test.engine.controls.httpStatus(id, 403);
    await settle();
    // /viewer/me already says on, the server does not serve it yet.
    test.manager.notePolicy(TEST_ACCOUNT_KEY, policy());
    await settle();
    expect(test.store.get(id)).toMatchObject({
      state: 'failed',
      error: { code: 'downloads_not_allowed', actions: ['remove'] },
      bytesWritten: GB / 3,
    });
  });

  it('a preparation the server cancelled when downloads went off is prepared anew', async () => {
    const test = createTestDownloads();
    attach(test.manager);
    test.server.autoReady = false;
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.server.failPreparation('srv-1', 'downloads_not_allowed', []);
    await settle(20);
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'failed',
      error: { code: 'downloads_not_allowed' },
    });
    test.server.autoReady = true;
    test.manager.notePolicy(TEST_ACCOUNT_KEY, policy({ at: 3 }));
    await settle(20);
    expect(test.server.calls.filter((call) => call === `prepare:${MOVIE}`)).toHaveLength(2);
    expect(stateOf(test, download!.id)).toBe('downloading');
  });

  it('a finished download stays on the device while locked and plays again when allowed', async () => {
    const test = createTestDownloads();
    const done = fakeOfflineDownload({
      id: 'locked',
      workId: MOVIE,
      error: {
        code: 'age_restricted',
        at: 1,
        params: { reason: 'above_age_limit', minimumAge: '16' },
      },
    });
    test.store.put(done);
    test.engine.controls.writeFile(done.relativePath!, done.sizeBytes!);
    test.store.setPolicy(TEST_ACCOUNT_KEY, policy({ maxAge: 12 }));
    test.server.viewerPolicy = policy({ maxAge: 12 });
    attach(test.manager);
    await settle();
    expect(test.store.get('locked')!.state).toBe('done');
    expect(resolveLocalPlayTarget(MOVIE, TEST_ACCOUNT_KEY, test.manager, test.engine)).toBeNull();

    test.server.viewerPolicy = policy({ maxAge: 16 });
    test.manager.notePolicy(TEST_ACCOUNT_KEY, policy({ maxAge: 16 }));
    await settle();
    expect(test.store.get('locked')).toMatchObject({ state: 'done', error: null });
    expect(
      resolveLocalPlayTarget(MOVIE, TEST_ACCOUNT_KEY, test.manager, test.engine)
    ).not.toBeNull();
  });

  it('permissions that changed while the app was closed are checked at launch', async () => {
    const test = createTestDownloads();
    const id = await transferring(test);
    test.server.viewerPolicy = policy({ allowDownloads: false });
    test.engine.controls.httpStatus(id, 403);
    await settle();
    detachers.pop()!();
    // Turned on while killed; the persisted /viewer/me answer of the last session already says so.
    test.server.viewerPolicy = policy();
    test.store.setPolicy(TEST_ACCOUNT_KEY, policy({ at: 4 }));
    const relaunched = attach(test.restart());
    await settle(20);
    expect(relaunched.store.get(id)).toMatchObject({ state: 'downloading', error: null });
    expect(starts(test)).toBe(1);
  });
});

describe('allowedAgain', () => {
  const blocked = (code: string, params?: Record<string, string>, meta = {}) => ({
    error: { code, at: 0, params },
    meta: { title: 't', ...meta },
  });

  it('follows the persisted permissions and the server decision', () => {
    expect(allowedAgain(blocked('downloads_not_allowed'), policy())).toBe(true);
    expect(allowedAgain(blocked('downloads_not_allowed'), policy({ allowDownloads: false }))).toBe(
      false
    );
    expect(allowedAgain(blocked('downloads_not_allowed'), null)).toBe(false);
    const above = blocked('age_restricted', { reason: 'above_age_limit', minimumAge: '16' });
    expect(allowedAgain(above, policy({ maxAge: 12 }))).toBe(false);
    expect(allowedAgain(above, policy({ maxAge: 16 }))).toBe(true);
    expect(allowedAgain(above, policy({ maxAge: null }))).toBe(true);
    expect(allowedAgain(above, policy({ maxAge: 16, allowDownloads: false }))).toBe(false);
    const unrated = blocked('age_restricted', { reason: 'unrated_blocked' });
    expect(allowedAgain(unrated, policy({ maxAge: 12, blockUnrated: true }))).toBe(false);
    expect(allowedAgain(unrated, policy({ maxAge: 12 }))).toBe(true);
    const bare = blocked('age_restricted', { viewerMaxAge: '12' });
    expect(allowedAgain(bare, policy({ maxAge: 12 }))).toBe(false);
    expect(allowedAgain(bare, policy({ maxAge: 16 }))).toBe(true);
    expect(
      allowedAgain(blocked('age_restricted', {}, { minimumAge: 6 }), policy({ maxAge: 12 }))
    ).toBe(true);
    expect(allowedAgain(blocked('http'), policy())).toBe(false);
  });
});

function stateOf(test: TestDownloads, id: string) {
  return test.store.get(id)?.state;
}
