import type { components } from "./schema";
import { clearSession, getToken } from "./token";

/** The server's typed error envelope (BRIEF §9.2): `{ error: { code, message } }`. */
export type ErrorEnvelope = components["schemas"]["ErrorResponse"];

/** Thrown for any non-2xx response. Carries the parsed typed error envelope when present. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly envelope: ErrorEnvelope | null;

  constructor(status: number, code: string, message: string, envelope: ErrorEnvelope | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.envelope = envelope;
  }
}

// The app registers a handler so a 401 anywhere routes the user back to login without the
// fetch layer importing the router (BRIEF §9: "401 → redirect to login").
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

export interface RequestOptions {
  method?: string;
  /** JSON body — serialized automatically. */
  body?: unknown;
  /** Query-string params; undefined/null values are dropped. */
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = path.startsWith("/api/") ? path : `/api/v1${path.startsWith("/") ? "" : "/"}${path}`;
  if (!query) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

/**
 * Thin typed fetch wrapper over the Core Server API (BRIEF §9.2). Injects the bearer token,
 * serializes/deserializes JSON, normalizes the typed error envelope into {@link ApiError},
 * and triggers the login redirect on 401.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, signal } = options;

  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(buildUrl(path, query), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  if (res.status === 401) {
    clearSession();
    onUnauthorized?.();
    throw await toApiError(res);
  }

  if (!res.ok) throw await toApiError(res);

  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function toApiError(res: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope | null = null;
  try {
    const data = (await res.clone().json()) as unknown;
    if (data && typeof data === "object" && "error" in data) {
      envelope = data as ErrorEnvelope;
    }
  } catch {
    // non-JSON body — fall through to a generic message
  }
  const code = envelope?.error?.code ?? `http_${res.status}`;
  const message =
    envelope?.error?.message ??
    (res.status === 401
      ? "Your session has expired. Please sign in again."
      : `Request failed (${res.status} ${res.statusText}).`);
  return new ApiError(res.status, code, message, envelope);
}

/**
 * Turn a resolve response's absolute `streamUrl` into a URL a browser `<video>` element can
 * play directly (BRIEF §9.1.6 playback-preview canary). Two things happen:
 *  1. We reduce it to a same-origin path (+ query) so the request goes through the same
 *     origin the SPA loads from — the Vite dev proxy forwards `/api` to Kestrel in dev, and
 *     the Core Server serves both the SPA and the API in production.
 *  2. A `<video>` element can't send an `Authorization` header, so the bearer token rides
 *     along as an `access_token` query parameter — which the `/stream` endpoint accepts.
 */
export function streamUrlWithToken(streamUrl: string, token: string | null = getToken()): string {
  let path = streamUrl;
  try {
    const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const u = new URL(streamUrl, origin);
    path = u.pathname + u.search;
  } catch {
    // already a relative path — use as-is
  }
  if (!token) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}access_token=${encodeURIComponent(token)}`;
}

/** Best-effort human message from any thrown value (used by toasts / inline errors). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
}
