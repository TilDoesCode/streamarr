import { createApiClient, type ApiClient } from '@/api/client';
import { createTimeoutFetch } from '@/api/http';
import { serverKey } from '@/api/server-url';
import { downloadAccountKey } from '@/downloads/keys';
import { downloadEngine } from '@/downloads/engine';
import { createFakeDownloadEngine } from '@/downloads/engine/fake';
import { createMemoryDownloadsStorage } from '@/downloads/store';
import { enqueueProgress, flushAllProgress } from '@/player/progress-queue';

import { createTestDownloads, TEST_ACCOUNT_KEY } from '../../../jest/downloads';
import {
  ESTIMATE_MARGIN_MS,
  noteServerDate,
  resetServerClock,
  serverNow,
  serverOfAccountKey,
  serverStamp,
  setElapsedClock,
} from '../server-clock';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-07T12:00:00Z');
const DEV = 'http://dev.test';
const OTHER = 'http://other.test';

/** An API client whose server answers with its clock `offset` away from this device's. */
function clientAt(baseUrl: string, offset: () => number) {
  const fetch = createTimeoutFetch(
    async () =>
      new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          Date: new Date(Date.now() + offset()).toUTCString(),
        },
      })
  );
  return createApiClient({ baseUrl, fetch, language: () => 'en' });
}

beforeEach(() => {
  resetServerClock(createMemoryDownloadsStorage());
  // One real boot whose elapsed clock follows jest's timers (the engine's sleep-inclusive clock on a device).
  setElapsedClock(() => ({ elapsedMs: performance.now(), bootId: 'boot-test' }));
});
afterEach(() => {
  jest.useRealTimers();
  setElapsedClock(null);
  resetServerClock(createMemoryDownloadsStorage());
});

