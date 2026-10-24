import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { TFunction } from 'i18next';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import { isAppError } from '@/api/errors';
import type { components } from '@/api/schema';
import { accountKey } from '@/query/keys';

export type ServiceStatus = components['schemas']['ServiceStatusResponse'];
export type ServiceCategory = components['schemas']['ServiceStatusCategory'];

export const CATEGORY_IDS = ['usenet', 'server', 'search', 'metadata'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];
export const IMPACTS = [
  'playbackUnavailable',
  'searchUnavailable',
  'playbackMayFail',
  'searchMayBeIncomplete',
  'newTitlesUnavailable',
  'slowerThanUsual',
] as const;
export type Impact = (typeof IMPACTS)[number];

/** The server checks every few minutes on its own; the app looks every 2 min and when it comes back to the foreground. */
export const STATUS_POLL_MS = 2 * 60_000;

/** Transport failures: the server itself cannot be reached (not an outage of its services). */
const UNREACHABLE = new Set(['network_unreachable', 'timeout', 'tls_error']);

export const serviceStatusKey = (accountId: string) =>
  accountKey(accountId, 'diagnostics', 'status');

/** The viewer service status, polled while the app is open. */
export function useServiceStatus() {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: serviceStatusKey(account.id),
    queryFn: ({ signal }) => unwrap(client.GET('/api/v1/viewer/diagnostics/status', { signal })),
    refetchInterval: STATUS_POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export type StatusView =
  | { kind: 'unknown' }
  | { kind: 'unreachable' }
  | { kind: 'ok'; status: ServiceStatus }
  | {
      kind: 'problem';
      status: ServiceStatus;
      state: 'degraded' | 'down';
      primary: CategoryId;
      broken: ServiceCategory[];
      working: ServiceCategory[];
      impact: Impact | undefined;
    };

function categoryId(category: ServiceCategory): CategoryId | undefined {
  return CATEGORY_IDS.find((id) => id === category.id);
}

/** Most severe first: down before degraded, then Usenet, server, search, metadata. */
function severity(category: ServiceCategory): number {
  const order = CATEGORY_IDS.indexOf(categoryId(category) ?? 'metadata');
  return (category.state === 'down' ? 0 : 10) + order;
}

/** What the app shows for a status answer (or the failure of the status call itself). */
export function statusView(
  query: Pick<UseQueryResult<ServiceStatus>, 'data' | 'error' | 'isError'>
): StatusView {
  // A status call that fails for any other reason (old server, 5xx, rate limit) is never shown as an outage.
  if (query.isError && isAppError(query.error) && UNREACHABLE.has(query.error.code))
    return { kind: 'unreachable' };
  const status = query.data;
  if (!status) return { kind: 'unknown' };
  const known = (status.categories ?? []).filter((category) => categoryId(category));
  const broken = known
    .filter((category) => category.state === 'down' || category.state === 'degraded')
    .sort((a, b) => severity(a) - severity(b));
  const first = broken[0];
  if (status.state === 'ok' || !first) return { kind: 'ok', status };
  return {
    kind: 'problem',
    status,
    state: first.state === 'down' ? 'down' : 'degraded',
    primary: categoryId(first)!,
    broken,
    working: known.filter((category) => !broken.includes(category)),
    impact: IMPACTS.find((impact) => (status.impacts ?? []).includes(impact)),
  };
}

/** Whether the Settings tab carries the status dot. */
export function hasProblem(view: StatusView): boolean {
  return view.kind === 'problem';
}

/** "14:05" today, otherwise "24.10., 14:05". */
export function formatClock(value: string, lang: string, now: Date = new Date()): string {
  const date = new Date(value);
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(lang, {
    ...(sameDay ? {} : { day: 'numeric', month: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** The headline of a problem: the most severe category, plus how many more are affected. */
export function problemTitle(t: TFunction, view: Extract<StatusView, { kind: 'problem' }>) {
  const title = t(`serviceStatus.category.${view.primary}.${view.state}`);
  const more = view.broken.length - 1;
  return more > 0 ? t('serviceStatus.andMore', { title, count: more }) : title;
}

/** "Playback may fail right now. It's the server, not your device. The admin is notified automatically." */
export function problemMessage(t: TFunction, view: Extract<StatusView, { kind: 'problem' }>) {
  return [
    view.impact ? t(`serviceStatus.impact.${view.impact}`) : null,
    t('serviceStatus.notYou'),
    view.status.adminNotified ? t('serviceStatus.adminNotified') : null,
  ]
    .filter(Boolean)
    .join(' ');
}

const PLAYBACK_IMPACTS: readonly Impact[] = ['playbackUnavailable', 'playbackMayFail'];
const PLAYBACK_CATEGORIES: readonly CategoryId[] = ['usenet', 'server'];

/** An outage that explains a failed playback: Usenet providers or the server's own storage/database (not slowness). */
export function playbackOutage(view: StatusView) {
  if (view.kind !== 'problem') return null;
  const impact = PLAYBACK_IMPACTS.find((code) => (view.status.impacts ?? []).includes(code));
  const cause = view.broken.find((category) =>
    PLAYBACK_CATEGORIES.some((id) => id === category.id)
  );
  if (!impact || !cause) return null;
  return {
    impact,
    category: categoryId(cause)!,
    state: cause.state === 'down' ? ('down' as const) : ('degraded' as const),
    adminNotified: !!view.status.adminNotified,
  };
}

export type PlaybackOutage = NonNullable<ReturnType<typeof playbackOutage>>;

/** "Usenet provider outage. Playback doesn't work right now. It's the server, not your device. The admin is notified." */
export function playbackOutageMessage(t: TFunction, outage: PlaybackOutage) {
  return [
    t('serviceStatus.playbackOutage.cause', {
      title: t(`serviceStatus.category.${outage.category}.${outage.state}`),
    }),
    t(`serviceStatus.impact.${outage.impact}`),
    t('serviceStatus.notYou'),
    outage.adminNotified ? t('serviceStatus.adminNotified') : null,
  ]
    .filter(Boolean)
    .join(' ');
}
