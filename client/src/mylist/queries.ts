import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import type { components } from '@/api/schema';
import { useToast } from '@/components/ui/toast';
import { accountKey } from '@/query/keys';

export type MyListItem = components['schemas']['MyListItemDto'];
export type MyListSummary = components['schemas']['MyListSummaryResponse'];
export type MyListEntryStatus = components['schemas']['MyListEntryStatusResponse'];

/** The server answers new episodes within a monitor pass; the badge looks every few minutes (and on focus, after playback). */
export const SUMMARY_POLL_MS = 3 * 60_000;

/** Under the account's 'watch' keys: playback and played marks refresh the list too (invalidateWatchQueries). */
export const listKey = (accountId: string, ...rest: readonly unknown[]) =>
  accountKey(accountId, 'watch', 'list', ...rest);

function useLanguage(): string {
  const { i18n } = useTranslation();
  return i18n.language === 'de' ? 'de' : 'en';
}

export function invalidateList(queryClient: QueryClient, accountId: string) {
  return queryClient.invalidateQueries({ queryKey: listKey(accountId) });
}

/** Every entry of the list (new ones first, then by recent activity). */
export function useMyList() {
  const { account, client } = useActiveAccount();
  const language = useLanguage();
  return useQuery({
    queryKey: listKey(account.id, 'items', language),
    queryFn: ({ signal }) =>
      unwrap(client.GET('/api/v1/viewer/list', { params: { query: { limit: 500 } }, signal })),
  });
}

/** Counts for the tab badge; polled while the app is open. */
export function useMyListSummary() {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: listKey(account.id, 'summary'),
    queryFn: ({ signal }) => unwrap(client.GET('/api/v1/viewer/list/summary', { signal })),
    refetchInterval: SUMMARY_POLL_MS,
    refetchOnWindowFocus: true,
    // A failing summary never shows an error anywhere: the badge just stays as it was.
    retry: false,
  });
}

/** Entries with a new available episode (0 while unknown). */
export function useMyListBadge(): number {
  return useMyListSummary().data?.newCount ?? 0;
}

/** Whether one movie, series or season is on the list. */
export function useListEntry(workId: string | null | undefined) {
  const { account, client } = useActiveAccount();
  const language = useLanguage();
  return useQuery({
    queryKey: listKey(account.id, 'entry', workId, language),
    enabled: !!workId,
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/list/{workId}', {
          params: { path: { workId: workId ?? '' } },
          signal,
        })
      ),
  });
}

/** Adds or removes a title (toast "“X” added to My List"); the button flips at once. */
export function useListToggle({
  workId,
  title,
}: {
  workId: string | null | undefined;
  title: string;
}) {
  const { t } = useTranslation();
  const { account, client } = useActiveAccount();
  const queryClient = useQueryClient();
  const toast = useToast();
  const language = useLanguage();
  const entry = useListEntry(workId);
  const onList = !!entry.data?.onList;
  const key = listKey(account.id, 'entry', workId, language);
  const mutation = useMutation({
    mutationFn: async (add: boolean) => {
      const path = { params: { path: { workId: workId ?? '' } } };
      if (add) await unwrap(client.PUT('/api/v1/viewer/list/{workId}', path));
      else await unwrap(client.DELETE('/api/v1/viewer/list/{workId}', path));
      return add;
    },
    onMutate: (add) => {
      const previous = queryClient.getQueryData<MyListEntryStatus>(key);
      queryClient.setQueryData<MyListEntryStatus>(key, (old) => ({
        ...old,
        workId: workId ?? '',
        onList: add,
      }));
      return { previous };
    },
    onSuccess: (add) =>
      toast.show({
        message: t(add ? 'mylist.added' : 'mylist.removed', { title }),
        tone: 'success',
      }),
    onError: (_error, _add, context) => {
      queryClient.setQueryData(key, context?.previous);
      toast.show({ message: t('mylist.failed'), tone: 'error' });
    },
    onSettled: () => invalidateList(queryClient, account.id),
  });
  return {
    onList,
    ready: entry.isSuccess,
    pending: mutation.isPending,
    toggle: () => {
      if (workId && !mutation.isPending) mutation.mutate(!onList);
    },
  };
}

/** Clears an entry's new flag (opening it from the list). */
export function useMarkListSeen() {
  const { account, client } = useActiveAccount();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workId: string) =>
      unwrap(client.POST('/api/v1/viewer/list/{workId}/seen', { params: { path: { workId } } })),
    onSettled: () => invalidateList(queryClient, account.id),
  });
}
