import { createFakeDownloadEngine } from '@/downloads/engine/fake';

import { createTestDownloads, TEST_ACCOUNT_KEY } from '../../../jest/downloads';
import type { DownloadManager } from '../manager';

const GB = 1024 ** 3;
const MOVIE = 'tmdb-movie-603';
const settle = async () => {
  for (let round = 0; round < 12; round += 1) await new Promise((r) => setTimeout(r, 0));
};
const detachers: (() => void)[] = [];
const attach = (manager: DownloadManager) => {
  detachers.push(manager.attach());
  return manager;
};
afterEach(() => detachers.splice(0).forEach((detach) => detach()));

describe('download manager coverage (C1-23)', () => {
  it('an HTTP 409 (source changed) prepares the file anew once, then offers retry or another version', async () => {
    const test = createTestDownloads();
    attach(test.manager);
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.progress(download!.id, GB / 2);
    test.engine.controls.httpStatus(download!.id, 409);
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'downloading',
      downloadId: 'srv-2',
      restarts: 1,
      bytesWritten: 0,
    });
    test.engine.controls.httpStatus(download!.id, 409);
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'failed',
      error: { code: 'download_source_changed', actions: ['retry', 'otherVersion'] },
    });
  });

  it('disk full mid-transfer waits for space and continues on the bytes it has', async () => {
    const test = createTestDownloads();
    attach(test.manager);
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.engine.controls.progress(download!.id, GB / 4);
    test.engine.controls.setStorage({ freeBytes: 10 });
    test.engine.controls.fail(download!.id, 'disk_full');
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'waiting_space',
      bytesWritten: GB / 4,
    });
    test.engine.controls.setStorage({ freeBytes: 20 * GB });
    test.manager.wake();
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({
      state: 'downloading',
      bytesWritten: GB / 4,
    });
  });

  it('Wi-Fi only switched while a transfer waits on a metered network', async () => {
    const test = createTestDownloads({ engine: createFakeDownloadEngine({ network: 'metered' }) });
    attach(test.manager);
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    expect(test.store.get(download!.id)!.state).toBe('waiting_wifi');
    await test.manager.setWifiOnly(false);
    await settle();
    expect(test.store.get(download!.id)!.state).toBe('downloading');
    await test.manager.setWifiOnly(true);
    await settle();
    expect(test.store.get(download!.id)!.state).toBe('waiting_wifi');
    expect(test.store.settings().wifiOnly).toBe(true);
  });

  it('a download of one profile keeps running while another profile is active', async () => {
    const test = createTestDownloads();
    attach(test.manager);
    const other = 'http://dev.test#v-ben';
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    test.signedOut.add(TEST_ACCOUNT_KEY);
    expect(test.store.forAccount(other)).toEqual([]);
    test.engine.controls.complete(download!.id);
    await settle();
    expect(test.store.get(download!.id)).toMatchObject({ state: 'done', serverCompleted: false });
    test.signedOut.clear();
    test.manager.wake();
    await settle();
    expect(test.store.get(download!.id)!.serverCompleted).toBe(true);
  });

  it('a task the engine lists as cancelled was cancelled by the viewer (notification): it is removed, not restarted', async () => {
    const test = createTestDownloads();
    attach(test.manager);
    const [download] = await test.manager.start(TEST_ACCOUNT_KEY, [
      { workId: MOVIE, releaseId: 'r' },
    ]);
    await settle();
    detachers.pop()!();
    test.engine.controls.setState(download!.id, 'cancelled');
    const relaunched = attach(test.restart());
    await settle();
    expect(relaunched.store.get(download!.id)).toBeUndefined();
    expect(test.engine.controls.calls.filter((call) => call.startsWith('start:'))).toHaveLength(1);
    expect(test.server.calls).toContain('remove:srv-1');
    // The tombstone is cleared with remove, not cancelled again.
    expect(test.engine.controls.calls).toContain(`remove:${download!.id}`);
    expect(test.engine.controls.tasks()).toEqual([]);
  });
});
