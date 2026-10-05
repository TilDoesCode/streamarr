import type { ApiClient } from '@/api/client';
import type { Playback } from '@/player/playback-api';

/** One scripted answer: an HTTP status with a body, or a transport failure (fetch rejects). */
export type Reply =
  | { status: number; body?: unknown; retryAfter?: number }
  | { network: string }
  /** No answer until the request is aborted; then it rejects like React Native's fetch (AbortError, not the reason). */
  | { hang: true };

export const reply = {
  ok: (body?: unknown, status = 200): Reply => ({ status, body }),
  /** The server's error envelope. */
  error: (
    status: number,
    code: string,
    params?: Record<string, string>,
    retryAfter?: number
  ): Reply => ({ status, body: { error: { code, message: code, params } }, retryAfter }),
  /** A proxy or captive portal answering HTML. */
  html: (status = 200): Reply => ({ status, body: '<html>Sign in to the Wi-Fi</html>' }),
  offline: (message = 'Network request failed'): Reply => ({ network: message }),
  hang: (): Reply => ({ hang: true }),
};

export type Route = 'start' | 'poll' | 'switch' | 'stop' | 'progress' | 'versions';
export type ServerRequest = { route: Route; playbackId?: string; body?: Record<string, unknown> };
type Scripted = Reply | ((request: ServerRequest) => Reply);

const TICKS = 10_000_000;

function routeOf(method: string, path: string): Route {
  if (path.endsWith('/watch/progress')) return 'progress';
  if (path.endsWith('/versions')) return 'versions';
  if (path.endsWith('/switch')) return 'switch';
  if (path.endsWith('/stop')) return 'stop';
  return method === 'GET' ? 'poll' : 'start';
}

type Init = {
  params?: { path?: { playbackId?: string } };
  body?: Record<string, unknown>;
  signal?: AbortSignal;
};

/** The viewer playback API behind an ApiClient: every route answers from a script, else like a healthy server. */
export class FakeServer {
  readonly requests: ServerRequest[] = [];
  private queues: Record<Route, Scripted[]> = {
    start: [],
    poll: [],
    switch: [],
    stop: [],
    progress: [],
    versions: [],
  };
  private current = new Map<string, Playback>();
  private ids = 0;

  readonly client = {
    POST: (path: string, init?: Init) => this.handle('POST', path, init),
    GET: (path: string, init?: Init) => this.handle('GET', path, init),
  } as unknown as ApiClient;

  /** Queues answers for a route; each request takes the next one. */
  answer(route: Route, ...replies: Scripted[]): this {
    this.queues[route].push(...replies);
    return this;
  }

  /** A ready playback (direct play of a 10-minute file) with a fresh id unless given. */
  playback(over: Partial<Playback> = {}): Playback {
    const playbackId = over.playbackId ?? `p${(this.ids += 1)}`;
    return {
      playbackId,
      workId: 'w1',
      state: 'ready',
      revision: 0,
      method: 'direct',
      url: `/api/v1/stream/${playbackId}`,
      mediaInfo: { durationTicks: 600 * TICKS, audioTracks: [], subtitleTracks: [] },
      ...over,
    } as Playback;
  }

  sent(route: Route): ServerRequest[] {
    return this.requests.filter((request) => request.route === route);
  }

  private fallback(request: ServerRequest): Reply {
    const id = request.playbackId ?? '';
    if (request.route === 'start') return reply.ok(this.playback());
    if (request.route === 'poll') return reply.ok(this.current.get(id) ?? this.playback());
    if (request.route === 'switch') {
      const before = this.current.get(id) ?? this.playback({ playbackId: id });
      // Like the server: the audio conversion is sticky for the playback (B13).
      const fallback = request.body?.audioFallback;
      return reply.ok({
        ...before,
        ...(typeof fallback === 'boolean' ? { audioFallback: fallback } : null),
        state: 'ready',
        revision: (before.revision ?? 0) + 1,
      });
    }
    if (request.route === 'versions') return reply.ok({ versions: [] });
    return { status: 204 };
  }

  private async handle(method: string, path: string, init: Init = {}) {
    const request: ServerRequest = {
      route: routeOf(method, path),
      playbackId: init.params?.path?.playbackId,
      body: init.body,
    };
    this.requests.push(request);
    const next = this.queues[request.route].shift() ?? this.fallback(request);
    const answer = typeof next === 'function' ? next(request) : next;
    if ('network' in answer) throw new TypeError(answer.network);
    if ('hang' in answer)
      return new Promise<never>((_, reject) =>
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
        )
      );
    const ok = answer.status >= 200 && answer.status < 300;
    const body = answer.body as Playback | undefined;
    if (ok && body?.playbackId) this.current.set(body.playbackId, body);
    return {
      data: ok ? answer.body : undefined,
      error: ok ? undefined : answer.body,
      response: {
        ok,
        status: answer.status,
        headers: new Headers(
          answer.retryAfter === undefined ? {} : { 'Retry-After': String(answer.retryAfter) }
        ),
      },
    };
  }
}
