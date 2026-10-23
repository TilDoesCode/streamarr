import { AppError } from '@/api/errors';

import {
  latencyWarning,
  pingStats,
  runSpeedTest,
  tierPasses,
  verdictFor,
  type SpeedProgress,
  type SpeedTransport,
  type TransferFn,
} from '../speed-test';

const STEP_MS = 50;

/** A link of `mbps` shared by the running transfers, delivering bytes every 50 ms. */
function link(mbps: number, track?: { active: number; peak: number; sizes: number[] }): TransferFn {
  const bytesPerMs = (mbps * 1_000_000) / 8 / 1000;
  let active = 0;
  return (bytes, onBytes, signal) =>
    new Promise((resolve, reject) => {
      active++;
      track?.sizes.push(bytes);
      if (track) {
        track.active = active;
        track.peak = Math.max(track.peak, active);
      }
      let sent = 0;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        active--;
        if (track) track.active = active;
      };
      const timer = setInterval(() => {
        const step = Math.min(bytes - sent, (bytesPerMs * STEP_MS) / Math.max(1, active));
        sent += step;
        onBytes(step);
        if (sent >= bytes) {
          done();
          resolve();
        }
      }, STEP_MS);
      signal.addEventListener('abort', () => {
        if (finished) return;
        done();
        reject(new AppError('aborted'));
      });
    });
}

function transport(overrides: Partial<SpeedTransport> = {}): SpeedTransport {
  let n = 0;
  const rtts = [20, 24, 18, 30, 22, 20, 26, 21, 19];
  return {
    ping: () =>
      new Promise((resolve) => {
        const rtt = rtts[n++ % rtts.length]!;
        setTimeout(() => resolve(rtt), rtt);
      }),
    download: link(200),
    upload: link(40),
    ...overrides,
  };
}

async function run(options: Parameters<typeof runSpeedTest>[0]) {
  const promise = runSpeedTest({ phaseMs: 4_000, warmupMs: 1_000, ...options });
  const settled = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await jest.advanceTimersByTimeAsync(30_000);
  return settled;
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('verdict', () => {
  it('picks the best quality the download carries with 25 % headroom', () => {
    expect(verdictFor(100)).toBe('uhdRemux');
    expect(verdictFor(99)).toBe('uhd');
    expect(verdictFor(31.25)).toBe('uhd');
    expect(verdictFor(31)).toBe('fhd');
    expect(verdictFor(12.5)).toBe('fhd');
    expect(verdictFor(12)).toBe('hd');
    expect(verdictFor(6.25)).toBe('hd');
    expect(verdictFor(6)).toBe('tooSlow');
    expect(tierPasses('fhd', 40)).toBe(true);
    expect(tierPasses('uhd', 30)).toBe(false);
  });

  it('flags long or uneven round trips', () => {
    expect(latencyWarning({ pingMs: 20, jitterMs: 5 })).toBe(false);
    expect(latencyWarning({ pingMs: 140, jitterMs: 5 })).toBe(true);
    expect(latencyWarning({ pingMs: 20, jitterMs: 45 })).toBe(true);
  });

  it('takes the median ping and the mean step between pings as jitter', () => {
    expect(pingStats([10, 30, 20])).toEqual({ pingMs: 20, jitterMs: 15 });
    expect(pingStats([10, 20, 30, 40])).toEqual({ pingMs: 25, jitterMs: 10 });
    expect(pingStats([])).toEqual({ pingMs: 0, jitterMs: 0 });
  });
});

describe('runSpeedTest', () => {
  it('measures ping, download and upload over parallel adaptive transfers', async () => {
    const track = { active: 0, peak: 0, sizes: [] as number[] };
    const progress: SpeedProgress[] = [];
    const outcome = await run({
      transport: transport({ download: link(200, track) }),
      limits: { maxParallelTransfers: 3 },
      onProgress: (p) => progress.push(p),
    });

    if (!('value' in outcome)) throw outcome.error;
    const result = outcome.value;
    expect(result.pingMs).toBe(21.5);
    expect(result.jitterMs).toBeGreaterThan(0);
    expect(result.downloadMbps).toBeGreaterThan(180);
    expect(result.downloadMbps).toBeLessThan(220);
    expect(result.uploadMbps).toBeGreaterThan(36);
    expect(result.uploadMbps).toBeLessThan(44);
    expect(track.peak).toBe(3);
    // Chunks grow from 1 MiB towards about one second of transfer each.
    expect(Math.max(...track.sizes)).toBeGreaterThan(4 * 1024 * 1024);

    const phases = progress.map((p) => p.phase).filter((p, i, all) => p !== all[i - 1]);
    expect(phases).toEqual(['ping', 'download', 'upload']);
    const fractions = progress.map((p) => p.fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(Math.max(...fractions)).toBeLessThanOrEqual(1);
    expect(progress.some((p) => p.phase === 'download' && (p.liveMbps ?? 0) > 150)).toBe(true);
  });

  it('never asks for more than the server allows per request', async () => {
    const track = { active: 0, peak: 0, sizes: [] as number[] };
    await run({
      transport: transport({ download: link(1_000, track) }),
      limits: { maxDownloadBytes: 2 * 1024 * 1024 },
    });
    expect(Math.max(...track.sizes)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('waits and retries when the server says it is busy', async () => {
    let busy = 3;
    const fast = link(100);
    const outcome = await run({
      transport: transport({
        download: (bytes, onBytes, signal) =>
          busy-- > 0
            ? Promise.reject(
                busy === 0
                  ? new AppError('rate_limited', { status: 429, retryAfter: 2 })
                  : new AppError('speedtest_busy', { status: 429 })
              )
            : fast(bytes, onBytes, signal),
      }),
    });
    if (!('value' in outcome)) throw outcome.error;
    expect(outcome.value.downloadMbps).toBeGreaterThan(80);
  });

  it('stops at the rate limit instead of retrying', async () => {
    let calls = 0;
    const outcome = await run({
      transport: transport({
        download: () => {
          calls++;
          return Promise.reject(new AppError('rate_limited', { status: 429 }));
        },
      }),
    });
    expect('error' in outcome && (outcome.error as AppError).code).toBe('rate_limited');
    expect(calls).toBeLessThanOrEqual(4);
  });

  it('fails with the transport error when nothing could be transferred', async () => {
    const outcome = await run({
      transport: transport({ download: () => Promise.reject(new AppError('network_unreachable')) }),
    });
    expect('error' in outcome && (outcome.error as AppError).code).toBe('network_unreachable');
  });

  it('stops all transfers when cancelled', async () => {
    const controller = new AbortController();
    const track = { active: 0, peak: 0, sizes: [] as number[] };
    const promise = runSpeedTest({
      transport: transport({ download: link(100, track) }),
      signal: controller.signal,
      phaseMs: 4_000,
    }).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(1_500);
    controller.abort();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(((await promise) as AppError).code).toBe('aborted');
    expect(track.active).toBe(0);
  });
});
