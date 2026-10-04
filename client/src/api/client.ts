import createClient, { type Client, type Middleware } from 'openapi-fetch';

import type { AuthSession } from '@/accounts/session';
import { currentLanguage } from '@/i18n';

import { AppError, errorFromResponse, toAppError } from './errors';
import { createTimeoutFetch, type FetchLike } from './http';
import type { paths } from './schema';

export type ApiClient = Client<paths>;

function bearer(request: Request): string {
  return request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
}

const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 204, 205, 304]);

// openapi-fetch accepts only `instanceof Response` from middleware; expo/fetch (RN's global fetch) has its own class.
async function standardResponse(response: Response, text?: string): Promise<Response> {
  if (text === undefined && response instanceof Response) return response;
  const body = text ?? (await response.text());
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return new Response(NULL_BODY_STATUS.has(response.status) ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Bearer auth for one account; a 401 waits for the account's single shared refresh and replays once. */
function createAuthMiddleware(session: AuthSession): Middleware {
  // onResponse gets the Request that fetch already consumed; keep an unread copy for the replay.
  const replays = new Map<string, Request>();
  return {
    async onRequest({ request, id }) {
      const token = await session.accessToken();
      replays.set(id, request.clone());
      request.headers.set('Authorization', `Bearer ${token}`);
      return request;
    },
    async onResponse({ request, response, options, id }) {
      const replay = replays.get(id);
      replays.delete(id);
      if (response.status === 403) {
        const text = await response.text();
        if (errorFromResponse(response, parseJson(text)).code === 'password_change_required')
          session.passwordChangeRequired();
        return standardResponse(response, text);
      }
      if (response.status !== 401 || !replay) return undefined;
      const token = await session.refreshAfter(bearer(request));
      replay.headers.set('Authorization', `Bearer ${token}`);
      return standardResponse(await options.fetch(replay));
    },
    onError({ id }) {
      replays.delete(id);
    },
  };
}

/** Metadata in the viewer's app language: the primary tag on every request (the server falls back to its default). */
function createLanguageMiddleware(language: () => string): Middleware {
  return {
    onRequest({ request }) {
      request.headers.set('Accept-Language', language());
      return request;
    },
  };
}

export type ClientOptions = {
  baseUrl: string;
  session?: AuthSession;
  fetch?: FetchLike;
  /** App language as a primary tag (en, de); defaults to the i18n language. */
  language?: () => string;
};

/** Typed client for one server; with a session every request is authenticated as that account. */
export function createApiClient({
  baseUrl,
  session,
  fetch,
  language = currentLanguage,
}: ClientOptions): ApiClient {
  const client = createClient<paths>({ baseUrl, fetch: fetch ?? createTimeoutFetch() });
  client.use(createLanguageMiddleware(language));
  if (session) client.use(createAuthMiddleware(session));
  return client;
}

type FetchResult<T> = { data?: T; error?: unknown; response: Response };

/** Resolves openapi-fetch's `{ data, error }` into data, throwing AppError for any failure. */
export async function unwrap<T>(call: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await call;
  } catch (error) {
    if (error instanceof SyntaxError) throw new AppError('server_error', { cause: error });
    throw toAppError(error);
  }
  if (!result.response.ok) throw errorFromResponse(result.response, result.error);
  return result.data as T;
}
