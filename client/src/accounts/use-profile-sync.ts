import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { unwrap } from '@/api/client';
import { useWatchRefreshOnForeground } from '@/browse/queries';
import { queryKeys } from '@/query/keys';
import { STALE } from '@/query/query-client';

import { useAccountsApi, type AccountsApi } from './accounts-provider';
import { profileColor } from './account-store';
import { viewerFromProfile, type ViewerProfile } from './auth-api';
import type { Account } from './types';

/** Stores a fresh /viewer/me answer on the local profile (name, avatar, forced password change). */
export function syncProfile(api: AccountsApi, account: Account, profile: ViewerProfile) {
  const viewer = viewerFromProfile(profile);
  const avatarKey = viewer.avatarKey ?? null;
  if (
    viewer.displayName !== account.displayName ||
    avatarKey !== (account.avatarKey ?? null) ||
    viewer.mustChangePassword !== account.mustChangePassword
  )
    api.store.update(account.id, {
      displayName: viewer.displayName,
      avatarKey,
      color: profileColor(account.viewerId, avatarKey),
      mustChangePassword: viewer.mustChangePassword,
    });
}

/** Keeps the stored profile (name, avatar, forced password change) in step with the server; also checks the session. */
export function useProfileSync(account: Account): void {
  const api = useAccountsApi();
  const { data } = useQuery({
    queryKey: queryKeys.me(account.id),
    queryFn: ({ signal }) => unwrap(api.clientFor(account.id).GET('/api/v1/viewer/me', { signal })),
    enabled: account.signedIn,
    staleTime: STALE.profile,
    // Polls while the app is in the foreground (a TV can stay there for hours), not in the background.
    refetchInterval: STALE.profile,
  });
  useEffect(() => {
    if (data) syncProfile(api, account, data);
  }, [data, account, api]);
}

/** Mount point for useProfileSync, rendered only while a profile is in use (no query without an account). */
export function ProfileSync({ account }: { account: Account }): null {
  useProfileSync(account);
  useWatchRefreshOnForeground(account.id);
  return null;
}
