import type { ApiClient } from '@/api/client';

import { ProgressQueue, type ProgressReport } from '../progress-queue';

type Outcome = 'ok' | 'offline' | 'server' | 'rejected';

function fakeClient(outcomes: Outcome[]) {
  const sent: ProgressReport[] = [];
  const POST = jest.fn((_path: string, init: { body: ProgressReport }) => {
    const outcome = outcomes.shift() ?? 'ok';
    if (outcome === 'offline') return Promise.reject(new TypeError('Network request failed'));
    sent.push(init.body);
    const status = outcome === 'ok' ? 204 : outcome === 'server' ? 503 : 400;
    return Promise.resolve({
      data: undefined,
      error: status === 204 ? undefined : { error: { code: 'nope' } },
      response: { ok: status === 204, status, headers: new Headers() },
    });
  });
  return { client: { POST } as unknown as ApiClient, POST, sent };
}

const heartbeat = (seconds: number, playbackId = 'p1'): ProgressReport => ({
  event: 'progress',
  workId: 'w1',
  playbackId,
  positionTicks: seconds * 10_000_000,
  durationTicks: null,
});

describe('ProgressQueue', () => {
  let account = 0;
  const nextAccount = () => `account-${(account += 1)}`;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sends directly when nothing is pending', async () => {
    const { client, sent } = fakeClient(['ok']);
    const queue = new ProgressQueue(nextAccount(), client);
    await queue.report(heartbeat(10));
    expect(sent).toHaveLength(1);
    expect(queue.pending).toBe(0);
  });

  it('queues transient failures and retries them with backoff', async () => {
    const { client, sent } = fakeClient(['offline', 'server', 'ok']);
    const queue = new ProgressQueue(nextAccount(), client);
    await queue.report(heartbeat(10));
    expect(queue.pending).toBe(1);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(queue.pending).toBe(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(queue.pending).toBe(0);
    expect(sent.at(-1)?.positionTicks).toBe(10 * 10_000_000);
    queue.dispose();
  });

  it('drops permanent 4xx rejections instead of retrying', async () => {
    const { client, POST } = fakeClient(['rejected']);
    const queue = new ProgressQueue(nextAccount(), client);
    await queue.report(heartbeat(10));
    expect(queue.pending).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(POST).toHaveBeenCalledTimes(1);
  });

  it('collapses queued heartbeats of one playback but keeps start events', async () => {
    const { client } = fakeClient(['offline', 'offline', 'offline', 'offline']);
    const queue = new ProgressQueue(nextAccount(), client);
    await queue.report({ ...heartbeat(0), event: 'start' });
    await queue.report(heartbeat(10));
    await queue.report(heartbeat(20));
    expect(queue.pending).toBe(2);
    queue.dispose();
  });

  it('keeps queues of different accounts apart', async () => {
    const { client } = fakeClient(['offline', 'offline']);
    const first = new ProgressQueue(nextAccount(), client);
    await first.report(heartbeat(10));
    expect(first.pending).toBe(1);
    expect(new ProgressQueue(nextAccount(), client).pending).toBe(0);
    first.dispose();
  });

  it('flushes the backlog in order once the server is reachable', async () => {
    const { client, sent } = fakeClient(['offline', 'ok', 'ok']);
    const queue = new ProgressQueue(nextAccount(), client);
    await queue.report({ ...heartbeat(0), event: 'start' });
    await queue.report(heartbeat(10));
    await Promise.resolve();
    await jest.runOnlyPendingTimersAsync();
    expect(sent.map((report) => report.event)).toEqual(['start', 'progress']);
    expect(queue.pending).toBe(0);
  });
});