describe('server clock (a device whose clock is off, e.g. a TV box without NTP)', () => {
  it('learns the offset from a Date header and ignores the header resolution', () => {
    const now = Date.parse('2026-11-06T22:13:00Z');
    noteServerDate(DEV, 'Fri, 06 Nov 2026 23:13:00 GMT', now);
    expect(serverNow(DEV, now)).toBe(now + HOUR);
    noteServerDate(DEV, 'Fri, 06 Nov 2026 22:13:02 GMT', now);
    expect(serverNow(DEV, now)).toBe(now);
    noteServerDate(DEV, 'not a date', now);
    expect(serverNow(DEV, now)).toBe(now);
  });

  it('keeps the offset for an offline cold start', () => {
    const storage = createMemoryDownloadsStorage({ serverClockSkewMs: String(HOUR) });
    resetServerClock(storage);
    const now = Date.parse('2026-11-06T22:13:00Z');
    noteServerDate(DEV, 'Fri, 06 Nov 2026 23:13:00 GMT', now);
    resetServerClock(storage);
    expect(serverNow(DEV, now)).toBe(now + HOUR);
    // The old device-wide offset is gone.
    expect(storage.entries.has('serverClockSkewMs')).toBe(false);
  });

  it('clock skew in both directions persists across offline days; missing Date retains the learned value', () => {
    noteServerDate(DEV, null, NOW);
    expect(serverNow(DEV, NOW)).toBe(NOW);
    for (const offset of [-2 * HOUR, 2 * HOUR]) {
      const storage = createMemoryDownloadsStorage();
      resetServerClock(storage);
      noteServerDate(DEV, new Date(NOW + offset).toUTCString(), NOW);
      noteServerDate(DEV, null, NOW + HOUR);
      noteServerDate(DEV, 'invalid', NOW + HOUR);
      resetServerClock(storage);
      expect(serverNow(DEV, NOW + 3 * 24 * HOUR)).toBe(NOW + 3 * 24 * HOUR + offset);
    }
  });

  it("every API answer teaches its own server's clock, keyed like the account (also under a path)", async () => {
    const client = clientAt('http://Dev.test/streamarr/', () => -HOUR);
    await client.GET('/api/v1/health');
    const key = serverOfAccountKey(
      downloadAccountKey({ serverUrl: 'http://dev.test/streamarr', viewerId: 'v-anna' })
    );
    expect(key).toBe(serverKey('http://dev.test/streamarr'));
    expect(Math.round((serverNow(key) - Date.now()) / 60_000)).toBe(-60);
    expect(serverStamp(DEV).estimated).toBe(true);
  });

  it('C2-06: a Date header from server B never moves server A (two servers ±2 h)', async () => {
    jest.useFakeTimers({ now: NOW });
    const test = createTestDownloads({ now: () => NOW });
    await clientAt(DEV, () => 2 * HOUR).GET('/api/v1/health');
    const first = test.manager.recordPosition(TEST_ACCOUNT_KEY, 'tmdb-movie-603', 10, 100);
    await clientAt(OTHER, () => -2 * HOUR).GET('/api/v1/health');
    const second = test.manager.recordPosition(TEST_ACCOUNT_KEY, 'tmdb-movie-603', 20, 100);
    expect(first.at).toBe(NOW + 2 * HOUR);
    expect(second.at).toBe(first.at);
    expect(serverNow(OTHER)).toBe(NOW - 2 * HOUR);
    expect(second.estimated).toBeUndefined();
  });

  it('C2-07: correcting the device wall clock while offline never backdates the next position', () => {
    jest.useFakeTimers({ now: NOW + HOUR });
    const test = createTestDownloads();
    noteServerDate(DEV, new Date(NOW).toUTCString(), Date.now());
    const first = test.manager.recordPosition(TEST_ACCOUNT_KEY, 'tmdb-movie-603', 10, 100);
    // System/NTP corrects the device's clock, with no new server answer while offline.
    jest.setSystemTime(NOW + 1000);
    const second = test.manager.recordPosition(TEST_ACCOUNT_KEY, 'tmdb-movie-603', 20, 100);
    expect(second.at).toBeGreaterThanOrEqual(first.at);
    expect(first.at).toBe(NOW);
    jest.advanceTimersByTime(10_000);
    const third = test.manager.recordPosition(TEST_ACCOUNT_KEY, 'tmdb-movie-603', 30, 100);
    expect(third.at - NOW).toBe(10_000);
    expect(third.estimated).toBeUndefined();
  });

  it('a wall clock set forward while offline does not stamp positions in the future', () => {
    jest.useFakeTimers({ now: NOW });
    noteServerDate(DEV, new Date(NOW + 2 * HOUR).toUTCString(), Date.now());
    jest.advanceTimersByTime(60_000);
    jest.setSystemTime(Date.now() + 5 * HOUR);
    expect(serverNow(DEV) - NOW).toBe(2 * HOUR + 60_000);
  });

  it('after a reboot (another boot id) the learned offset is an estimate with its uncertainty', () => {
    setElapsedClock(() => ({ elapsedMs: 50_000, bootId: 'boot-1' }));
    noteServerDate(DEV, new Date(NOW + HOUR).toUTCString(), NOW);
    expect(serverStamp(DEV, NOW)).toEqual({ at: NOW + HOUR, estimated: false, uncertaintyMs: 0 });
    setElapsedClock(() => ({ elapsedMs: 1_000, bootId: 'boot-2' }));
    expect(serverStamp(DEV, NOW)).toEqual({
      at: NOW + HOUR,
      estimated: true,
      uncertaintyMs: HOUR + ESTIMATE_MARGIN_MS,
    });
    const test = createTestDownloads({ now: () => NOW });
    expect(test.manager.recordPosition(TEST_ACCOUNT_KEY, 'tmdb-movie-603', 10, 100)).toMatchObject({
      at: NOW + HOUR,
      estimated: true,
      uncertaintyMs: HOUR + ESTIMATE_MARGIN_MS,
    });
  });

  it('a server never heard from is an estimate; a clock without an answer falls back to this process (an estimate)', () => {
    expect(serverStamp(DEV, NOW)).toEqual({
      at: NOW,
      estimated: true,
      uncertaintyMs: ESTIMATE_MARGIN_MS,
    });
    setElapsedClock(() => null);
    noteServerDate(DEV, new Date(NOW - HOUR).toUTCString(), NOW);
    expect(serverStamp(DEV, NOW)).toEqual({
      at: NOW - HOUR,
      estimated: true,
      uncertaintyMs: HOUR + ESTIMATE_MARGIN_MS,
    });
  });

  it('offline progress is sent with the time it happened on its server clock', async () => {
    const now = Date.now();
    noteServerDate('http://clock.test', new Date(now + HOUR).toUTCString(), now);
    noteServerDate(OTHER, new Date(now - HOUR).toUTCString(), now);
    const report = { event: 'stop', workId: 'tmdb-movie-9761', positionTicks: 10 } as const;
    enqueueProgress('clock-1', report, undefined, 'http://clock.test');
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

  it('local positions of downloads are stamped on their server clock', () => {
    const now = Date.now();
    noteServerDate(DEV, new Date(now - HOUR).toUTCString(), now);
    const test = createTestDownloads();
    const position = test.manager.recordPosition(TEST_ACCOUNT_KEY, 'tmdb-movie-9761', 60, 600);
    expect(Math.round((position.at - Date.now()) / 60_000)).toBe(-60);
  });
});

describe('the engine clock (C2-07, downloadEngine.clock())', () => {
  /** The fake engine's clock with an injected wall clock: it moves only by `advanceElapsed`, a reboot resets it. */
  function engineAt(wall: { now: number }) {
    const engine = createFakeDownloadEngine({ now: () => wall.now, elapsedMs: 10_000 });
    setElapsedClock(() => engine.clock());
    return engine;
  }

  it('is the default source: without a native clock (jest) it answers a process- boot id', () => {
    setElapsedClock(null);
    expect(downloadEngine.clock().bootId).toMatch(/^process-/);
    noteServerDate(DEV, new Date(NOW - HOUR).toUTCString(), NOW);
    expect(serverStamp(DEV, NOW).estimated).toBe(true);
  });

  it('a real boot id: stamps derive from elapsed time, a wall-clock step while offline never shifts them', () => {
    jest.useFakeTimers({ now: NOW });
    const wall = { now: NOW };
    const engine = engineAt(wall);
    noteServerDate(DEV, new Date(NOW + 2 * HOUR).toUTCString(), Date.now());
    // 30 min offline, then NTP steps the wall clock back an hour.
    engine.controls.advanceElapsed(30 * 60_000);
    jest.setSystemTime(NOW + 30 * 60_000 - HOUR);
    expect(serverStamp(DEV)).toEqual({
      at: NOW + 2 * HOUR + 30 * 60_000,
      estimated: false,
      uncertaintyMs: 0,
    });
    // And forward by five hours: still exact.
    jest.setSystemTime(NOW + 30 * 60_000 + 5 * HOUR);
    expect(serverNow(DEV)).toBe(NOW + 2 * HOUR + 30 * 60_000);
  });

  it('a reboot (new boot id) drops the anchor: estimated stamps until the next server answer', () => {
    jest.useFakeTimers({ now: NOW });
    const wall = { now: NOW };
    const engine = engineAt(wall);
    noteServerDate(DEV, new Date(NOW + HOUR).toUTCString(), Date.now());
    expect(serverStamp(DEV).estimated).toBe(false);
    engine.controls.reboot();
    expect(engine.clock().bootId).toBe('fake-boot-2');
    expect(serverStamp(DEV)).toEqual({
      at: NOW + HOUR,
      estimated: true,
      uncertaintyMs: HOUR + ESTIMATE_MARGIN_MS,
    });
    const test = createTestDownloads({ now: () => NOW });
    expect(test.manager.recordPosition(TEST_ACCOUNT_KEY, 'tmdb-movie-603', 10, 100)).toMatchObject({
      estimated: true,
    });
    // The next answer anchors this boot again.
    noteServerDate(DEV, new Date(NOW + HOUR).toUTCString(), Date.now());
    expect(serverStamp(DEV)).toEqual({ at: NOW + HOUR, estimated: false, uncertaintyMs: 0 });
  });

  it('a process- boot id: every app start counts as a new boot (stamps stay estimates)', () => {
    const storage = createMemoryDownloadsStorage();
    resetServerClock(storage);
    setElapsedClock(() => ({ elapsedMs: 5_000, bootId: 'process-start-1' }));
    noteServerDate(DEV, new Date(NOW + HOUR).toUTCString(), NOW);
    expect(serverStamp(DEV, NOW)).toMatchObject({ at: NOW + HOUR, estimated: true });
    // The next app start: another process id over the same storage, still only an estimate.
    resetServerClock(storage);
    setElapsedClock(() => ({ elapsedMs: 5_000, bootId: 'process-start-2' }));
    expect(serverStamp(DEV, NOW)).toMatchObject({ at: NOW + HOUR, estimated: true });
    // The same values under a real boot id are exact.
    setElapsedClock(() => ({ elapsedMs: 5_000, bootId: 'boot-a' }));
    noteServerDate(DEV, new Date(NOW + HOUR).toUTCString(), NOW);
    expect(serverStamp(DEV, NOW)).toMatchObject({ at: NOW + HOUR, estimated: false });
  });
});
