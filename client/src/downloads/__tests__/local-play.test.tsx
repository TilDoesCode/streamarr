import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Account } from '@/accounts/types';
import type { ApiClient } from '@/api/client';
import { prepareLocalSource, useOfflineNextEpisode } from '@/screens/player/local-source';

import {
  createTestDownloads,
  DownloadsTestProvider,
  fakeOfflineDownload,
  seedDownloads,
  TEST_ACCOUNT_KEY,
} from '../../../jest/downloads';
import { lockOf } from '../library';
import { nextDownloadedEpisode, resolveLocalPlayTarget } from '../local-play';

const account = {
  id: 'a1',
  serverUrl: 'http://dev.test',
  viewerId: 'v-anna',
} as Account;
const client = {
  POST: jest.fn(() => Promise.reject(new Error('offline'))),
} as unknown as ApiClient;
const episode = (season: number, number: number, patch = {}) =>
  fakeOfflineDownload({
    id: `e${season}x${number}`,
    workId: `tmdb-tv-5-s0${season}e0${number}`,
    meta: { title: `Episode ${number}`, seriesTitle: 'Show' },
    ...patch,
  });

describe('offline up-next (C1-15)', () => {
  it('follows season order across gaps and seasons, skips unfinished files and ends at the last one', () => {
    const test = createTestDownloads();
    seedDownloads(test, [
      episode(1, 1),
      episode(1, 3),
      episode(1, 4, { state: 'downloading', bytesWritten: 10 }),
      episode(2, 1),
    ]);
    const next = (workId: string) =>
      nextDownloadedEpisode(workId, TEST_ACCOUNT_KEY, test.manager)?.workId ?? null;
    expect(next('tmdb-tv-5-s01e01')).toBe('tmdb-tv-5-s01e03');
    expect(next('tmdb-tv-5-s01e03')).toBe('tmdb-tv-5-s02e01');
    expect(next('tmdb-tv-5-s02e01')).toBeNull();
  });

  it('the hook follows the downloads: a deleted next file is no longer offered', async () => {
    const test = createTestDownloads();
    seedDownloads(test, [episode(1, 1), episode(1, 2)]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DownloadsTestProvider test={test}>{children}</DownloadsTestProvider>
    );
    const ownerAccount = { ...account, serverUrl: 'http://dev.test', viewerId: 'v-anna' };
    const { result, unmount } = await renderHook(
      () => useOfflineNextEpisode('tmdb-tv-5-s01e01', ownerAccount),
      { wrapper }
    );
    expect(result.current?.workId).toBe('tmdb-tv-5-s01e02');
    await act(() => test.manager.remove('e1x2'));
    expect(result.current).toBeNull();
    await unmount();
  });
});

describe('age rules offline (C1-21)', () => {
  const adult = { maxAge: null, blockUnrated: false, allowDownloads: true, at: 1 };
  const child = { maxAge: 12, blockUnrated: true, allowDownloads: true, at: 1 };

  it('locks downloads above the last known policy and unrated ones when those are blocked', () => {
    const sixteen = fakeOfflineDownload({ meta: { title: 'A', minimumAge: 16, rated: true } });
    const twelve = fakeOfflineDownload({ meta: { title: 'B', minimumAge: 12, rated: true } });
    const unrated = fakeOfflineDownload({ meta: { title: 'C', minimumAge: null, rated: false } });
    const unknown = fakeOfflineDownload({ meta: { title: 'D' } });
    expect(lockOf(sixteen, child)).toBe('age_restricted');
    expect(lockOf(twelve, child)).toBeNull();
    expect(lockOf(unrated, child)).toBe('age_restricted');
    expect(lockOf(unknown, child)).toBeNull();
    expect(lockOf(sixteen, adult)).toBeNull();
    expect(lockOf(sixteen, null)).toBeNull();
    const refused = fakeOfflineDownload({ error: { code: 'age_restricted', at: 1 } });
    expect(lockOf(refused, adult)).toBe('age_restricted');
  });

  it('a locked download is no play target and stays on the device', async () => {
    const test = createTestDownloads();
    seedDownloads(test, [
      fakeOfflineDownload({ id: 'm16', meta: { title: 'M', minimumAge: 16, rated: true } }),
    ]);
    test.store.setPolicy(TEST_ACCOUNT_KEY, child);
    expect(
      resolveLocalPlayTarget('tmdb-movie-603', TEST_ACCOUNT_KEY, test.manager, test.engine)
    ).toBeNull();
    expect(test.store.get('m16')!.state).toBe('done');
    test.store.setPolicy(TEST_ACCOUNT_KEY, adult);
    expect(
      resolveLocalPlayTarget('tmdb-movie-603', TEST_ACCOUNT_KEY, test.manager, test.engine)
    ).not.toBeNull();
  });
});

describe('the player start (C1-06)', () => {
  const owner = { ...account, viewerId: 'v-anna', serverUrl: 'http://dev.test' };

  it('plays a verified file and holds it; a missing file streams online and gets its card offline', async () => {
    const test = createTestDownloads();
    const download = fakeOfflineDownload({ id: 'movie' });
    seedDownloads(test, [download]);
    const start = (offline: boolean) =>
      prepareLocalSource({
        workId: 'tmdb-movie-603',
        account: owner,
        client,
        offline: () => offline,
        manager: test.manager,
        engine: test.engine,
      });
    const local = await start(true);
    expect(local).toMatchObject({
      kind: 'local',
      source: { downloadId: 'movie', engine: 'native' },
    });
    if (local.kind === 'local') local.source.release?.();

    await test.engine.deletePath(download.relativePath!);
    expect(await start(false)).toEqual({ kind: 'stream', notice: 'downloadMissing' });
    expect(test.store.get('movie')).toMatchObject({
      state: 'failed',
      error: { code: 'file_missing', actions: ['retry', 'remove'] },
    });

    test.store.update('movie', { state: 'done', error: null });
    expect(await start(true)).toEqual({ kind: 'missing', downloadId: 'movie' });
  });

  it('a locked download gets its card offline and lets the server decide online', async () => {
    const test = createTestDownloads();
    seedDownloads(test, [
      fakeOfflineDownload({ id: 'm16', meta: { title: 'M', minimumAge: 16, rated: true } }),
    ]);
    test.store.setPolicy('http://dev.test#v-anna', {
      maxAge: 12,
      blockUnrated: true,
      allowDownloads: true,
      at: 1,
    });
    const start = (offline: boolean) =>
      prepareLocalSource({
        workId: 'tmdb-movie-603',
        account: owner,
        client,
        offline: () => offline,
        manager: test.manager,
        engine: test.engine,
      });
    expect(await start(true)).toEqual({ kind: 'locked', downloadId: 'm16' });
    expect(await start(false)).toEqual({ kind: 'stream' });
  });
});
