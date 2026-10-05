import {
  FRAG_ERROR_RETRIES,
  retryAfterLoader,
  retryAfterMs,
  retryAfterPolicy,
  type RetryAfterHint,
} from '@/player/engines/hls-retry-after';
import { FakeHlsLoader } from '@/../jest/player/library-fakes';

/** hls.js's delay for retry `count` (exponential, capped): the formula of hls.js 1.7 `getRetryDelay`. */
function hlsDelay(retry: { retryDelayMs: number; maxRetryDelayMs: number }, count: number): number {
  return Math.min(2 ** count * retry.retryDelayMs, retry.maxRetryDelayMs);
}

describe('Retry-After in hls.js (B13, S4c)', () => {
  it('reads the header from an XHR and from a fetch Response; bad values are 0', () => {
    expect(retryAfterMs({ getResponseHeader: () => '3' })).toBe(3000);
    expect(retryAfterMs({ headers: new Headers({ 'Retry-After': '1' }) })).toBe(1000);
    expect(retryAfterMs({ getResponseHeader: () => 'Wed, 21 Oct 2026 07:28:00 GMT' })).toBe(0);
    expect(retryAfterMs(null)).toBe(0);
    expect(
      retryAfterMs({
        getResponseHeader: () => {
          throw new Error('unsafe header');
        },
      })
    ).toBe(0);
  });

  it('a fragment retry never comes sooner than the server asked, and only three times', () => {
    const hint: RetryAfterHint = { ms: 0 };
    const retry = retryAfterPolicy(hint).default.errorRetry;
    expect([0, 1, 2].map((count) => hlsDelay(retry, count))).toEqual([1000, 2000, 4000]);
    hint.ms = 10_000;
    expect([0, 1, 2].map((count) => hlsDelay(retry, count))).toEqual([10_000, 10_000, 10_000]);
    expect(retry.maxNumRetry).toBe(FRAG_ERROR_RETRIES);
    expect(FRAG_ERROR_RETRIES).toBe(3);
  });

  it('the wrapped loader notes Retry-After on a failed answer and forgets it on the next success', () => {
    const hint: RetryAfterHint = { ms: 0 };
    const Loader = retryAfterLoader(FakeHlsLoader, hint);
    const onError = jest.fn();
    const onSuccess = jest.fn();
    new Loader().load({}, {}, { onError, onSuccess });
    FakeHlsLoader.last!.fail(503, '7');
    expect(hint.ms).toBe(7000);
    expect(onError).toHaveBeenCalledWith({ code: 503, text: '' }, {}, expect.anything(), {});
    FakeHlsLoader.last!.succeed();
    expect(hint.ms).toBe(0);
    expect(onSuccess).toHaveBeenCalled();
  });
});
