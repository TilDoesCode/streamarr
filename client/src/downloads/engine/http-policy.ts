// Mirrors HttpPolicy.kt / HttpPolicy.swift in modules/offline-downloads (keep the three in sync).

/** Longest Retry-After the engine honours. */
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** `retry`: the engine retries natively, honouring Retry-After; `fail`: the task fails at once with kind `http`. */
export function httpStatusAction(status: number): 'retry' | 'fail' {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
    ? 'retry'
    : 'fail';
}

/** Retry-After (delta-seconds or HTTP-date) in ms, capped at one hour; null when absent or unparsable. */
export function parseRetryAfter(
  header: string | null | undefined,
  nowMs = Date.now()
): number | null {
  const value = header?.trim();
  if (!value) return null;
  // HTTP-dates start with the day name (RFC 9110); anything else that is not delta-seconds is ignored.
  const ms = /^\d+$/.test(value)
    ? Number(value) * 1000
    : /^[A-Za-z]{3}/.test(value)
      ? Date.parse(value) - nowMs
      : NaN;
  if (Number.isNaN(ms)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}
