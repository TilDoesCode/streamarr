/**
 * Browser ↔ Core Server speed test: ping/jitter, parallel download and parallel upload,
 * measured by the client against the admin `/diagnostics/…` endpoints. Everything here is
 * pure apart from the injected transport and clock, so it is unit-testable without a network.
 */

export const MiB = 1024 * 1024;

export interface PingInfo {
  maxDownloadBytes: number;
  maxUploadBytes: number;
  maxParallelTransfers: number;
}

/** Thrown by a transport when the server answers `429 speedtest_busy`. */
export class SpeedTestBusyError extends Error {
  constructor() {
    super("The server is busy with other speed tests.");
    this.name = "SpeedTestBusyError";
  }
}

export interface SpeedTestTransport {
  ping(signal: AbortSignal): Promise<PingInfo>;
  /** Download `bytes` and report every received chunk length through `onBytes`. */
  download(bytes: number, signal: AbortSignal, onBytes: (n: number) => void): Promise<void>;
  /** Upload `bytes` and report newly sent bytes through `onBytes`. */
  upload(bytes: number, signal: AbortSignal, onBytes: (n: number) => void): Promise<void>;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const browserClock: Clock = {
  now: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export interface SpeedTestOptions {
  pings: number;
  streams: number;
  durationMs: number;
  warmupMs: number;
  windowMs: number;
  targetRequestMs: number;
  busyRetryMs: number;
  updateIntervalMs: number;
  /** Request budget per transfer phase, keeping one test well inside the server's rate limit. */
  maxRequestsPerPhase: number;
  download: { initialBytes: number; minBytes: number; maxBytes: number };
  upload: { initialBytes: number; minBytes: number; maxBytes: number };
}

export const DEFAULT_OPTIONS: SpeedTestOptions = {
  pings: 8,
  streams: 4,
  durationMs: 8_000,
  warmupMs: 1_500,
  windowMs: 2_000,
  targetRequestMs: 1_000,
  busyRetryMs: 500,
  updateIntervalMs: 200,
  maxRequestsPerPhase: 150,
  download: { initialBytes: 1 * MiB, minBytes: 256 * 1024, maxBytes: 200 * MiB },
  upload: { initialBytes: 512 * 1024, minBytes: 512 * 1024, maxBytes: 64 * MiB },
};

export type SpeedTestPhase = "idle" | "ping" | "download" | "upload" | "done";

export interface SpeedTestProgress {
  phase: SpeedTestPhase;
  pingMs?: number;
  jitterMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
  /** Sliding-window rate of the running transfer phase. */
  liveMbps?: number;
  /** 0..1 within the current phase. */
  phaseProgress: number;
}

export interface SpeedTestResult {
  pingMs: number;
  jitterMs: number;
  downloadMbps: number;
  uploadMbps: number;
  downloadBytes: number;
  uploadBytes: number;
}

// ---- pure helpers ---------------------------------------------------------------------

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Mean absolute difference between consecutive samples. */
export function jitter(values: number[]): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < values.length; i++) sum += Math.abs(values[i] - values[i - 1]);
  return sum / (values.length - 1);
}

export function toMbps(bytes: number, ms: number): number {
  if (ms <= 0) return 0;
  return (bytes * 8) / (ms / 1000) / 1_000_000;
}

/** Next request size so one request takes roughly `targetMs`; growth is capped at ×4 per step. */
export function nextChunkBytes(
  previousBytes: number,
  elapsedMs: number,
  targetMs: number,
  minBytes: number,
  maxBytes: number,
): number {
  const ideal = elapsedMs > 0 ? (previousBytes * targetMs) / elapsedMs : previousBytes * 4;
  const bounded = Math.min(ideal, previousBytes * 4);
  return Math.round(Math.max(minBytes, Math.min(maxBytes, bounded)));
}

/** Cumulative-byte samples over time; answers live (sliding window) and steady-state rates. */
export class ThroughputMeter {
  private readonly samples: { t: number; total: number }[] = [];
  private total = 0;

  constructor(private readonly startedAt: number) {
    this.samples.push({ t: startedAt, total: 0 });
  }

  get bytes(): number {
    return this.total;
  }

  add(bytes: number, t: number): void {
    this.total += bytes;
    this.samples.push({ t, total: this.total });
  }

