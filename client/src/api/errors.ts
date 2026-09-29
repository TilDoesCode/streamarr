export type ErrorParams = Readonly<Record<string, string>>;

export type AppErrorInit = {
  /** HTTP status; 0 when the request never got an answer. */
  status?: number;
  params?: ErrorParams;
  /** The server's English message or the native transport error, for logs only (never shown). */
  detail?: string;
  /** Seconds from a Retry-After header. */
  retryAfter?: number;
  cause?: unknown;
};

/** Every failure the data layer reports: a stable code (server envelope or client-side) plus params for i18n. */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly params: ErrorParams;
  readonly detail?: string;
  readonly retryAfter?: number;

  constructor(code: string, init: AppErrorInit = {}) {
    super(code, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = init.status ?? 0;
    this.params = init.params ?? {};
    this.detail = init.detail;
    this.retryAfter = init.retryAfter;
  }

  /** Worth retrying automatically: network failures, 5xx, 429. */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

type Envelope = { error?: { code?: unknown; message?: unknown; params?: unknown } };

function stringParams(value: unknown): ErrorParams | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function retryAfterSeconds(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('Retry-After');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function statusCode(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'unknown';
}

/** Maps a non-2xx answer (parsed body or raw text) onto an AppError; bodies without the envelope get a status code. */
export function errorFromResponse(response: Pick<Response, 'status' | 'headers'>, body: unknown) {
  const envelope = (typeof body === 'object' && body ? body : undefined) as Envelope | undefined;
  const code = envelope?.error?.code;
  const message = envelope?.error?.message;
  return new AppError(typeof code === 'string' && code ? code : statusCode(response.status), {
    status: response.status,
    params: stringParams(envelope?.error?.params),
    detail: typeof message === 'string' ? message : typeof body === 'string' ? body : undefined,
    retryAfter: retryAfterSeconds(response.headers),
  });
}

const TLS_PATTERN =
  /ssl|tls|certificate|certpath|trust anchor|handshake|x509|pkix|secure connection|ERR_CERT/i;

/** Classifies a transport failure (fetch/XHR rejection or native error text). */
export function errorFromTransport(error: unknown, timedOut = false): AppError {
  if (isAppError(error)) return error;
  if (timedOut) return new AppError('timeout', { cause: error });
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  if (/AbortError/.test(text)) return new AppError('aborted', { cause: error });
  if (TLS_PATTERN.test(text)) return new AppError('tls_error', { detail: text, cause: error });
  if (/timed? ?out/i.test(text)) return new AppError('timeout', { detail: text, cause: error });
  return new AppError('network_unreachable', { detail: text, cause: error });
}

/** Normalises anything thrown by the data layer or a screen into an AppError. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError'))
    return errorFromTransport(error);
  return new AppError('unknown', { cause: error });
}
