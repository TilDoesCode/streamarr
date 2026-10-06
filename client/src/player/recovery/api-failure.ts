import { toAppError } from '@/api/errors';

import { classify, type Classified } from './classify';
import type { FailureExtra } from './runner';
import { STEP_TIMEOUT } from './step-budget';

/** A failed request or step in the ladder's terms; never the generic "something went wrong" (A26, D24). */
export function apiFailure(error: unknown): { failure: Classified; extra: FailureExtra } {
  if (error === STEP_TIMEOUT)
    return { failure: { category: 'T6', code: 'step_timeout' }, extra: {} };
  const appError = toAppError(error);
  // A 200 that is not JSON: a sign-in page or proxy answered instead of the server (A26).
  if (appError.code === 'server_error' && appError.cause instanceof SyntaxError)
    return { failure: { category: 'T1', code: 'network_intercepted' }, extra: {} };
  if (appError.code === 'unknown') {
    const detail = error instanceof Error ? error.message : String(error);
    return { failure: { category: 'T11', code: 'player_internal_error', detail }, extra: {} };
  }
  return {
    failure: classify({ kind: 'api', code: appError.code, status: appError.status || undefined }),
    extra: { params: appError.params, status: appError.status, retryAfter: appError.retryAfter },
  };
}
