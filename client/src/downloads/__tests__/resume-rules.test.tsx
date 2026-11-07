import type { Account } from '@/accounts/types';
import type { ApiClient } from '@/api/client';
import { prepareLocalSource } from '@/screens/player/local-source';

import {
  createTestDownloads,
  fakeOfflineDownload,
  seedDownloads,
  TEST_ACCOUNT_KEY,
} from '../../../jest/downloads';

const MOVIE = 'tmdb-movie-603';
const TICKS = 10_000_000;
const owner = { id: 'a1', serverUrl: 'http://dev.test', viewerId: 'v-anna' } as Account;
const offlineClient = {
  POST: jest.fn(() => Promise.reject(new Error('offline'))),
} as unknown as ApiClient;

function watchState(state: Record<string, unknown>): ApiClient {
  return {
    POST: jest.fn(() =>
      Promise.resolve({
        data: [{ workId: MOVIE, ...state }],
        response: new Response('[]', { status: 200 }),
      })
    ),
  } as unknown as ApiClient;
}

async function resumeAt(
  test: ReturnType<typeof createTestDownloads>,
  client = offlineClient,
  offline = true
) {
  const start = await prepareLocalSource({
    workId: MOVIE,
    account: owner,
    client,
    offline: () => offline,
    manager: test.manager,
    engine: test.engine,
  });
  if (start.kind !== 'local') throw new Error(`no local start: ${start.kind}`);
  start.source.release?.();
  return start.source.resumeSeconds;
}

function withDownload() {
  const test = createTestDownloads();
  seedDownloads(test, [fakeOfflineDownload({ id: 'movie', workId: MOVIE })]);
  return test;
}

/** Local positions follow the server's resume rules (viewer settings defaults: 5 %, 90 %, 300 s, started after 2 min). */
describe('local resume points use the server rules', () => {
  it('a 180 s file stopped at 99 s gives no resume point offline (shorter than the minimum duration)', async () => {
    const test = withDownload();
    const position = test.manager.recordPosition(TEST_ACCOUNT_KEY, MOVIE, 99, 180);
    expect(position).toMatchObject({ seconds: 0, played: false });
    expect(await resumeAt(test)).toBe(0);
  });

  it('a 30-minute file stopped at 10 min resumes there offline', async () => {
    const test = withDownload();
    test.manager.recordPosition(TEST_ACCOUNT_KEY, MOVIE, 600, 1_800);
    expect(await resumeAt(test)).toBe(600);
  });

  it('a few seconds into a long film are no resume point yet; past 2 min they are', async () => {
    const test = withDownload();
    expect(test.manager.recordPosition(TEST_ACCOUNT_KEY, MOVIE, 60, 7_200).seconds).toBe(0);
    expect(test.manager.recordPosition(TEST_ACCOUNT_KEY, MOVIE, 150, 7_200).seconds).toBe(150);
    expect(test.manager.recordPosition(TEST_ACCOUNT_KEY, MOVIE, 6_500, 7_200)).toMatchObject({
      seconds: 0,
      played: true,
    });
  });

  it('a position stored before these rules is judged the same way when it is read', async () => {
    const test = withDownload();
    test.store.setPosition(TEST_ACCOUNT_KEY, MOVIE, {
      seconds: 126,
      durationSeconds: 180,
      at: Date.now(),
      played: false,
    });
    expect(await resumeAt(test)).toBe(0);
  });

  it("online, the server's resume point counts also for a work it marks played (a re-watch)", async () => {
    const test = withDownload();
    const client = watchState({
      positionTicks: 1_200 * TICKS,
      durationTicks: 3_600 * TICKS,
      played: true,
      lastPlayedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await resumeAt(test, client, false)).toBe(1_200);
  });
});
