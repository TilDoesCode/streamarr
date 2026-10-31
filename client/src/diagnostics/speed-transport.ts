import { unwrap, type ApiClient } from '@/api/client';
import { AppError, errorFromTransport } from '@/api/errors';
import { createTimeoutFetch, PROBE_TIMEOUT_MS } from '@/api/http';

import type { SpeedLimits, SpeedTransport } from './speed-test';

const PING = '/api/v1/viewer/diagnostics/ping';
const DOWNLOAD = '/api/v1/viewer/diagnostics/speed/download';
const UPLOAD = '/api/v1/viewer/diagnostics/speed/upload';
const STALL_TIMEOUT_MS = 20_000;

const MIB = 1024 * 1024;
const FLUSH_MS = 50;

type UploadBody = { data: string; size: number };

/** Random printable text of exactly `bytes` characters (one byte each in UTF-8). */
function randomText(bytes: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const block = Array.from({ length: 4096 }, () => alphabet[Math.floor(Math.random() * 64)]).join(
    ''
  );
  return block.repeat(Math.ceil(bytes / block.length)).slice(0, bytes);
}

/**
 * Immutable string bodies in power-of-two MiB sizes, built once and reused by every request, so memory stays flat and
 * nothing native is ever freed under a request: RN Blobs (a blob of blobs) race their native store and crash iOS, and
 * ArrayBuffer bodies are base64-encoded in JS.
 */
export function createUploadSource() {
  let base: string | undefined;
  const bodies = new Map<number, string>();
  return {
    body(bytes: number): UploadBody {
      const count = 2 ** Math.floor(Math.log2(Math.max(1, Math.floor(bytes / MIB))));
      base ??= randomText(MIB);
      let data = bodies.get(count);
      if (data === undefined) {
        data = count === 1 ? base : base.repeat(count);
        bodies.set(count, data);
      }
      return { data, size: count * MIB };
    },
    close() {
      bodies.clear();
      base = undefined;
    },
  };
}

type UploadOptions = {
  body: UploadBody;
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
      let stalled = false;
      let stall: ReturnType<typeof setTimeout> | undefined;
      const progress = (loaded: number) => {
        if (loaded > last) onBytes(loaded - last);
        last = loaded;
      };
      const abort = () => xhr.abort();
      // The timeout restarts with every sign of life, so a slow link is not cut off but a dead one is.
      const arm = () => {
        clearTimeout(stall);
        stall = setTimeout(() => {
          stalled = true;
          xhr.abort();
        }, STALL_TIMEOUT_MS);
      };
      const cleanup = () => {
        clearTimeout(stall);
        signal.removeEventListener('abort', abort);
      };
      xhr.open(request.method, request.url);
      request.headers.forEach((value, key) => {
        if (!['content-length', 'content-type'].includes(key.toLowerCase()))
          xhr.setRequestHeader(key, value);
      });
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (event) => {
        arm();
        progress(event.loaded);
      };
      xhr.onload = () => {
        cleanup();
        if (xhr.status < 300) progress(body.size);
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
        reject(new AppError(stalled ? 'timeout' : 'aborted'));
      };
      signal.addEventListener('abort', abort);
      arm();
      xhr.send(body.data);
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

/** Reads and discards a response body chunk by chunk (reported in batches), so memory and JS work stay flat however long the download runs. */
async function drain(
  body: ReadableStream<Uint8Array> | null,
  onBytes: (delta: number) => void,
  signal: AbortSignal
) {
  if (!body) return;
  const reader = body.getReader();
  let pending = 0;
  let flushed = Date.now();
  const flush = () => {
    if (pending > 0) onBytes(pending);
    pending = 0;
    flushed = Date.now();
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      pending += value?.byteLength ?? 0;
      if (Date.now() - flushed >= FLUSH_MS) flush();
    }
  } catch (error) {
    throw signal.aborted ? new AppError('aborted') : errorFromTransport(error);
  } finally {
    flush();
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
  let source: ReturnType<typeof createUploadSource> | undefined;
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
      source ??= createUploadSource();
      const body = source.body(bytes);
      await unwrap(client.POST(UPLOAD, { fetch: xhrUpload({ body, onBytes, signal }) }));
    },
    close() {
      source?.close();
      source = undefined;
    },
  };
}
