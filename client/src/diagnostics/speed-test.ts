import { AppError, isAppError } from '@/api/errors';

/** One transfer against the server; `onBytes` receives each newly transferred amount. */
export type TransferFn = (
  bytes: number,
  onBytes: (delta: number) => void,
  signal: AbortSignal
) => Promise<void>;

export type SpeedTransport = {
  /** One round trip in milliseconds. */
  ping(signal: AbortSignal): Promise<number>;
  download: TransferFn;
  upload: TransferFn;
};

export type SpeedLimits = {
  maxDownloadBytes: number;
  maxUploadBytes: number;
  maxParallelTransfers: number;
};

export type SpeedPhase = 'ping' | 'download' | 'upload';

export type SpeedProgress = {
  phase: SpeedPhase;
  /** 0..1 over the whole test. */
  fraction: number;
  /** Throughput over the last seconds of the running transfer phase. */
  liveMbps?: number;
  pingMs?: number;
  jitterMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
};

export type SpeedResult = {
  pingMs: number;
  jitterMs: number;
  downloadMbps: number;
  uploadMbps: number;
};

export type SpeedTestOptions = {
  transport: SpeedTransport;
  limits?: Partial<SpeedLimits>;
  onProgress?: (progress: SpeedProgress) => void;
  signal?: AbortSignal;
  now?: () => number;
  pings?: number;
  phaseMs?: number;
  /** Bytes moved during the first part of a phase (TCP slow start) are left out of the result. */
  warmupMs?: number;
  streams?: number;
};

export const SPEED_TEST_DEFAULTS = {
  pings: 6,
  phaseMs: 8_000,
  warmupMs: 1_500,
  streams: 4,
} as const;

const MIB = 1024 * 1024;
const LIVE_WINDOW_MS = 2_000;
const TICK_MS = 250;
const BUSY_RETRY_MS = 500;
// Downloads are one long request per stream (cut off at the end of the phase); uploads are a few large bodies.
const SIZES = {
  download: { first: 2048 * MIB, min: 16 * MIB, max: 2048 * MIB },
  upload: { first: 8 * MIB, min: 1 * MIB, max: 64 * MIB },
} as const;

/** Typical sustained bitrates (Mbit/s) a stream of each quality needs; the verdict adds HEADROOM on top. */
export const QUALITY_TIERS = [
  { id: 'uhdRemux', mbps: 80 },
  { id: 'uhd', mbps: 25 },
  { id: 'fhd', mbps: 10 },
  { id: 'hd', mbps: 5 },
] as const;

export type QualityTier = (typeof QUALITY_TIERS)[number]['id'];
export type SpeedVerdict = QualityTier | 'tooSlow';

/** Spikes and other traffic on the line: a tier counts as good only with this much spare bandwidth. */
export const HEADROOM = 1.25;
export const HIGH_PING_MS = 100;
export const HIGH_JITTER_MS = 30;

export function verdictFor(downloadMbps: number): SpeedVerdict {
  return QUALITY_TIERS.find((tier) => downloadMbps >= tier.mbps * HEADROOM)?.id ?? 'tooSlow';
}

export function tierPasses(tier: QualityTier, downloadMbps: number): boolean {
  const entry = QUALITY_TIERS.find((item) => item.id === tier);
  return !!entry && downloadMbps >= entry.mbps * HEADROOM;
}

/** Long or uneven round trips make starts and seeks slow even on a fast line. */
export function latencyWarning(result: Pick<SpeedResult, 'pingMs' | 'jitterMs'>): boolean {
  return result.pingMs > HIGH_PING_MS || result.jitterMs > HIGH_JITTER_MS;
}

