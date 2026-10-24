import { unwrap, type ApiClient } from '@/api/client';
import { AppError, errorFromTransport } from '@/api/errors';
import { createTimeoutFetch, PROBE_TIMEOUT_MS } from '@/api/http';

import type { SpeedLimits, SpeedTransport } from './speed-test';

const PING = '/api/v1/viewer/diagnostics/ping';
const DOWNLOAD = '/api/v1/viewer/diagnostics/speed/download';
const UPLOAD = '/api/v1/viewer/diagnostics/speed/upload';
const STALL_TIMEOUT_MS = 20_000;

let payload = '';

/** Random printable bytes for uploads: a string body goes over the native bridge without base64. */
function uploadBody(bytes: number): string {
  if (payload.length < bytes) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const block = Array.from({ length: 4096 }, () => alphabet[Math.floor(Math.random() * 64)]).join(
      ''
    );
    payload = block.repeat(Math.ceil(bytes / block.length));
  }
  return payload.length === bytes ? payload : payload.slice(0, bytes);
}

type UploadOptions = {
  body: string;
  onBytes: (delta: number) => void;
  signal: AbortSignal;
};

/** Per-request fetch over XMLHttpRequest for uploads: the API client still adds auth, XHR reports upload progress. */
function xhrUpload({ body, onBytes, signal }: UploadOptions) {
  return (request: Request): Promise<Response> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AppError('aborted'));
        return;
      }
      const xhr = new XMLHttpRequest();
      let last = 0;
      const progress = (loaded: number) => {
        if (loaded > last) onBytes(loaded - last);
        last = loaded;
      };
      const abort = () => xhr.abort();
      const cleanup = () => signal.removeEventListener('abort', abort);
      xhr.open(request.method, request.url);
      request.headers.forEach((value, key) => {
        if (!['content-length', 'content-type'].includes(key.toLowerCase()))
          xhr.setRequestHeader(key, value);
      });
      xhr.timeout = STALL_TIMEOUT_MS;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (event) => progress(event.loaded);
      xhr.onload = () => {
        cleanup();
        if (xhr.status < 300) progress(body.length);
        const retryAfter = xhr.getResponseHeader('Retry-After');
        resolve(
          new Response(xhr.status === 204 ? null : xhr.responseText || null, {
            status: xhr.status,
            headers: {
              'Content-Type': 'application/json',
              ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
            },
          })
        );
      };
      xhr.onerror = () => {
        cleanup();
        reject(errorFromTransport(new Error('network')));
      };
      xhr.ontimeout = () => {
        cleanup();
        reject(new AppError('timeout'));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new AppError('aborted'));
      };
      signal.addEventListener('abort', abort);
      xhr.send(body);
    });
}

/** Per-request fetch whose signal also ends the body stream (the shared client fetch only times out the headers). */
function streamingFetch(signal: AbortSignal) {
  return async (request: Request): Promise<Response> => {
    try {
      return await globalThis.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        signal,
      });
    } catch (error) {
      throw signal.aborted ? new AppError('aborted') : errorFromTransport(error);
    }
  };
}

/** Reads and discards a response body chunk by chunk, so memory stays flat however long the download runs. */
async function drain(
  body: ReadableStream<Uint8Array> | null,
  onBytes: (delta: number) => void,
  signal: AbortSignal
) {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.byteLength) onBytes(value.byteLength);
    }
  } catch (error) {
    throw signal.aborted ? new AppError('aborted') : errorFromTransport(error);
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** Limits the server announces with each ping (absent on older servers). */
export async function fetchSpeedLimits(
  client: ApiClient,
  signal?: AbortSignal
): Promise<SpeedLimits> {
  const ping = await unwrap(client.GET(PING, { signal }));
  return {
    maxDownloadBytes: ping.maxDownloadBytes,
    maxUploadBytes: ping.maxUploadBytes,
    maxParallelTransfers: ping.maxParallelTransfers,
  };
}

/** Speed test transport against the active account's server. */
export function createSpeedTransport(
  client: ApiClient,
  now: () => number = () => Date.now()
): SpeedTransport {
  const pingFetch = createTimeoutFetch(undefined, PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS);
  return {
    async ping(signal) {
      const began = now();
      await unwrap(client.GET(PING, { signal, fetch: pingFetch }));
      return now() - began;
    },
    async download(bytes, onBytes, signal) {
      const body = await unwrap(
        client.GET(DOWNLOAD, {
          params: { query: { bytes } },
          parseAs: 'stream',
          signal,
          fetch: streamingFetch(signal),
        })
      );
      await drain(body as ReadableStream<Uint8Array> | null, onBytes, signal);
    },
    async upload(bytes, onBytes, signal) {
      await unwrap(
        client.POST(UPLOAD, { fetch: xhrUpload({ body: uploadBody(bytes), onBytes, signal }) })
      );
    },
  };
}
