// hls.js hides response headers, so its retries use a fixed backoff and the ladder shows its own wait (B13b).

/** The HTTP status of the last failed hls.js request; undefined after the next success. */
export type LoadStatus = { status?: number };

/** Statuses that say the session or stream is gone: retrying the same URL cannot help, the ladder starts anew. */
const GONE = new Set([401, 403, 404, 410]);

/** hls.js retries a failed fragment this often itself, 1 s then 2 s then 4 s apart; then the ladder (no double loop). */
export const FRAG_ERROR_RETRIES = 3;
export const FRAG_RETRY_DELAY_MS = 1_000;
export const FRAG_RETRY_MAX_DELAY_MS = 4_000;

type Callbacks = {
  onSuccess: (...args: unknown[]) => void;
  onError: (error: unknown, context: unknown, details: unknown, stats: unknown) => void;
};
type LoaderClass = new (...args: any[]) => {
  load(context: unknown, config: unknown, callbacks: Callbacks): void;
};

/** hls.js's own loader, noting each failed answer's status before hls.js decides whether to retry. */
export function statusLoader<T extends LoaderClass>(Base: T, last: LoadStatus): T {
  return class extends Base {
    load(context: unknown, config: unknown, callbacks: Callbacks): void {
      super.load(context, config, {
        ...callbacks,
        onSuccess: (...args) => {
          last.status = undefined;
          callbacks.onSuccess(...args);
        },
        onError: (error, loaderContext, details, stats) => {
          last.status = (error as { code?: number } | null)?.code;
          callbacks.onError(error, loaderContext, details, stats);
        },
      });
    }
  };
}

/** A transcode slower than real time answers late: 30 s to the first byte (C08); fixed backoff; no retries when gone. */
export function fragLoadPolicy(last: LoadStatus) {
  return {
    default: {
      maxTimeToFirstByteMs: 30_000,
      maxLoadTimeMs: 120_000,
      timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: {
        // hls.js retries a single-level stream even on a 4xx; a gone session goes to the ladder at once (S9a C10).
        get maxNumRetry() {
          return last.status !== undefined && GONE.has(last.status) ? 0 : FRAG_ERROR_RETRIES;
        },
        retryDelayMs: FRAG_RETRY_DELAY_MS,
        maxRetryDelayMs: FRAG_RETRY_MAX_DELAY_MS,
      },
    },
  };
}
