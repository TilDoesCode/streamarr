import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import { createTimeoutFetch } from '@/api/http';
import type { components } from '@/api/schema';
import { accountKey } from '@/query/keys';

export type UsenetSpeedResult = components['schemas']['UsenetSpeedTestResponse'];
export type UsenetSpeedState = components['schemas']['UsenetSpeedTestStateResponse'];

/** While a test runs on the server its state is polled this often (the web app does the same). */
export const USENET_POLL_MS = 2_000;
/** A run waits for up to three providers (connect, measure, drain each) behind other callers' tests. */
export const USENET_RUN_TIMEOUT_MS = 120_000;

const runFetch = createTimeoutFetch(undefined, USENET_RUN_TIMEOUT_MS);

export const usenetSpeedKey = (accountId: string) =>
  accountKey(accountId, 'diagnostics', 'usenet-speed');

/** A new measurement changes every version's bitrate fit: refetch the version lists. */
export function invalidateVersionLists(queryClient: QueryClient, accountId: string) {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === 'account' &&
      queryKey[1] === accountId &&
      queryKey[2] === 'catalog' &&
      queryKey[3] === 'versions',
  });
}

/** The server's last Usenet speed test (shared by everyone) and a run that joins, reuses or starts one. */
export function useUsenetSpeed() {
  const { account, client } = useActiveAccount();
  const queryClient = useQueryClient();
  const key = usenetSpeedKey(account.id);
  const focused = useIsFocused();
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      unwrap(client.GET('/api/v1/viewer/diagnostics/usenet-speed', { signal })),
    staleTime: 30_000,
    // A running flag left over from the cache or another device is re-checked on open and polled until it clears.
    refetchOnMount: 'always',
    refetchInterval: (current) => (focused && current.state.data?.running ? USENET_POLL_MS : false),
    retry: false,
  });
  const run = useMutation({
    mutationFn: () =>
      unwrap(client.POST('/api/v1/viewer/diagnostics/usenet-speed', { fetch: runFetch })),
    // A run that timed out or dropped may still be going on the server: ask for its state and keep polling.
    onError: () => void queryClient.invalidateQueries({ queryKey: key, exact: true }),
    onSuccess: (latest) => {
      queryClient.setQueryData<UsenetSpeedState>(key, (previous) => ({
        allowed: previous?.allowed ?? true,
        running: false,
        latest,
      }));
      void invalidateVersionLists(queryClient, account.id);
    },
  });
  return { query, run };
}