  /** Cumulative bytes at time `t` (last sample at or before it). */
  totalAt(t: number): number {
    let total = 0;
    for (const sample of this.samples) {
      if (sample.t > t) break;
      total = sample.total;
    }
    return total;
  }

  liveMbps(now: number, windowMs: number): number {
    const from = Math.max(this.startedAt, now - windowMs);
    return toMbps(this.total - this.totalAt(from), now - from);
  }

  /** Rate between `startedAt + warmupMs` and `endedAt`; whole span when the run was shorter. */
  steadyMbps(endedAt: number, warmupMs: number): number {
    const warmEnd = this.startedAt + warmupMs;
    if (endedAt - warmEnd < warmupMs / 2) return toMbps(this.totalAt(endedAt), endedAt - this.startedAt);
    return toMbps(this.totalAt(endedAt) - this.totalAt(warmEnd), endedAt - warmEnd);
  }
}

// ---- verdict --------------------------------------------------------------------------

export const HEADROOM = 1.25;

export interface StreamingTier {
  id: string;
  label: string;
  mbps: number;
}

export const STREAMING_TIERS: StreamingTier[] = [
  { id: "4k-remux", label: "4K HDR remux", mbps: 80 },
  { id: "4k", label: "4K streaming", mbps: 25 },
  { id: "1080p", label: "1080p", mbps: 10 },
  { id: "720p", label: "720p", mbps: 5 },
];

export interface TierVerdict extends StreamingTier {
  requiredMbps: number;
  passes: boolean;
}

export function tierVerdicts(downloadMbps: number): TierVerdict[] {
  return STREAMING_TIERS.map((tier) => {
    const requiredMbps = tier.mbps * HEADROOM;
    return { ...tier, requiredMbps, passes: downloadMbps >= requiredMbps };
  });
}

/** Best tier the measured download rate supports, or null when even 720p is too much. */
export function bestTier(downloadMbps: number): TierVerdict | null {
  return tierVerdicts(downloadMbps).find((tier) => tier.passes) ?? null;
}

// ---- orchestration --------------------------------------------------------------------

