import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import type { components } from '@/api/schema';
import { accountKey } from '@/query/keys';

export type UsenetSpeedResult = components['schemas']['UsenetSpeedTestResponse'];
export type UsenetSpeedState = components['schemas']['UsenetSpeedTestStateResponse'];

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
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      unwrap(client.GET('/api/v1/viewer/diagnostics/usenet-speed', { signal })),
    staleTime: 30_000,
    retry: false,
  });
  const run = useMutation({
    mutationFn: () => unwrap(client.POST('/api/v1/viewer/diagnostics/usenet-speed')),
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
