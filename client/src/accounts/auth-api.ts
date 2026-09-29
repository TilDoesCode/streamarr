import { createApiClient, unwrap, type ApiClient } from '@/api/client';
import { clientName, deviceName } from '@/api/device';
import { AppError } from '@/api/errors';
import type { components } from '@/api/schema';

import type { SignedInViewer } from './account-store';
import { tokensFromResponse } from './session';
import type { SessionTokens } from './types';

type AuthResponse = components['schemas']['ViewerAuthResponse'];
export type ViewerProfile = components['schemas']['ViewerProfileResponse'];

export type SignInResult =
  | { kind: 'authenticated'; tokens: SessionTokens; viewer: SignedInViewer }
  | { kind: 'second_factor'; mfaToken: string; expiresAt: number };

export function viewerFromProfile(profile: ViewerProfile): SignedInViewer {
  if (!profile.id || !profile.username) throw new AppError('server_error');
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.displayName || profile.username,
    mustChangePassword: profile.mustChangePassword === true,
  };
}

function toResult(response: AuthResponse): SignInResult {
  if (response.status === 'mfa_required' && response.mfaToken)
    return {
      kind: 'second_factor',
      mfaToken: response.mfaToken,
      expiresAt: response.mfaExpiresAt ? Date.parse(response.mfaExpiresAt) : Date.now() + 300_000,
    };
  if (response.status === 'authenticated' && response.session && response.viewer)
    return {
      kind: 'authenticated',
      tokens: tokensFromResponse(response.session),
      viewer: viewerFromProfile(response.viewer),
    };
  throw new AppError('server_error');
}

const device = () => ({ deviceName: deviceName(), clientName: clientName(), useCookies: false });

/** Anonymous viewer auth endpoints of one server (sign-in, codes, password reset). */
export function createAuthApi(baseUrl: string, client: ApiClient = createApiClient({ baseUrl })) {
  return {
    async password(login: string, password: string): Promise<SignInResult> {
      return toResult(
        await unwrap(
          client.POST('/api/v1/viewer/auth/login', { body: { login, password, ...device() } })
        )
      );
    },
    async secondFactor(mfaToken: string, code: string): Promise<SignInResult> {
      return toResult(
        await unwrap(
          client.POST('/api/v1/viewer/auth/login/second-factor', {
            body: { mfaToken, code, ...device() },
          })
        )
      );
    },
    async requestEmailCode(login: string): Promise<void> {
      await unwrap(client.POST('/api/v1/viewer/auth/email-code', { body: { login } }));
    },
    async verifyEmailCode(login: string, code: string): Promise<SignInResult> {
      return toResult(
        await unwrap(
          client.POST('/api/v1/viewer/auth/email-code/verify', {
            body: { login, code, ...device() },
          })
        )
      );
    },
    async forgotPassword(login: string): Promise<void> {
      await unwrap(client.POST('/api/v1/viewer/auth/password/forgot', { body: { login } }));
    },
    async resetPassword(login: string, code: string, newPassword: string): Promise<void> {
      await unwrap(
        client.POST('/api/v1/viewer/auth/password/reset', { body: { login, code, newPassword } })
      );
    },
    /** Best effort: ends the session on the server (the device forgets the tokens regardless). */
    async logout(refreshToken: string, accessToken?: string): Promise<void> {
      await unwrap(
        client.POST('/api/v1/viewer/auth/logout', {
          body: { refreshToken },
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
        })
      );
    },
  };
}
