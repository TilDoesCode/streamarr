import type { ErrorLike } from '@/api/error-text';

const WORD = /^[a-z_]+$/;

/** Stored form of why the server ended a session: the error code, plus `:reason` for a revoke (B11). */
export function endedReasonOf(error: ErrorLike): string {
  const reason = error.params?.reason;
  return reason && WORD.test(reason) ? `${error.code}:${reason}` : error.code;
}

/** Reads a stored `endedReason` (or the sign-in screen's `reason` param) back into code + params. */
export function parseEndedReason(value: string): ErrorLike {
  const [code = '', reason] = value.split(':');
  return reason && WORD.test(reason) ? { code, params: { reason } } : { code };
}
