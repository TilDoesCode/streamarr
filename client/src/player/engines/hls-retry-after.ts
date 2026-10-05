/** The last failed hls.js request: its `Retry-After` (ms) and HTTP status; reset by the next success. */
export type RetryAfterHint = { ms: number; status?: number };

/** Statuses that say the session or stream is gone: retrying the same URL cannot help, the ladder starts anew. */
const GONE = new Set([401, 403, 404, 410]);

type NetworkDetails = {
  getResponseHeader?(name: string): string | null;
  headers?: { get(name: string): string | null };
} | null;

/** Reads `Retry-After` (seconds) from hls.js's network details: an XHR, or a fetch Response. */
export function retryAfterMs(details: unknown): number {
  const source = details as NetworkDetails | undefined;
  let raw: string | null = null;
  try {
    raw = source?.getResponseHeader?.('Retry-After') ?? source?.headers?.get('Retry-After') ?? null;
  } catch {
    raw = null;
  }
  const seconds = raw === null ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

type Callbacks = {
  onSuccess: (...args: unknown[]) => void;
  onError: (error: unknown, context: unknown, details: unknown, stats: unknown) => void;
};
type LoaderClass = new (...args: any[]) => {
  load(context: unknown, config: unknown, callbacks: Callbacks): void;
};

/** hls.js's own loader, noting each failed answer's `Retry-After` before hls.js computes its retry delay. */
export function retryAfterLoader<T extends LoaderClass>(Base: T, hint: RetryAfterHint): T {
  return class extends Base {
    load(context: unknown, config: unknown, callbacks: Callbacks): void {
      super.load(context, config, {
        ...callbacks,
        onSuccess: (...args) => {
          hint.ms = 0;
          hint.status = undefined;
          callbacks.onSuccess(...args);
        },
        onError: (error, loaderContext, details, stats) => {
          hint.ms = retryAfterMs(details);
          hint.status = (error as { code?: number } | null)?.code;
          callbacks.onError(error, loaderContext, details, stats);
        },
      });
    }
  };
}

/** Fragment retries never come sooner than the server's `Retry-After` (B13: 503/504 carry it); 3 retries, then the ladder. */
export function retryAfterPolicy(hint: RetryAfterHint) {
  return {
    default: {
      maxTimeToFirstByteMs: 30_000,
      maxLoadTimeMs: 120_000,
      timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: {
        // hls.js retries a single-level stream even on a 4xx; a gone session goes to the ladder at once (S9a C10).
        get maxNumRetry() {
          return hint.status !== undefined && GONE.has(hint.status) ? 0 : FRAG_ERROR_RETRIES;
        },
        get retryDelayMs() {
          return Math.max(1_000, hint.ms);
        },
        get maxRetryDelayMs() {
          return Math.max(8_000, hint.ms);
        },
      },
    },
  };
}

/** hls.js retries a failed fragment this often itself; the ladder's reload follows (no double retry loop). */
export const FRAG_ERROR_RETRIES = 3;
