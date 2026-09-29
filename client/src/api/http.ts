import { AppError, errorFromTransport } from './errors';

export type FetchLike = (input: Request, init?: RequestInit) => Promise<Response>;

export const REQUEST_TIMEOUT_MS = 20_000;
export const PROBE_TIMEOUT_MS = 8_000;

/** fetch that aborts after `timeoutMs`, follows the request's own signal and throws AppError on transport failure. */
export function createTimeoutFetch(
  baseFetch: FetchLike = (input, init) => globalThis.fetch(input, init),
  timeoutMs = REQUEST_TIMEOUT_MS
): FetchLike {
  return async (input, init) => {
    const controller = new AbortController();
    const outer = init?.signal ?? input.signal;
    if (outer?.aborted) throw new AppError('aborted');
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const forward = () => controller.abort();
    outer?.addEventListener('abort', forward);
    try {
      return await baseFetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      throw errorFromTransport(error, timedOut);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', forward);
    }
  };
}

export type ProbeResponse = { status: number; body: string; contentType: string };
export type ProbeTransport = (url: string, timeoutMs: number) => Promise<ProbeResponse>;

/** GET over XMLHttpRequest: unlike RN's fetch it keeps the native error text (TLS vs unreachable). */
export const xhrTransport: ProbeTransport = (url, timeoutMs) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        body: xhr.responseText ?? '',
        contentType: xhr.getResponseHeader('Content-Type') ?? '',
      });
    xhr.onerror = () => reject(errorFromTransport(new Error(xhr.responseText || 'network')));
    xhr.ontimeout = () => reject(new AppError('timeout'));
    xhr.onabort = () => reject(new AppError('aborted'));
    xhr.send();
  });
