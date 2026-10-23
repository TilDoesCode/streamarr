import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bestTier,
  DEFAULT_OPTIONS,
  jitter,
  measurePing,
  median,
  MiB,
  nextChunkBytes,
  runSpeedTest,
  SpeedTestBusyError,
  ThroughputMeter,
  tierVerdicts,
  toMbps,
  type Clock,
  type PingInfo,
  type SpeedTestProgress,
  type SpeedTestTransport,
} from "./speedtest";

const timerClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const id = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(id);
        reject(new DOMException("aborted", "AbortError"));
      });
    }),
};

const info: PingInfo = { maxDownloadBytes: 200 * MiB, maxUploadBytes: 100 * MiB, maxParallelTransfers: 6 };

/** Delivers `bytes` at `bytesPerMs` in 50 ms ticks, honouring abort. */
function stream(bytes: number, bytesPerMs: number, signal: AbortSignal, onBytes: (n: number) => void) {
  return new Promise<void>((resolve, reject) => {
    let left = bytes;
    const tick = () => {
      if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
      const n = Math.min(left, bytesPerMs * 50);
      onBytes(n);
      left -= n;
      if (left <= 0) resolve();
      else id = setTimeout(tick, 50);
    };
    let id = setTimeout(tick, 50);
    signal.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

function fakeTransport(options: {
  pingDelays?: number[];
  downBytesPerMs?: number;
  upBytesPerMs?: number;
  busyFirst?: number;
  info?: PingInfo;
}) {
  const downloads: number[] = [];
  const uploads: number[] = [];
  const delays = [...(options.pingDelays ?? [30, 10, 10, 10, 10, 10, 10, 10])];
  let busy = options.busyFirst ?? 0;
  const transport: SpeedTestTransport = {
    ping: () =>
      new Promise((resolve) => setTimeout(() => resolve(options.info ?? info), delays.shift() ?? 10)),
    download: (bytes, signal, onBytes) => {
      downloads.push(bytes);
      if (busy > 0) {
        busy--;
        return Promise.reject(new SpeedTestBusyError());
      }
      return stream(bytes, options.downBytesPerMs ?? 1_250, signal, onBytes);
    },
    upload: (bytes, signal, onBytes) => {
      uploads.push(bytes);
      return stream(bytes, options.upBytesPerMs ?? 625, signal, onBytes);
    },
  };
  return { transport, downloads, uploads };
}

describe("pure helpers", () => {
  it("computes median and jitter", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(jitter([10, 14, 12, 12])).toBeCloseTo((4 + 2 + 0) / 3);
    expect(jitter([5])).toBe(0);
  });

  it("converts bytes over time to Mbit/s", () => {
    expect(toMbps(1_250_000, 1_000)).toBe(10);
    expect(toMbps(100, 0)).toBe(0);
  });

  it("adapts chunk sizes toward the target duration within bounds", () => {
    expect(nextChunkBytes(MiB, 250, 1_000, 256 * 1024, 64 * MiB)).toBe(4 * MiB);
    // Growth is capped at ×4 even when the request was extremely fast.
    expect(nextChunkBytes(MiB, 10, 1_000, 256 * 1024, 64 * MiB)).toBe(4 * MiB);
    expect(nextChunkBytes(MiB, 4_000, 1_000, 256 * 1024, 64 * MiB)).toBe(256 * 1024);
    expect(nextChunkBytes(32 * MiB, 100, 1_000, 256 * 1024, 64 * MiB)).toBe(64 * MiB);
  });

  it("measures live rate over a sliding window and excludes the warm-up", () => {
    const meter = new ThroughputMeter(0);
    // Slow start: 125 kB in the first 1.5 s, then 1.25 MB per second.
    meter.add(125_000, 1_500);
    for (let t = 2_000; t <= 8_000; t += 500) meter.add(625_000, t);
    expect(meter.steadyMbps(8_000, 1_500)).toBeCloseTo(10);
    expect(meter.liveMbps(8_000, 2_000)).toBeCloseTo(10);
    expect(meter.bytes).toBe(125_000 + 13 * 625_000);
  });

  it("rates streaming tiers with 1.25× headroom", () => {
    expect(tierVerdicts(100).map((t) => t.passes)).toEqual([true, true, true, true]);
    expect(tierVerdicts(99.9).map((t) => t.passes)).toEqual([false, true, true, true]);
    expect(bestTier(31.25)?.id).toBe("4k");
    expect(bestTier(12.5)?.id).toBe("1080p");
    expect(bestTier(12.4)?.id).toBe("720p");
    expect(bestTier(6.25)?.id).toBe("720p");
    expect(bestTier(6)).toBeNull();
  });
});

describe("speed test orchestration", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("ignores the first ping as warm-up", async () => {
    const { transport } = fakeTransport({ pingDelays: [500, 20, 24, 18, 20, 22, 20, 20] });
    const promise = measurePing(transport, timerClock, 8, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;
    expect(result.pingMs).toBe(20);
    expect(result.jitterMs).toBeCloseTo((4 + 6 + 2 + 2 + 2 + 0) / 6);
    expect(result.info).toEqual(info);
  });

  it("measures download and upload with parallel streams and reports live progress", async () => {
    // 4 streams × 1250 B/ms = 40 Mbit/s down; 4 × 625 B/ms = 20 Mbit/s up.
    const { transport, downloads, uploads } = fakeTransport({});
    const updates: SpeedTestProgress[] = [];
    const promise = runSpeedTest(transport, timerClock, new AbortController().signal, (p) => updates.push(p));
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await promise;

    expect(result.pingMs).toBe(10);
    // Request turnaround gaps cost a little throughput, as on a real link.
    expect(result.downloadMbps).toBeGreaterThan(38);
    expect(result.downloadMbps).toBeLessThanOrEqual(40.5);
    expect(result.uploadMbps).toBeGreaterThan(19);
    expect(result.uploadMbps).toBeLessThanOrEqual(20.5);
    // One long download per stream, cut off at the phase end; a few large uploads.
    expect(downloads).toEqual([200 * MiB, 200 * MiB, 200 * MiB, 200 * MiB]);
    expect(uploads[0]).toBe(8 * MiB);
    expect(uploads.length).toBeLessThanOrEqual(12);
    expect(Math.max(...downloads)).toBeLessThanOrEqual(200 * MiB);
    expect(Math.max(...uploads)).toBeLessThanOrEqual(64 * MiB);
    expect(updates.some((u) => u.phase === "download" && (u.liveMbps ?? 0) > 30)).toBe(true);
    expect(updates.some((u) => u.phase === "upload" && (u.liveMbps ?? 0) > 15)).toBe(true);
    expect(updates.at(-1)?.phase).toBe("done");
  });

  it("caps chunk sizes at the server maximum and the stream count at the parallel limit", async () => {
    const { transport, downloads } = fakeTransport({
      downBytesPerMs: 50_000,
      info: { maxDownloadBytes: 2 * MiB, maxUploadBytes: MiB, maxParallelTransfers: 2 },
    });
    let inFlight = 0;
    let peak = 0;
    const download = transport.download;
    transport.download = async (bytes, signal, onBytes) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await download(bytes, signal, onBytes);
      } finally {
        inFlight--;
      }
    };
    const promise = runSpeedTest(transport, timerClock, new AbortController().signal, () => {});
    await vi.advanceTimersByTimeAsync(20_000);
    await promise;
    expect(Math.max(...downloads)).toBe(2 * MiB);
    expect(peak).toBe(2);
  });

  it("needs about 20 requests per test and runs each phase for the full 8 s, three tests in a row", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { transport, downloads, uploads } = fakeTransport({});
      let pings = 0;
      const ping = transport.ping;
      transport.ping = (...args) => {
        pings++;
        return ping(...args);
      };
      const updates: SpeedTestProgress[] = [];
      const promise = runSpeedTest(transport, timerClock, new AbortController().signal, (p) => updates.push(p));
      await vi.advanceTimersByTimeAsync(20_000);
      await promise;
      expect(pings + downloads.length + uploads.length).toBeLessThanOrEqual(20);
      for (const phase of ["download", "upload"] as const)
        expect(Math.max(...updates.filter((u) => u.phase === phase).map((u) => u.phaseProgress ?? 0))).toBe(1);
    }
  });

  it("waits and retries when the server is busy", async () => {
    const { transport, downloads } = fakeTransport({ busyFirst: 2 });
    const promise = runSpeedTest(
      transport,
      timerClock,
      new AbortController().signal,
      () => {},
      { ...DEFAULT_OPTIONS, streams: 1 },
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await promise;
    expect(downloads.slice(0, 3)).toEqual([200 * MiB, 200 * MiB, 200 * MiB]);
    expect(result.downloadMbps).toBeGreaterThan(9);
  });

  it("propagates transport failures", async () => {
    const { transport } = fakeTransport({});
    transport.download = () => Promise.reject(new Error("boom"));
    const promise = runSpeedTest(transport, timerClock, new AbortController().signal, () => {});
    const assertion = expect(promise).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("stops promptly when cancelled", async () => {
    const { transport } = fakeTransport({});
    const controller = new AbortController();
    const promise = runSpeedTest(transport, timerClock, controller.signal, () => {});
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(3_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });
});
