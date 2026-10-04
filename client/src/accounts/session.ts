import { AppError, errorFromResponse, toAppError, type ErrorParams } from '@/api/errors';
import type { FetchLike } from '@/api/http';
import type { components } from '@/api/schema';

import type { AccountStore } from './account-store';
import { endedReasonOf } from './ended-reason';
import type { SessionTokens } from './types';

type TokensResponse = components['schemas']['ViewerSessionTokensResponse'];

const REFRESH_PATH = '/api/v1/viewer/auth/refresh';

/** Refresh this long before the access token expires, so requests do not race the expiry. */
export const EXPIRY_SKEW_MS = 30_000;

/** B11 refresh refusals (docs/api.md): each says why the session ended. */
const REFRESH_REFUSALS = new Set([
  'refresh_token_reused',
  'refresh_session_expired',
  'refresh_session_revoked',
  'refresh_token_unknown',
]);

/** A refresh that timed out or got a broken/5xx answer may have rotated on the server; a refused connection did not. */
function mayHaveReachedServer(error: unknown): boolean {
  const code = toAppError(error).code;
  return code === 'timeout' || code === 'server_error';
}

/** Waits before re-sending a refresh whose answer was lost; the server replays a rotation for 30 s. */
const REFRESH_RETRY_DELAYS_MS = [1_000, 3_000];

export function tokensFromResponse(response: TokensResponse): SessionTokens {
  const accessExpiresAt = Date.parse(response.accessExpiresAt);
  const refreshExpiresAt = Date.parse(response.refreshExpiresAt);
  if (
    !response.accessToken ||
    !response.refreshToken ||
    Number.isNaN(accessExpiresAt) ||
    Number.isNaN(refreshExpiresAt)
  )
    throw new AppError('server_error');
  return {
    sessionId: response.sessionId ?? '',
    accessToken: response.accessToken,
    accessExpiresAt,
    refreshToken: response.refreshToken,
    refreshExpiresAt,
  };
}

/** What the auth middleware needs from an account's session. */
export type AuthSession = {
  /** A valid access token (refreshed first when about to expire); throws AppError once the session ended. */
  accessToken(): Promise<string>;
  /** After a 401 for `rejectedToken`: one shared refresh for all callers; resolves the new access token. */
  refreshAfter(rejectedToken: string): Promise<string>;
  /** The server answered 403 password_change_required. */
  passwordChangeRequired(): void;
};

export type AccountSessionOptions = {
  baseUrl: string;
  fetch: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Token lifecycle of one account: proactive + reactive refresh with single-flight rotation. */
export class AccountSession implements AuthSession {
  private inflight: Promise<SessionTokens> | undefined;
  private readonly now: () => number;

  constructor(
    readonly accountId: string,
    private readonly store: AccountStore,
    private readonly options: AccountSessionOptions
  ) {
    this.now = options.now ?? Date.now;
  }

  async accessToken(): Promise<string> {
    const tokens = await this.store.readTokens(this.accountId);
    if (!tokens) return this.end('session_ended');
    if (tokens.accessExpiresAt - this.now() > EXPIRY_SKEW_MS) return tokens.accessToken;
    return (await this.refresh(tokens.accessToken)).accessToken;
  }

  async refreshAfter(rejectedToken: string): Promise<string> {
    return (await this.refresh(rejectedToken)).accessToken;
  }

  passwordChangeRequired(): void {
    this.store.update(this.accountId, { mustChangePassword: true });
  }

  private refresh(staleAccessToken: string): Promise<SessionTokens> {
    this.inflight ??= this.rotate(staleAccessToken).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async rotate(staleAccessToken: string): Promise<SessionTokens> {
    // Re-read the vault: an earlier refresh (or another browser tab) may already have rotated the pair.
    const current = await this.store.readTokens(this.accountId, true);
    if (!current) return this.end('session_ended');
    if (
      current.accessToken !== staleAccessToken &&
      current.accessExpiresAt - this.now() > EXPIRY_SKEW_MS
    )
      return current;

    let lost: unknown;
    for (const delay of [0, ...REFRESH_RETRY_DELAYS_MS]) {
      if (delay) await this.sleep(delay);
      let response: Response;
      let body: unknown;
      try {
        response = await this.options.fetch(
          new Request(`${this.options.baseUrl}${REFRESH_PATH}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ refreshToken: current.refreshToken }),
          })
        );
        body = await response.json().catch(() => undefined);
        if (response.ok && body === undefined) throw new AppError('server_error');
      } catch (error) {
        // Unreachable (offline, refused): nothing reached the server, fail fast so waiting requests error at once.
        if (!mayHaveReachedServer(error)) throw toAppError(error);
        // The server may have rotated already: re-send the same token while it still replays that rotation.
        lost = error;
        continue;
      }
      if (response.status >= 500) {
        lost = errorFromResponse(response, body);
        continue;
      }
      if (response.ok) {
        const next = tokensFromResponse(body as TokensResponse);
        await this.store.writeTokens(this.accountId, next);
        return next;
      }
      return this.rejected(response, body);
    }
    // Offline or server down: keep the session and let the request fail with the transport error.
    throw toAppError(lost);
  }

  private rejected(response: Response, body: unknown): Promise<never> {
    const error = errorFromResponse(response, body);
    // A refused refresh ends the session here; an older server's plain 401 gets the neutral "signed out".
    if (response.status === 401)
      return REFRESH_REFUSALS.has(error.code)
        ? this.end(error.code, error.params)
        : this.end('session_ended');
    throw error;
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep
      ? this.options.sleep(ms)
      : new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async end(code: string, params?: ErrorParams): Promise<never> {
    await this.store.signOut(this.accountId, endedReasonOf({ code, params }));
    throw new AppError(code, { status: 401, params });
  }
}
