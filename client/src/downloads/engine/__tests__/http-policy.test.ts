import { httpStatusAction, MAX_RETRY_AFTER_MS, parseRetryAfter } from '../http-policy';

// The native engines implement the same table (HttpPolicy.kt with a JUnit test, HttpPolicy.swift with a swiftc check).
describe('download engine HTTP policy', () => {
  it.each([400, 401, 403, 404, 409, 410, 416, 451])('%i fails at once as kind http', (status) => {
    expect(httpStatusAction(status)).toBe('fail');
  });

  it.each([408, 425, 429, 500, 501, 502, 503, 504, 507, 599])('%i retries natively', (status) => {
    expect(httpStatusAction(status)).toBe('retry');
  });

  it('reads Retry-After as delta-seconds or HTTP-date', () => {
    const now = Date.UTC(2026, 10, 6, 20, 0, 0);
    expect(parseRetryAfter('40', now)).toBe(40_000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
    expect(parseRetryAfter(new Date(now - 5_000).toUTCString(), now)).toBe(0);
  });

  it('caps Retry-After at an hour and ignores garbage', () => {
    expect(parseRetryAfter('86400')).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('-5')).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});
