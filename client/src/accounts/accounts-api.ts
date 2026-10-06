import type { QueryClient } from '@tanstack/react-query';

import { createApiClient, type ApiClient } from '@/api/client';
import type { FetchLike } from '@/api/http';
import { deleteAccountCache } from '@/query/persist';

import type { AccountStore, SignedInViewer } from './account-store';
import { createAuthApi } from './auth-api';
import { AccountSession } from './session';
import { signInFlow } from './sign-in-flow';
import type { Account, SessionTokens } from './types';
import { serverKey } from '@/api/server-url';

export type AccountsActions = {
  store: AccountStore;
  queryClient: QueryClient;
  /** Typed API client authenticated as `accountId` (single-flight refresh per account). */
  clientFor(accountId: string): ApiClient;
  /** Stores a fresh sign-in and makes it the active profile. */
  completeSignIn(
    server: { url: string; name: string },
    viewer: SignedInViewer,
    tokens: SessionTokens
  ): Promise<Account>;
  /** Switches profiles: cancels and clears the query cache, then activates `accountId`. */
  activate(accountId: string): void;
  /** Ends the session here and on the server; the profile stays in the picker. */
  signOut(accountId: string): Promise<void>;
  /** Signs out and forgets the profile and its cached data on this device. */
  remove(accountId: string): Promise<void>;
};

export type AccountsApiOptions = {
  store: AccountStore;
  queryClient: QueryClient;
  fetch: FetchLike;
  /** A profile was picked (sign-in or switch) in this launch. */
  onChosen?: () => void;
};

/** Account actions shared by every screen; per-account sessions and clients are created lazily. */
export function createAccountsApi({
  store,
  queryClient,
  fetch,
  onChosen,
}: AccountsApiOptions): AccountsActions {
  const clients = new Map<string, ApiClient>();
  const authApi = (baseUrl: string) => createAuthApi(baseUrl, createApiClient({ baseUrl, fetch }));
  // Best effort: the device forgets the tokens even when the server cannot be reached.
  const endOnServer = (baseUrl: string, tokens: SessionTokens) =>
    authApi(baseUrl)
      .logout(tokens.refreshToken, tokens.accessToken)
      .catch(() => undefined);

  const clientFor = (accountId: string): ApiClient => {
    const account = store.get(accountId);
    if (!account) throw new Error(`unknown account ${accountId}`);
    let client = clients.get(accountId);
    if (!client) {
      const session = new AccountSession(accountId, store, { baseUrl: account.serverUrl, fetch });
      client = createApiClient({ baseUrl: account.serverUrl, session, fetch });
      clients.set(accountId, client);
    }
    return client;
  };

  const activate = (accountId: string) => {
    void queryClient.cancelQueries();
    queryClient.clear();
    store.setActive(accountId);
    onChosen?.();
  };

  const signOut = async (accountId: string) => {
    signInFlow.forgetPassword(accountId);
    const account = store.get(accountId);
    // Fresh from the vault: another tab may have rotated the pair this session ends with; unreadable = sign out locally.
    const tokens = await store.readTokens(accountId, true).catch(() => null);
    await store.signOut(accountId);
    queryClient.removeQueries({ queryKey: ['account', accountId] });
    if (account && tokens) void endOnServer(account.serverUrl, tokens);
  };

  return {
    store,
    queryClient,
    clientFor,
    async completeSignIn(server, viewer, tokens) {
      store.reload();
      const existing = store
        .getSnapshot()
        .accounts.find(
          (item) =>
            serverKey(item.serverUrl) === serverKey(server.url) && item.viewerId === viewer.id
        );
      const previous = existing
        ? await store.readTokens(existing.id, true).catch(() => null)
        : null;
      const account = await store.addSignedIn(server, viewer, tokens);
      // Signing in again replaces the device's session: end the old one instead of orphaning it.
      if (previous && previous.sessionId !== tokens.sessionId)
        void endOnServer(server.url, previous);
      activate(account.id);
      return account;
    },
    activate,
    signOut,
    async remove(accountId) {
      await signOut(accountId);
      clients.delete(accountId);
      await store.remove(accountId);
      deleteAccountCache(accountId);
    },
  };
}
