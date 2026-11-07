import type { ApiClient } from '@/api/client';

import {
  drainProgress,
  enqueueProgress,
  flushAllProgress,
  pendingProgress,
  type ProgressReport,
} from '../progress-queue';

function fakeClient(fail = false) {
  const sent: ProgressReport[] = [];
  const client = {
    POST: jest.fn((_path: string, init: { body: ProgressReport }) => {
      if (fail) return Promise.reject(new TypeError('Network request failed'));
      sent.push(init.body);
      return Promise.resolve({
        data: undefined,
        response: { ok: true, status: 204, headers: new Headers() },
      });
    }),
  } as unknown as ApiClient;
  return { client, sent };
}

const report = (event: 'start' | 'progress' | 'stop', seconds: number): ProgressReport => ({
  event,
  workId: 'tmdb-movie-603',
  playbackId: 'local-d1',
  positionTicks: seconds * 10_000_000,
});

let n = 0;
const account = () => `sync${(n += 1)}`;

describe('app-wide progress sync (DL)', () => {
  it('sends queued reports in order with the time they really happened', async () => {
    const id = account();
    enqueueProgress(id, report('start', 0), Date.parse('2026-11-01T10:00:00Z'));
    enqueueProgress(id, report('progress', 10), Date.parse('2026-11-01T10:00:10Z'));
    enqueueProgress(id, report('progress', 20), Date.parse('2026-11-01T10:00:20Z'));
    enqueueProgress(id, report('stop', 25), Date.parse('2026-11-01T10:00:25Z'));
    expect(pendingProgress(id)).toBe(3);
    const { client, sent } = fakeClient();
    await flushAllProgress([{ id, signedIn: true }], () => client);
    expect(sent.map((item) => [item.event, item.occurredAt])).toEqual([
      ['start', '2026-11-01T10:00:00.000Z'],
      ['progress', '2026-11-01T10:00:20.000Z'],
      ['stop', '2026-11-01T10:00:25.000Z'],
    ]);
    expect(pendingProgress(id)).toBe(0);
  });

  it('keeps reports of signed-out profiles and drops those of removed ones', async () => {
    const kept = account();
    const removed = account();
    enqueueProgress(kept, report('stop', 5));
    enqueueProgress(removed, report('stop', 5));
    const { client, sent } = fakeClient();
    await flushAllProgress([{ id: kept, signedIn: false }], () => client);
    expect(sent).toEqual([]);
    expect(pendingProgress(kept)).toBe(1);
    expect(pendingProgress(removed)).toBe(0);
    await flushAllProgress([{ id: kept, signedIn: true }], () => client);
    expect(pendingProgress(kept)).toBe(0);
  });

  it('keeps reports for 30 days, not 24 hours', () => {
    const id = account();
    const now = Date.now();
    enqueueProgress(id, report('stop', 1), now - 2 * 24 * 3_600_000);
    enqueueProgress(id, report('start', 1), now - 31 * 24 * 3_600_000);
    expect(pendingProgress(id)).toBe(1);
  });

  it('stops at a transport failure and leaves the backlog for the next sync', async () => {
    const id = account();
    enqueueProgress(id, report('stop', 3));
    const { client } = fakeClient(true);
    await expect(drainProgress(id, client)).resolves.toBe('retry');
    expect(pendingProgress(id)).toBe(1);
  });

  it('runs one drain per account at a time', async () => {
    const id = account();
    enqueueProgress(id, report('stop', 3));
    const { client, sent } = fakeClient();
    await Promise.all([drainProgress(id, client), drainProgress(id, client)]);
    expect(sent).toHaveLength(1);
  });

  it('C1-08: an acknowledgement never erases a replacement report from the same millisecond', async () => {
    const id = account();
    const at = Date.now();
    const report: ProgressReport = {
      event: 'progress',
      workId: 'tmdb-movie-603',
      playbackId: 'local-test',
      positionTicks: 10,
    };
    enqueueProgress(id, report, at);
    let acknowledge!: () => void;
    const pending = new Promise<void>((resolve) => (acknowledge = resolve));
    const sent: ProgressReport[] = [];
    const client = {
      POST: jest.fn(async (_path: string, init: { body: ProgressReport }) => {
        sent.push(init.body);
        await pending;
        return { data: undefined, response: { ok: true, status: 204, headers: new Headers() } };
      }),
    } as unknown as ApiClient;
    const drain = drainProgress(id, client);
    enqueueProgress(id, { ...report, positionTicks: 20 }, at);
    acknowledge();
    await drain;
    expect(pendingProgress(id)).toBe(0);
    expect(sent.map((entry) => entry.positionTicks)).toEqual([10, 20]);
  });
});
