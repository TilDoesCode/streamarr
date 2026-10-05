import {
  FRAG_ERROR_RETRIES,
  FRAG_RETRY_DELAY_MS,
  FRAG_RETRY_MAX_DELAY_MS,
  fragLoadPolicy,
  statusLoader,
  type LoadStatus,
} from '@/player/engines/hls-retry';
import { FakeHlsLoader } from '@/../jest/player/library-fakes';

/** hls.js's exponential backoff (hls.js `getRetryDelay`). */
const hlsDelay = (retry: { retryDelayMs: number; maxRetryDelayMs: number }, count: number) =>
  Math.min(2 ** count * retry.retryDelayMs, retry.maxRetryDelayMs);

describe('hls.js retries (B13b: Retry-After is not readable for hls.js requests)', () => {
  it('a failed fragment is retried three times, 1 s, 2 s and 4 s apart, then the ladder takes over', () => {
    const retry = fragLoadPolicy({}).default.errorRetry;
    expect([0, 1, 2].map((count) => hlsDelay(retry, count))).toEqual([1_000, 2_000, 4_000]);
    expect(retry.maxNumRetry).toBe(FRAG_ERROR_RETRIES);
    expect([FRAG_ERROR_RETRIES, FRAG_RETRY_DELAY_MS, FRAG_RETRY_MAX_DELAY_MS]).toEqual([
      3, 1_000, 4_000,
    ]);
  });

  it('a gone session (401/403/404/410) is not retried; a 5xx is (S9a C10)', () => {
    const last: LoadStatus = {};
    const retry = fragLoadPolicy(last).default.errorRetry;
    for (const status of [401, 403, 404, 410]) {
      last.status = status;
      expect(retry.maxNumRetry).toBe(0);
    }
    last.status = 503;
    expect(retry.maxNumRetry).toBe(3);
  });

  it('the wrapped loader notes the status of a failed answer and forgets it on the next success', () => {
    const last: LoadStatus = {};
    const Loader = statusLoader(FakeHlsLoader, last);
    const onError = jest.fn();
    const onSuccess = jest.fn();
    new Loader().load({}, {}, { onError, onSuccess });
    FakeHlsLoader.last!.fail(404, '10');
    expect(last.status).toBe(404);
    expect(onError).toHaveBeenCalledWith({ code: 404, text: '' }, {}, expect.anything(), {});
    FakeHlsLoader.last!.succeed();
    expect(last.status).toBeUndefined();
    expect(onSuccess).toHaveBeenCalled();
  });

  it('keeps a 30 s time to the first byte with two timeout retries (C08)', () => {
    expect(fragLoadPolicy({}).default).toMatchObject({
      maxTimeToFirstByteMs: 30_000,
      timeoutRetry: { maxNumRetry: 2 },
    });
  });
});
