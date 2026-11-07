import corpus from '@modules/offline-downloads/test-vectors/http-policy.json';

import {
  backoffMs,
  decideRetry,
  disallowedHeaders,
  httpStatusAction,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
  MAX_SERVER_WAIT_MS,
  MIN_RETRY_MS,
  parseRetryAfter,
  PROGRESS_RESETS_ATTEMPTS_BYTES,
  RESERVE_BYTES,
  restoreWait,
  type RetryState,
} from '../http-policy';

type Step = {
  at: number;
  status?: number;
  retryAfter?: string;
  network?: boolean;
  invalid206?: boolean;
  progressBytes: number;
  expect: { action: string; attempts: number; retryAt: number | null; waitingSince: number | null };
};

// The same corpus runs in HttpPolicyTest.kt (JUnit) and Tests/HttpPolicyCheck.swift.
describe('download engine HTTP policy (shared corpus)', () => {
  it('uses the shared constants', () => {
    expect({
      maxAttempts: MAX_ATTEMPTS,
      minRetryMs: MIN_RETRY_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
      maxRetryAfterMs: MAX_RETRY_AFTER_MS,
      maxServerWaitMs: MAX_SERVER_WAIT_MS,
      progressResetsAttemptsBytes: PROGRESS_RESETS_ATTEMPTS_BYTES,
      reserveBytes: RESERVE_BYTES,
    }).toEqual(corpus.constants);
  });

  it.each(corpus.status.retry)('%i retries natively', (status) => {
    expect(httpStatusAction(status)).toBe('retry');
  });

  it.each(corpus.status.fail)('%i fails at once', (status) => {
    expect(httpStatusAction(status)).toBe('fail');
  });

  it('classifies every status 100–599', () => {
    for (let status = 100; status <= 599; status += 1) {
      const retry = [408, 425, 429].includes(status) || status >= 500;
      expect(httpStatusAction(status)).toBe(retry ? 'retry' : 'fail');
    }
  });

  it.each(corpus.retryAfter.cases.map((item) => [JSON.stringify(item.header), item]))(
    'Retry-After %s',
    (_label, item) => {
      expect(parseRetryAfter(item.header, corpus.retryAfter.now)).toBe(item.ms);
    }
  );

  it.each(corpus.backoff.map((item) => [item.attempts, item.ms]))(
    'backoff after %i attempts is %i ms',
    (attempts, ms) => {
      expect(backoffMs(attempts)).toBe(ms);
    }
  );

  it.each(corpus.retrySequences.map((sequence) => [sequence.name, sequence]))(
    '%s',
    (_name, sequence) => {
      let state: RetryState = sequence.start;
      for (const step of sequence.steps as Step[]) {
        const retryable = step.status === undefined || httpStatusAction(step.status) === 'retry';
        const decision = decideRetry(state, {
          now: step.at,
          retryable,
          retryAfterMs: retryable ? parseRetryAfter(step.retryAfter, step.at) : null,
          progressBytes: step.progressBytes,
        });
        expect({ at: step.at, ...decision }).toEqual({
          at: step.at,
          action: step.expect.action,
          attempts: step.expect.attempts,
          retryAt: step.expect.retryAt,
          waitingSince: step.expect.waitingSince,
        });
        state = decision;
      }
    }
  );

  it.each(corpus.waitRestore.map((item) => [item.name, item]))(
    'restores a wait: %s',
    (_name, item) => {
      expect(restoreWait(item.wait, item.change)).toEqual(item.expect);
    }
  );

  it('allows only Accept-Language and User-Agent as request headers', () => {
    expect(disallowedHeaders(undefined)).toEqual([]);
    expect(disallowedHeaders({ 'accept-language': 'de', 'User-Agent': 'x' })).toEqual([]);
    expect(disallowedHeaders({ Authorization: 'Bearer x', 'X-Capability-Key': 'y' })).toEqual([
      'Authorization',
      'X-Capability-Key',
    ]);
  });
});