export function abortError(): DOMException {
  return new DOMException("The speed test was cancelled.", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

export async function measurePing(
  transport: SpeedTestTransport,
  clock: Clock,
  count: number,
  signal: AbortSignal,
  onSample?: (done: number) => void,
): Promise<{ info: PingInfo; pingMs: number; jitterMs: number }> {
  const samples: number[] = [];
  let info: PingInfo | null = null;
  for (let i = 0; i < count; i++) {
    if (signal.aborted) throw abortError();
    const started = clock.now();
    info = await transport.ping(signal);
    samples.push(clock.now() - started);
    onSample?.(i + 1);
  }
  // The first request pays for connection setup, so it is a warm-up only.
  const measured = samples.length > 1 ? samples.slice(1) : samples;
  return { info: info!, pingMs: median(measured), jitterMs: jitter(measured) };
}

interface TransferConfig {
  streams: number;
  durationMs: number;
  warmupMs: number;
  windowMs: number;
  targetRequestMs: number;
  busyRetryMs: number;
  updateIntervalMs: number;
  maxRequests: number;
  initialBytes: number;
  minBytes: number;
  maxBytes: number;
}

/** Run `streams` parallel request loops for `durationMs`; returns the steady-state Mbit/s. */
export async function measureTransfer(
  run: (bytes: number, signal: AbortSignal, onBytes: (n: number) => void) => Promise<void>,
  clock: Clock,
  config: TransferConfig,
  signal: AbortSignal,
  onLive: (liveMbps: number, phaseProgress: number) => void,
): Promise<{ mbps: number; bytes: number }> {
  if (signal.aborted) throw abortError();
  const startedAt = clock.now();
  const deadline = startedAt + config.durationMs;
  const meter = new ThroughputMeter(startedAt);
  const phase = new AbortController();
  const onOuterAbort = () => phase.abort();
  signal.addEventListener("abort", onOuterAbort, { once: true });
  let lastUpdate = -Infinity;
  let requests = 0;

  const report = (force = false) => {
    const now = clock.now();
    if (!force && now - lastUpdate < config.updateIntervalMs) return;
    lastUpdate = now;
    onLive(meter.liveMbps(now, config.windowMs), Math.min(1, (now - startedAt) / config.durationMs));
  };

  const loop = async () => {
    let chunk = Math.min(config.initialBytes, config.maxBytes);
    while (!phase.signal.aborted && clock.now() < deadline && requests < config.maxRequests) {
      requests++;
      const requestStart = clock.now();
      try {
        await run(chunk, phase.signal, (n) => {
          meter.add(n, clock.now());
          report();
        });
      } catch (error) {
        if (phase.signal.aborted) return;
        if (error instanceof SpeedTestBusyError) {
          await clock.sleep(config.busyRetryMs, phase.signal).catch(() => undefined);
          continue;
        }
        throw error;
      }
      chunk = nextChunkBytes(chunk, clock.now() - requestStart, config.targetRequestMs, config.minBytes, config.maxBytes);
    }
  };

  const timer = clock.sleep(config.durationMs, phase.signal).then(
    () => phase.abort(),
    () => undefined,
  );

  try {
    await Promise.all(Array.from({ length: config.streams }, loop));
  } catch (error) {
    phase.abort();
    throw error;
  } finally {
    signal.removeEventListener("abort", onOuterAbort);
    phase.abort();
    await timer;
  }
  if (signal.aborted) throw abortError();

  const endedAt = Math.min(clock.now(), deadline);
  report(true);
  return { mbps: meter.steadyMbps(endedAt, config.warmupMs), bytes: meter.totalAt(endedAt) };
}

export async function runSpeedTest(
  transport: SpeedTestTransport,
  clock: Clock,
  signal: AbortSignal,
  onProgress: (progress: SpeedTestProgress) => void,
  options: SpeedTestOptions = DEFAULT_OPTIONS,
): Promise<SpeedTestResult> {
  const state: SpeedTestProgress = { phase: "ping", phaseProgress: 0 };
  const emit = (patch: Partial<SpeedTestProgress>) => {
    Object.assign(state, patch);
    onProgress({ ...state });
  };

  emit({});
  const ping = await measurePing(transport, clock, options.pings, signal, (done) =>
    emit({ phaseProgress: done / options.pings }),
  );
  emit({ pingMs: ping.pingMs, jitterMs: ping.jitterMs });

  const streams = Math.max(1, Math.min(options.streams, ping.info.maxParallelTransfers || options.streams));
  const shared = {
    streams,
    durationMs: options.durationMs,
    warmupMs: options.warmupMs,
    windowMs: options.windowMs,
    targetRequestMs: options.targetRequestMs,
    busyRetryMs: options.busyRetryMs,
    updateIntervalMs: options.updateIntervalMs,
    maxRequests: options.maxRequestsPerPhase,
  };

  emit({ phase: "download", phaseProgress: 0, liveMbps: 0 });
  const download = await measureTransfer(
    (bytes, s, onBytes) => transport.download(bytes, s, onBytes),
    clock,
    { ...shared, ...capped(options.download, ping.info.maxDownloadBytes) },
    signal,
    (liveMbps, phaseProgress) => emit({ liveMbps, phaseProgress }),
  );
  emit({ downloadMbps: download.mbps });

  emit({ phase: "upload", phaseProgress: 0, liveMbps: 0 });
  const upload = await measureTransfer(
    (bytes, s, onBytes) => transport.upload(bytes, s, onBytes),
    clock,
    { ...shared, ...capped(options.upload, ping.info.maxUploadBytes) },
    signal,
    (liveMbps, phaseProgress) => emit({ liveMbps, phaseProgress }),
  );
  emit({ phase: "done", uploadMbps: upload.mbps, liveMbps: undefined, phaseProgress: 1 });

  return {
    pingMs: ping.pingMs,
    jitterMs: ping.jitterMs,
    downloadMbps: download.mbps,
    uploadMbps: upload.mbps,
    downloadBytes: download.bytes,
    uploadBytes: upload.bytes,
  };
}

function capped(sizes: { initialBytes: number; minBytes: number; maxBytes: number }, serverMax: number) {
  const maxBytes = serverMax > 0 ? Math.min(sizes.maxBytes, serverMax) : sizes.maxBytes;
  return {
    initialBytes: Math.min(sizes.initialBytes, maxBytes),
    minBytes: Math.min(sizes.minBytes, maxBytes),
    maxBytes,
  };
}
