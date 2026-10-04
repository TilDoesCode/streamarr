import { AppError, errorFromResponse, toAppError } from '@/api/errors';
import type { FetchLike } from '@/api/http';
import type { components } from '@/api/schema';

import type { AccountStore } from './account-store';
import type { SessionTokens } from './types';

type TokensResponse = components['schemas']['ViewerSessionTokensResponse'];

const REFRESH_PATH = '/api/v1/viewer/auth/refresh';

/** Refresh this long before the access token expires, so requests do not race the expiry. */
export const EXPIRY_SKEW_MS = 30_000;

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

    let response: Response;
    try {
      response = await this.options.fetch(
        new Request(`${this.options.baseUrl}${REFRESH_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ refreshToken: current.refreshToken }),
        })
      );
    } catch (error) {
      // Offline or server down: keep the session and let the request fail with the transport error.
      throw toAppError(error);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      const next = tokensFromResponse(body as TokensResponse);
      await this.store.writeTokens(this.accountId, next);
      return next;
    }
    const error = errorFromResponse(response, body);
    // A rejected refresh (reused, expired, revoked, disabled account) ends the session on this device.
    if (response.status === 401)
      return this.end(error.code === 'unauthorized' ? 'refresh_session_expired' : error.code);
    throw error;
  }

  private async end(code: string): Promise<never> {
    await this.store.signOut(this.accountId, code);
    throw new AppError(code, { status: 401 });
  }
}
