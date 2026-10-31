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
  ceilingMbps,
  minRequestMs,
  nextTransferSize,
  REQUEST_BUDGET,
  transferSizes,
} from '../speed-test';

const MIB = 1024 * 1024;

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
  it('picks the best quality the download carries with 30 % headroom (like the server)', () => {
    expect(verdictFor(104)).toBe('uhdRemux');
    expect(verdictFor(103)).toBe('uhd');
    expect(verdictFor(32.5)).toBe('uhd');
    expect(verdictFor(32)).toBe('fhd');
    expect(verdictFor(13)).toBe('fhd');
    expect(verdictFor(12.9)).toBe('hd');
    expect(verdictFor(6.5)).toBe('hd');
    expect(verdictFor(6.4)).toBe('tooSlow');
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

describe('transfer sizing', () => {
  const sizes = { first: 2 * MIB, min: 1 * MIB, max: 8 * MIB };

  it("aims a request at about two seconds of the last request's speed", () => {
    expect(nextTransferSize(4 * MIB, 1_000, sizes, 100 * MIB)).toBe(8 * MIB);
    expect(nextTransferSize(1 * MIB, 1_000, sizes, 100 * MIB)).toBe(2 * MIB);
  });

  it('stays within the bounds and the server limit however fast or slow the link is', () => {
    expect(nextTransferSize(900 * MIB, 1_000, sizes, 100 * MIB)).toBe(8 * MIB);
    expect(nextTransferSize(1_000, 5_000, sizes, 100 * MIB)).toBe(1 * MIB);
    expect(nextTransferSize(0, 0, sizes, 100 * MIB)).toBe(1 * MIB);
    expect(nextTransferSize(900 * MIB, 1_000, sizes, 3 * MIB)).toBe(3 * MIB);
  });

  it('uses smaller requests on low-memory devices', () => {
    const tv = transferSizes(true);
    const phone = transferSizes(false);
    expect(tv.download.max).toBeLessThan(phone.download.max);
    expect(tv.upload.max).toBeLessThan(phone.upload.max);
    for (const kind of [tv, phone]) {
      expect(kind.upload.max).toBeLessThanOrEqual(16 * MIB);
      expect(kind.download.max).toBeLessThanOrEqual(256 * MIB);
    }
  });
});

describe('request budget and ceilings', () => {
  const SERVER_MAX = 2048 * MIB;
  const PHASE_MS = 8_000;
  const down = (lowMemory: boolean, streams: number) =>
    ceilingMbps(
      transferSizes(lowMemory).download,
      SERVER_MAX,
      streams,
      PHASE_MS,
      REQUEST_BUDGET.download
    );
  const up = (lowMemory: boolean, streams: number) =>
    ceilingMbps(
      transferSizes(lowMemory).upload,
      100 * MIB,
      streams,
      PHASE_MS,
      REQUEST_BUDGET.upload
    );

  it('leaves room for several tests inside the server limit of 240 requests a minute', () => {
    const perTest = 7 + REQUEST_BUDGET.download + REQUEST_BUDGET.upload;
    expect(perTest * 3).toBeLessThanOrEqual(240);
  });

  it("spaces a stream's capped requests so the phase stays within its budget", () => {
    // 3 streams, 24 requests in 8 s: one request per stream a second.
    expect(minRequestMs(PHASE_MS, 3, 24)).toBe(1_000);
    expect(minRequestMs(PHASE_MS, 3, 48)).toBe(500);
    expect(minRequestMs(PHASE_MS, 4, 48)).toBeCloseTo(667, 0);
  });

  it('lets a TV box (3 streams) measure gigabit down and 300+ Mbit/s up within the budget', () => {
    expect(down(true, 3)).toBeGreaterThanOrEqual(1_000);
    expect(up(true, 3)).toBeGreaterThanOrEqual(300);
  });

  it('lets a phone (4 streams) measure at least as much', () => {
    expect(down(false, 4)).toBeGreaterThanOrEqual(down(true, 3));
    expect(up(false, 4)).toBeGreaterThanOrEqual(up(true, 3));
  });

  it('keeps the TV upload request small: Android copies the string body once per in-flight request', () => {
    expect(transferSizes(true).upload.max * 3).toBeLessThanOrEqual(24 * MIB);
  });
});

describe('runSpeedTest', () => {
  it('runs fewer parallel streams and smaller requests on low-memory devices', async () => {
    const track = { active: 0, peak: 0, sizes: [] as number[] };
    const outcome = await run({
      transport: transport({ download: link(500, track) }),
      lowMemory: true,
    });
    if (!('value' in outcome)) throw outcome.error;
    expect(track.peak).toBe(3);
    expect(Math.max(...track.sizes)).toBeLessThanOrEqual(transferSizes(true).download.max);
  });

  it('releases the transport when the test ends, also when it fails', async () => {
    const close = jest.fn();
    await run({ transport: transport({ close }) });
    await run({
      transport: transport({
        close,
        download: () => Promise.reject(new AppError('network_unreachable')),
      }),
    });
    expect(close).toHaveBeenCalledTimes(2);
  });

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
    expect(result.pingMs).toBe(23);
    expect(result.jitterMs).toBeGreaterThan(0);
    expect(result.downloadMbps).toBeGreaterThan(180);
    expect(result.downloadMbps).toBeLessThan(220);
    expect(result.uploadMbps).toBeGreaterThan(36);
    expect(result.uploadMbps).toBeLessThan(44);
    expect(track.peak).toBe(3);
    // Bounded requests back to back: never more than the cap, and many instead of one huge one per stream.
    const caps = transferSizes().download;
    expect(Math.max(...track.sizes)).toBeLessThanOrEqual(caps.max);
    expect(Math.min(...track.sizes)).toBeGreaterThanOrEqual(caps.min);
    expect(track.sizes.length).toBeGreaterThan(3);

    const phases = progress.map((p) => p.phase).filter((p, i, all) => p !== all[i - 1]);
    expect(phases).toEqual(['ping', 'download', 'upload']);
    const fractions = progress.map((p) => p.fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(Math.max(...fractions)).toBeLessThanOrEqual(1);
    expect(progress.some((p) => p.phase === 'download' && (p.liveMbps ?? 0) > 150)).toBe(true);
  });

  // The server allows 240 speed test requests a minute: a test stays well below that so tests can follow each other.
  it.each([
    [5, 40],
    [50, 40],
    [900, 100],
    [4_000, 200],
  ])(
    'needs only a few requests per test, three tests in a row (%i Mbit/s)',
    async (mbps, budget) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        let requests = 0;
        const counted =
          (fn: TransferFn): TransferFn =>
          (...args) => {
            requests++;
            return fn(...args);
          };
        const base = transport({ download: link(mbps), upload: link(mbps / 4) });
        const outcome = await run({
          transport: {
            ping: (signal) => {
              requests++;
              return base.ping(signal);
            },
            download: counted(base.download),
            upload: counted(base.upload),
          },
          phaseMs: 8_000,
          warmupMs: 1_500,
        });
        if (!('value' in outcome)) throw outcome.error;
        expect(requests).toBeLessThanOrEqual(budget);
        expect(outcome.value.downloadMbps).toBeGreaterThan(mbps * 0.8);
      }
    }
  );

  it('paces requests on a loopback-fast link so the server rate limit (240 a minute) is never hit', async () => {
    let requests = 0;
    const counted =
      (fn: TransferFn): TransferFn =>
      (...args) => {
        requests++;
        return fn(...args);
      };
    const base = transport({ download: link(25_000), upload: link(25_000) });
    const outcome = await run({
      transport: { ...base, download: counted(base.download), upload: counted(base.upload) },
      phaseMs: 8_000,
      warmupMs: 1_500,
    });
    if (!('value' in outcome)) throw outcome.error;
    // Pings plus both phases within their budgets (a stream's first request is not paced).
    expect(requests).toBeLessThanOrEqual(
      7 + REQUEST_BUDGET.download + REQUEST_BUDGET.upload + 2 * 4 + 8
    );
    expect(outcome.value.downloadLimited).toBe(true);
    expect(outcome.value.uploadLimited).toBe(true);
    expect(outcome.value.downloadMbps).toBeGreaterThan(1_000);
  });

  it('a TV box on a gigabit link measures the download without hitting the ceiling', async () => {
    const outcome = await run({
      transport: transport({ download: link(1_000), upload: link(200) }),
      lowMemory: true,
      phaseMs: 8_000,
      warmupMs: 1_500,
    });
    if (!('value' in outcome)) throw outcome.error;
    expect(outcome.value.downloadMbps).toBeGreaterThan(900);
    expect(outcome.value.downloadLimited).toBeUndefined();
    expect(outcome.value.uploadLimited).toBeUndefined();
  });

  it('a TV box measures a 320 Mbit/s upload without hitting the ceiling', async () => {
    const outcome = await run({
      transport: transport({ download: link(300), upload: link(320) }),
      lowMemory: true,
      phaseMs: 8_000,
      warmupMs: 1_500,
    });
    if (!('value' in outcome)) throw outcome.error;
    expect(outcome.value.uploadMbps).toBeGreaterThan(290);
    expect(outcome.value.uploadLimited).toBeUndefined();
  });

  it('marks a result at the ceiling as a lower bound instead of a measurement', async () => {
    const outcome = await run({
      transport: transport({ download: link(10_000), upload: link(1_000) }),
      lowMemory: true,
      phaseMs: 8_000,
      warmupMs: 1_500,
    });
    if (!('value' in outcome)) throw outcome.error;
    expect(outcome.value.downloadLimited).toBe(true);
    expect(outcome.value.uploadLimited).toBe(true);
    // Both stay at the ceiling, never above it.
    expect(outcome.value.downloadMbps).toBeLessThanOrEqual(
      ceilingMbps(transferSizes(true).download, 2048 * MIB, 3, 8_000, REQUEST_BUDGET.download) *
        1.05
    );
    expect(outcome.value.uploadMbps).toBeLessThanOrEqual(
      ceilingMbps(transferSizes(true).upload, 100 * MIB, 3, 8_000, REQUEST_BUDGET.upload) * 1.05
    );
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
