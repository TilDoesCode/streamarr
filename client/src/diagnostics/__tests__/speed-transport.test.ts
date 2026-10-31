import { createApiClient } from '@/api/client';
import { AppError } from '@/api/errors';

import { createSpeedTransport, createUploadSource } from '../speed-transport';

const MIB = 1024 * 1024;

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
      const size = (body as string).length;
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
const original = { XMLHttpRequest: globals.XMLHttpRequest };

function transport() {
  return createSpeedTransport(createApiClient({ baseUrl: 'http://dev.test' }));
}

beforeEach(() => {
  FakeXhr.instances = [];
  FakeXhr.behaviour = 'ok';
  globals.XMLHttpRequest = FakeXhr;
});
afterEach(() => {
  globals.XMLHttpRequest = original.XMLHttpRequest;
  jest.useRealTimers();
});

describe('upload payload', () => {
  it('is a plain string: never a Blob (its native store races the request on iOS) or an ArrayBuffer', () => {
    const body = createUploadSource().body(4 * MIB);
    expect(typeof body.data).toBe('string');
    expect(body.data).toHaveLength(4 * MIB);
    expect(body.size).toBe(4 * MIB);
  });

  it('rounds a request down to a power-of-two MiB and reuses the same string for every request', () => {
    const source = createUploadSource();
    expect(source.body(5 * MIB).size).toBe(4 * MIB);
    expect(source.body(3 * MIB).size).toBe(2 * MIB);
    expect(source.body(100).size).toBe(MIB);
    expect(source.body(16 * MIB).size).toBe(16 * MIB);
    expect(source.body(4 * MIB).data).toBe(source.body(4 * MIB).data);
    expect(source.body(MIB).data).toHaveLength(MIB);
  });

  it('can be closed any number of times, and a request after close still gets a body', () => {
    const source = createUploadSource();
    const before = source.body(2 * MIB);
    source.close();
    expect(() => source.close()).not.toThrow();
    expect(before.data).toHaveLength(2 * MIB);
    expect(source.body(2 * MIB).data).toHaveLength(2 * MIB);
  });
});

describe('speed transport upload', () => {
  it('reports progress once per byte', async () => {
    const seen: number[] = [];
    const speed = transport();
    await speed.upload(2 * MIB, (delta) => seen.push(delta), new AbortController().signal);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(2 * MIB);
    expect(typeof FakeXhr.instances.at(-1)!.sent).toBe('string');
    expect(() => speed.close?.()).not.toThrow();
  });

  it('surfaces a transport failure as an AppError', async () => {
    FakeXhr.behaviour = 'error';
    const speed = transport();
    await expect(
      speed.upload(MIB, () => undefined, new AbortController().signal)
    ).rejects.toBeInstanceOf(AppError);
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
  });
});
