import { createTimeoutFetch } from '@/api/http';
import { createMemoryDownloadsStorage } from '@/downloads/store';
import { enqueueProgress, flushAllProgress } from '@/player/progress-queue';
import type { ApiClient } from '@/api/client';

import { createTestDownloads, TEST_ACCOUNT_KEY } from '../../../jest/downloads';
import { noteServerDate, resetServerClock, serverNow } from '../server-clock';

const HOUR = 3_600_000;

beforeEach(() => resetServerClock(createMemoryDownloadsStorage()));

describe('server clock (a device whose clock is off, e.g. a TV box without NTP)', () => {
  it('learns the skew from a Date header and ignores the header resolution', () => {
    const now = Date.parse('2026-11-06T22:13:00Z');
    noteServerDate('Fri, 06 Nov 2026 23:13:00 GMT', now);
    expect(serverNow(now)).toBe(now + HOUR);
    noteServerDate('Fri, 06 Nov 2026 22:13:02 GMT', now);
    expect(serverNow(now)).toBe(now);
    noteServerDate('not a date', now);
    expect(serverNow(now)).toBe(now);
  });

  it('keeps the skew for an offline cold start', () => {
    const storage = createMemoryDownloadsStorage();
    resetServerClock(storage);
    const now = Date.parse('2026-11-06T22:13:00Z');
    noteServerDate('Fri, 06 Nov 2026 23:13:00 GMT', now);
    resetServerClock(storage);
    expect(serverNow(now)).toBe(now + HOUR);
  });

  it('every API answer through the timeout fetch teaches it', async () => {
    const fetch = createTimeoutFetch(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { Date: new Date(Date.now() - HOUR).toUTCString() },
        })
    );
    await fetch(new Request('http://dev.test/api/v1/health'));
    expect(Math.round((serverNow() - Date.now()) / 60_000)).toBe(-60);
  });

  it('offline progress is sent with the time it happened on the server clock', async () => {
    const now = Date.now();
    noteServerDate(new Date(now + HOUR).toUTCString(), now);
    enqueueProgress('clock-1', { event: 'stop', workId: 'tmdb-movie-9761', positionTicks: 10 });
    const sent: { occurredAt?: string | null }[] = [];
    const client = {
      POST: jest.fn(async (_path: string, init: { body: { occurredAt?: string | null } }) => {
        sent.push(init.body);
        return { data: undefined, response: { ok: true, status: 204, headers: new Headers() } };
      }),
    } as unknown as ApiClient;
    await flushAllProgress([{ id: 'clock-1', signedIn: true }], () => client);
    expect(Math.round((Date.parse(sent[0]!.occurredAt!) - now) / 60_000)).toBe(60);
  });

  it('local positions of downloads are stamped on the server clock', () => {
    const now = Date.now();
    noteServerDate(new Date(now - HOUR).toUTCString(), now);
    const test = createTestDownloads();
    const position = test.manager.recordPosition(TEST_ACCOUNT_KEY, 'tmdb-movie-9761', 60, 600);
    expect(Math.round((position.at - Date.now()) / 60_000)).toBe(-60);
  });
});
