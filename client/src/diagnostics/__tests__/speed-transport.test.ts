import { createApiClient } from '@/api/client';
import { AppError } from '@/api/errors';

import { createSpeedTransport, createUploadSource } from '../speed-transport';

const MIB = 1024 * 1024;

class FakeBlob {
  static created: FakeBlob[] = [];
  closed = false;
  readonly size: number;
  constructor(readonly parts: (string | FakeBlob)[]) {
    this.size = parts.reduce<number>(
      (sum, part) => sum + (typeof part === 'string' ? part.length : part.size),
      0
    );
    FakeBlob.created.push(this);
  }
  close() {
    if (this.closed) throw new Error('Blob has been closed and is no longer available');
    this.closed = true;
  }
}

type Behaviour = 'ok' | 'error' | 'hang';

class FakeXhr {
  static instances: FakeXhr[] = [];
  static behaviour: Behaviour = 'ok';
  status = 204;
  responseText = '';
  upload: { onprogress?: (event: { loaded: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;
  sent?: unknown;
  aborted = false;
  open() {}
  setRequestHeader() {}
  getResponseHeader() {
    return null;
  }
  constructor() {
    FakeXhr.instances.push(this);
  }
  send(body: unknown) {
    this.sent = body;
    if (FakeXhr.behaviour === 'ok') {
      const size = (body as FakeBlob).size ?? (body as string).length;
      queueMicrotask(() => {
        this.upload.onprogress?.({ loaded: size / 2 });
        this.upload.onprogress?.({ loaded: size });
        this.onload?.();
      });
    } else if (FakeXhr.behaviour === 'error') {
      queueMicrotask(() => this.onerror?.());
    }
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
const original = { Blob: globals.Blob, XMLHttpRequest: globals.XMLHttpRequest };

function transport() {
  return createSpeedTransport(createApiClient({ baseUrl: 'http://dev.test' }));
}

beforeEach(() => {
  FakeBlob.created = [];
  FakeXhr.instances = [];
  FakeXhr.behaviour = 'ok';
  globals.Blob = FakeBlob;
  globals.XMLHttpRequest = FakeXhr;
});
afterEach(() => {
  globals.Blob = original.Blob;
  globals.XMLHttpRequest = original.XMLHttpRequest;
  jest.useRealTimers();
});

describe('upload payload', () => {
  it('is a Blob built from one 1 MiB base, never a big string or an ArrayBuffer', () => {
    const source = createUploadSource();
    const body = source.body(4 * MIB);
    expect(body.data).toBeInstanceOf(FakeBlob);
    expect(body.size).toBe(4 * MIB);
    // 1 MiB base plus the 4-part request body; no allocation of the full size in JS.
    const [base, composite] = FakeBlob.created;
    expect(base!.size).toBe(MIB);
    expect(composite!.parts).toHaveLength(4);
  });

  it('releases a request body after use and everything on close', () => {
    const source = createUploadSource();
    const body = source.body(2 * MIB);
    body.release();
    body.release();
    expect((body.data as unknown as FakeBlob).closed).toBe(true);
    source.close();
    expect(FakeBlob.created[0]!.closed).toBe(true);
    expect(() => source.close()).not.toThrow();
  });

  it('falls back to a string where Blobs are unavailable', () => {
    globals.Blob = undefined;
    const body = createUploadSource().body(2 * MIB);
    expect(typeof body.data).toBe('string');
    expect((body.data as string).length).toBe(2 * MIB);
  });
});

describe('speed transport upload', () => {
  it('reports progress once per byte and frees the request body', async () => {
    const seen: number[] = [];
    const speed = transport();
    await speed.upload(2 * MIB, (delta) => seen.push(delta), new AbortController().signal);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(2 * MIB);
    expect(FakeBlob.created.at(-1)!.closed).toBe(true);
    speed.close?.();
    expect(FakeBlob.created[0]!.closed).toBe(true);
  });

  it('surfaces a transport failure as an AppError and still frees the body', async () => {
    FakeXhr.behaviour = 'error';
    const speed = transport();
    await expect(
      speed.upload(MIB, () => undefined, new AbortController().signal)
    ).rejects.toBeInstanceOf(AppError);
    expect(FakeBlob.created.at(-1)!.closed).toBe(true);
  });

  it('times out when no progress arrives for the stall period, not on total duration', async () => {
    jest.useFakeTimers();
    FakeXhr.behaviour = 'hang';
    const speed = transport();
    const outcome = speed
      .upload(MIB, () => undefined, new AbortController().signal)
      .catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(10_000);
    const xhr = FakeXhr.instances.at(-1)!;
    // Progress at 10 s restarts the stall clock.
    xhr.upload.onprogress?.({ loaded: 1024 });
    await jest.advanceTimersByTimeAsync(15_000);
    expect(xhr.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(6_000);
    expect(xhr.aborted).toBe(true);
    expect(((await outcome) as AppError).code).toBe('timeout');
  });

  it('aborts the request when the phase signal fires', async () => {
    FakeXhr.behaviour = 'hang';
    const controller = new AbortController();
    const outcome = transport()
      .upload(MIB, () => undefined, controller.signal)
      .catch((e: unknown) => e);
    await Promise.resolve();
    controller.abort();
    expect(((await outcome) as AppError).code).toBe('aborted');
    expect(FakeBlob.created.at(-1)!.closed).toBe(true);
  });
});