export function toMbps(bytes: number, ms: number): number {
  return ms > 0 ? (bytes * 8) / 1_000 / ms : 0;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median round trip and the mean difference between consecutive round trips. */
export function pingStats(samples: number[]): { pingMs: number; jitterMs: number } {
  if (samples.length === 0) return { pingMs: 0, jitterMs: 0 };
  let diff = 0;
  for (let i = 1; i < samples.length; i++) diff += Math.abs(samples[i]! - samples[i - 1]!);
  return {
    pingMs: median(samples),
    jitterMs: samples.length > 1 ? diff / (samples.length - 1) : 0,
  };
}

function aborted(signal?: AbortSignal) {
  return !!signal?.aborted;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

/** Too many parallel transfers on the server (short Retry-After): wait and retry. A rate limit ends the test instead. */
function isBusy(error: unknown) {
  if (!isAppError(error) || error.status !== 429) return false;
  return (
    error.code === 'speedtest_busy' || (error.retryAfter !== undefined && error.retryAfter <= 5)
  );
}

type Meter = { add(delta: number): void; live(): number; result(end: number): number };

function createMeter(now: () => number, start: number, warmupMs: number): Meter {
  const samples: { at: number; total: number }[] = [{ at: start, total: 0 }];
  let total = 0;
  let warm: { at: number; total: number } | undefined;
  return {
    add(delta) {
      const at = now();
      if (!warm && at - start >= warmupMs) warm = { at, total };
      total += delta;
      samples.push({ at, total });
      while (samples.length > 2 && samples[1]!.at < at - LIVE_WINDOW_MS) samples.shift();
    },
    live() {
      const first = samples[0]!;
      const last = samples[samples.length - 1]!;
      return toMbps(last.total - first.total, Math.max(now(), last.at) - first.at);
    },
    result(end) {
      if (warm && end - warm.at >= 500) return toMbps(total - warm.total, end - warm.at);
      return toMbps(total, end - start);
    },
  };
}

/** Parallel transfers for `phaseMs`: each stream keeps one long request open and the phase end aborts it. */
async function measure(
  transfer: TransferFn,
  sizes: { first: number; min: number; max: number },
  maxBytes: number,
  streams: number,
  options: Required<Pick<SpeedTestOptions, 'now' | 'phaseMs' | 'warmupMs'>> & {
    signal?: AbortSignal;
    onLive: (mbps: number, elapsed: number) => void;
  }
): Promise<number> {
  const { now, phaseMs, warmupMs } = options;
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop);
  const start = now();
  const meter = createMeter(now, start, warmupMs);
  const timer = setTimeout(stop, phaseMs);
  const ticker = setInterval(() => options.onLive(meter.live(), now() - start), TICK_MS);
  let moved = 0;
  let failure: unknown;
  const worker = async () => {
    let size = Math.min(sizes.first, maxBytes);
    while (!controller.signal.aborted) {
      const began = now();
      let got = 0;
      try {
        await transfer(
          size,
          (delta) => {
            got += delta;
            moved += delta;
            meter.add(delta);
          },
          controller.signal
        );
      } catch (error) {
        if (controller.signal.aborted) break;
        if (isBusy(error)) {
          await sleep(BUSY_RETRY_MS, controller.signal);
          continue;
        }
        failure = error;
        stop();
        break;
      }
      const took = Math.max(1, now() - began);
      // Size the next request to last for the rest of the phase, so a stream needs only a few requests.
      const next = (got / took) * Math.max(1_000, start + phaseMs - now()) * 1.2;
      size = Math.round(Math.min(maxBytes, sizes.max, Math.max(sizes.min, next)));
    }
  };
  try {
    await Promise.all(Array.from({ length: streams }, worker));
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
    options.signal?.removeEventListener('abort', stop);
  }
  if (aborted(options.signal)) throw new AppError('aborted');
  if (failure && moved === 0) throw failure;
  return meter.result(now());
}

/** Ping/jitter, then download and upload throughput between this device and the server. */
export async function runSpeedTest(options: SpeedTestOptions): Promise<SpeedResult> {
  const {
    transport,
    onProgress,
    signal,
    now = () => Date.now(),
    pings = SPEED_TEST_DEFAULTS.pings,
    phaseMs = SPEED_TEST_DEFAULTS.phaseMs,
    warmupMs = SPEED_TEST_DEFAULTS.warmupMs,
  } = options;
  const limits: SpeedLimits = {
    maxDownloadBytes: options.limits?.maxDownloadBytes ?? 2048 * MIB,
    maxUploadBytes: options.limits?.maxUploadBytes ?? 100 * MIB,
    maxParallelTransfers: options.limits?.maxParallelTransfers ?? SPEED_TEST_DEFAULTS.streams,
  };
  const streams = Math.max(
    1,
    Math.min(options.streams ?? SPEED_TEST_DEFAULTS.streams, limits.maxParallelTransfers)
  );
  // Weights of the three phases in the overall progress bar.
  const pingShare = 0.1;
  const transferShare = (1 - pingShare) / 2;

  const pingSignal = signal ?? new AbortController().signal;
  await transport.ping(pingSignal);
  const samples: number[] = [];
  for (let i = 0; i < pings; i++) {
    if (aborted(signal)) throw new AppError('aborted');
    samples.push(await transport.ping(pingSignal));
    onProgress?.({ phase: 'ping', fraction: (pingShare * (i + 1)) / pings, ...pingStats(samples) });
  }
  const { pingMs, jitterMs } = pingStats(samples);

  const downloadMbps = await measure(
    transport.download,
    SIZES.download,
    limits.maxDownloadBytes,
    streams,
    {
      now,
      phaseMs,
      warmupMs,
      signal,
      onLive: (liveMbps, elapsed) =>
        onProgress?.({
          phase: 'download',
          fraction: pingShare + transferShare * Math.min(1, elapsed / phaseMs),
          liveMbps,
          pingMs,
          jitterMs,
        }),
    }
  );

  const uploadMbps = await measure(transport.upload, SIZES.upload, limits.maxUploadBytes, streams, {
    now,
    phaseMs,
    warmupMs,
    signal,
    onLive: (liveMbps, elapsed) =>
      onProgress?.({
        phase: 'upload',
        fraction: pingShare + transferShare * (1 + Math.min(1, elapsed / phaseMs)),
        liveMbps,
        pingMs,
        jitterMs,
        downloadMbps,
      }),
  });

  return { pingMs, jitterMs, downloadMbps, uploadMbps };
}
