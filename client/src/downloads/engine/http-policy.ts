// Mirrors HttpPolicy.kt / HttpPolicy.swift; vectors: modules/offline-downloads/test-vectors/http-policy.json.

/** Ordinary failed attempts (no Retry-After) without ≥ 1 MiB of progress before a task fails. */
export const MAX_ATTEMPTS = 8;
/** Shortest wait before any retry (also for `Retry-After: 0` and past dates). */
export const MIN_RETRY_MS = 2000;
export const MAX_BACKOFF_MS = 60_000;
/** Longest single Retry-After the engine honours. */
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
/** Server-directed waiting (Retry-After answers) without byte progress ends after this. */
export const MAX_SERVER_WAIT_MS = 12 * 60 * 60 * 1000;
export const PROGRESS_RESETS_ATTEMPTS_BYTES = 1024 * 1024;
/** Kept free on the volume besides the remaining bytes of every active download. */
export const RESERVE_BYTES = 64 * 1024 * 1024;
/** The only request headers a caller may set (capability URLs need none; redirects may change origin). */
export const ALLOWED_HEADERS = ['accept-language', 'user-agent'];

/** `retry`: the engine retries natively, honouring Retry-After; `fail`: the task fails at once with kind `http`. */
export function httpStatusAction(status: number): 'retry' | 'fail' {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
    ? 'retry'
    : 'fail';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

/** Epoch ms of an IMF-fixdate (RFC 9110), null for anything else or an impossible date. */
function parseHttpDate(value: string): number | null {
  const match = IMF_FIXDATE.exec(value);
  if (!match) return null;
  const [day, monthName, year, hour, minute, second] = match.slice(1) as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const month = MONTHS.indexOf(monthName);
  const [d, y, h, m, s] = [day, year, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 0 || h > 23 || m > 59 || s > 59 || d < 1) return null;
  const epoch = Date.UTC(y, month, d, h, m, s);
  return new Date(epoch).getUTCDate() === d ? epoch : null;
}

/** Retry-After (delta-seconds or IMF-fixdate) as the wait in ms: at least 2 s, at most 1 h; null when absent or invalid. */
export function parseRetryAfter(
  header: string | null | undefined,
  nowMs = Date.now()
): number | null {
  const value = header?.trim();
  if (!value) return null;
  let ms: number;
  if (/^\d+$/.test(value)) {
    // Leading zeroes carry no magnitude; clamp before multiplying so huge values never overflow (N1-09, N2-09).
    const digits = value.replace(/^0+(?=\d)/, '');
    ms = digits.length > 7 ? MAX_RETRY_AFTER_MS : Number(digits) * 1000;
  } else {
    const date = parseHttpDate(value);
    if (date === null) return null;
    ms = date - nowMs;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_MS, ms));
}

/** Wait after the n-th ordinary failed attempt: 2 s, 4 s, … 60 s. */
export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, MIN_RETRY_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 10));
}

/** `now`, `waitingSince` and `retryAt` are on a monotonic clock that keeps running in sleep (never the wall clock, N2-04). */
export type RetryState = { attempts: number; waitingSince: number | null };

export type RetryInput = {
  now: number;
  retryable: boolean;
  /** Parsed Retry-After (only for retryable statuses), else null. */
  retryAfterMs: number | null;
  /** Bytes the failed attempt wrote. */
  progressBytes: number;
};

export type RetryDecision = RetryState & { action: 'retry' | 'fail'; retryAt: number | null };

/** What a failed attempt does to a task: the same rules on Android, iOS and in the fake. */
export function decideRetry(state: RetryState, input: RetryInput): RetryDecision {
  let attempts = input.progressBytes >= PROGRESS_RESETS_ATTEMPTS_BYTES ? 0 : state.attempts;
  const waitingSince = input.progressBytes > 0 ? null : state.waitingSince;
  if (!input.retryable)
    return { action: 'fail', attempts: attempts + 1, waitingSince, retryAt: null };
  if (input.retryAfterMs !== null) {
    const since = waitingSince ?? input.now;
    const retryAt = input.now + input.retryAfterMs;
    const action = retryAt - since > MAX_SERVER_WAIT_MS ? 'fail' : 'retry';
    return { action, attempts, waitingSince: since, retryAt: action === 'retry' ? retryAt : null };
  }
  attempts += 1;
  if (attempts >= MAX_ATTEMPTS) return { action: 'fail', attempts, waitingSince, retryAt: null };
  return { action: 'retry', attempts, waitingSince, retryAt: input.now + backoffMs(attempts) };
}

/** A pending wait as persisted: what was left at the save, and the full wait it belongs to. */
export type SavedWait = { remainingMs: number; originalMs: number };

/** How the clocks moved between the save and now; `sameBoot` = same boot identity. */
export type ClockChange = { sameBoot: boolean; elapsedMs: number; wallMs: number };

/**
 * A wait after a restart (N2-04): on the same boot the elapsed clock counts; after a reboot (or an elapsed clock that ran
 * backwards) the wall clock may shorten the wait but never extend it, within [0, original]. `consumedMs` is what the
 * 12 h server-wait budget adds, so the wall clock never moves that budget by more than the wait itself.
 */
export function restoreWait(
  wait: SavedWait,
  change: ClockChange
): { remainingMs: number; consumedMs: number } {
  const saved = Math.min(Math.max(wait.remainingMs, 0), wait.originalMs);
  const remaining =
    change.sameBoot && change.elapsedMs >= 0
      ? saved - change.elapsedMs
      : Math.min(saved, saved - change.wallMs);
  const remainingMs = Math.min(Math.max(remaining, 0), wait.originalMs);
  return { remainingMs, consumedMs: saved - remainingMs };
}

/** Header names outside the allowlist (case-insensitive). */
export function disallowedHeaders(headers: Record<string, string> | undefined): string[] {
  return Object.keys(headers ?? {}).filter((name) => !ALLOWED_HEADERS.includes(name.toLowerCase()));
}
