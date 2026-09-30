import { AppError } from '@/api/errors';
import { createTimeoutFetch, READ_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '@/api/http';
import { shouldRetry } from '@/query/query-client';

const hanging = (_input: Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) =>
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  );

describe('timeout budget of a hanging server', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fails reads after READ_TIMEOUT_MS and mutations after REQUEST_TIMEOUT_MS', async () => {
    const timed = createTimeoutFetch(hanging);
    const read = timed(new Request('http://dev.test/a'));
    const write = timed(new Request('http://dev.test/b', { method: 'POST' }));
    let writeDone = false;
    write.catch(() => (writeDone = true));
    jest.advanceTimersByTime(READ_TIMEOUT_MS);
    await expect(read).rejects.toMatchObject({ code: 'timeout' });
    expect(writeDone).toBe(false);
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS - READ_TIMEOUT_MS);
    await expect(write).rejects.toMatchObject({ code: 'timeout' });
  });

  it('does not retry a timeout, but retries other transient errors', () => {
    expect(READ_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(shouldRetry(0, new AppError('timeout'))).toBe(false);
    expect(shouldRetry(0, new AppError('network_unreachable'))).toBe(true);
  });
});
