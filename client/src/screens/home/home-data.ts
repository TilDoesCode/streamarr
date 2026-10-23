import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useActiveAccount } from '@/accounts/accounts-provider';
import {
  useContinueWatching,
  useHomeRows,
  useMovieDetail,
  useNextUp,
  useSeasonDetail,
  useSeriesDetail,
  useWatchRefreshOnFocus,
  type CatalogItem,
  type CatalogRow,
  type NextUpItem,
  type WatchState,
} from '@/browse/queries';
import { parseWorkId } from '@/lib/work-id';

import { continueRowKeys } from './featured';

/** How long Home waits for all its sections before it shows what it has (a slow endpoint must not block it). */
export const homeTiming = { readyTimeoutMs: 4000 };

export type DiscoverRow = CatalogRow & { items: CatalogItem[] };

/** What Home lists, in the order it shows them. */
export type HomeLists = {
  continueItems: WatchState[];
  nextItems: NextUpItem[];
  discover: DiscoverRow[];
};

/** The title Home's hero opens on: the first card of the first row (its detail fills the hero). */
export type HomeLead = { movie?: number; series?: number; season?: number };

type Settling = { data: unknown; error: unknown };

const settled = (query: Settling) => query.data !== undefined || !!query.error;

/** The lists as the server sends them; Next up drops series that are already in Continue watching. */
export function homeLists(
  rows: readonly CatalogRow[] | undefined,
  resume: readonly WatchState[] | undefined,
  nextUp: readonly NextUpItem[] | undefined
): HomeLists {
  const continueItems = [...(resume ?? [])];
  const resumeIds = new Set(continueItems.map((item) => item.workId));
  return {
    continueItems,
    nextItems: (nextUp ?? []).filter((item) => !resumeIds.has(item.workId)),
    discover: (rows ?? []).filter((row): row is DiscoverRow => !!row.items?.length),
  };
}

/** Keeps shown items where they are (with fresh data); gone ones drop out, new ones go last. */
export function stableMerge<T>(
  shown: readonly T[],
  next: readonly T[],
  keys: (list: readonly T[]) => readonly string[]
): T[] {
  const nextKeys = keys(next);
  const byKey = new Map(nextKeys.map((key, index) => [key, next[index]!]));
  const shownKeys = keys(shown);
  const kept: T[] = [];
  for (const key of shownKeys) {
    const item = byKey.get(key);
    if (item === undefined) continue;
    kept.push(item);
    byKey.delete(key);
  }
  const seen = new Set(shownKeys);
  return [...kept, ...next.filter((_, index) => !seen.has(nextKeys[index]!))];
}

const continueKeys = (items: readonly WatchState[]) =>
  continueRowKeys(items.map((item) => item.workId));
const nextKeys = (items: readonly NextUpItem[]) => items.map((item) => item.workId ?? '');
const rowKeys = (rows: readonly DiscoverRow[]) => rows.map((row) => row.id ?? '');
const itemKeys = (items: readonly CatalogItem[]) =>
  items.map((item) => `${item.mediaType}-${item.tmdbId}`);

/** A background refresh updates Home in place: what is on screen keeps its position, so focus and the top stay. */
export function orderHome(shown: HomeLists, next: HomeLists): HomeLists {
  const shownRows = new Map(shown.discover.map((row) => [row.id, row]));
  return {
    continueItems: stableMerge(shown.continueItems, next.continueItems, continueKeys),
    nextItems: stableMerge(shown.nextItems, next.nextItems, nextKeys),
    discover: stableMerge(shown.discover, next.discover, rowKeys).map((row) => {
      const old = shownRows.get(row.id);
      return old ? { ...row, items: stableMerge(old.items, row.items, itemKeys) } : row;
    }),
  };
}

/** The first card of the first row: what the hero shows first. */
export function homeLead(lists: HomeLists): HomeLead {
  const resume = lists.continueItems[0];
  if (resume) {
    const ref = parseWorkId(resume.workId);
    if (!ref) return {};
    return ref.kind === 'movie'
      ? { movie: ref.tmdbId }
      : { series: ref.tmdbId, ...(ref.kind === 'episode' ? { season: ref.season } : null) };
  }
  const next = lists.nextItems[0];
  if (next) {
    const ref = parseWorkId(next.workId);
    return ref ? { series: ref.tmdbId } : {};
  }
  const pick = lists.discover[0]?.items[0];
  if (!pick) return {};
  return pick.mediaType === 'tv' || pick.mediaType === 'series'
    ? { series: pick.tmdbId }
    : { movie: pick.tmdbId };
}

/**
 * Home renders once: the sections and the lead's detail have all answered, or the timeout passed and
 * at least one section answered (the rest then arrives late, as a fallback).
 */
export function homeReady({
  sections,
  lead,
  timedOut,
}: {
  sections: readonly Settling[];
  lead: readonly (Settling | null)[];
  timedOut: boolean;
}): boolean {
  const all = sections.every(settled) && lead.every((query) => !query || settled(query));
  return all || (timedOut && sections.some(settled));
}

/**
 * Home's data for every Home layout: rows, Continue watching and Next up loaded together (restored from
 * MMKV on a cold start), one `ready` gate for the first render and an order that background refreshes
 * do not shuffle. `epoch`: bump it to take the server's order again with the next answer (Home restarted).
 */
export function useHomeData({ epoch = 0 }: { epoch?: number } = {}) {
  useWatchRefreshOnFocus();
  const { account } = useActiveAccount();
  const { i18n } = useTranslation();
  const scope = `${account.id}:${i18n.language}`;
  const rows = useHomeRows();
  const resume = useContinueWatching();
  const nextUp = useNextUp();
  const sections = [rows, resume, nextUp];

  // Coming back to Home (player, detail) takes the server's order with the next answer, not any refresh.
  const [focusEpoch, setFocusEpoch] = useState(0);
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else setFocusEpoch((value) => value + 1);
    }, [])
  );
  const reorder = `${scope}:${epoch}:${focusEpoch}`;
  const version = `${rows.dataUpdatedAt}:${resume.dataUpdatedAt}:${nextUp.dataUpdatedAt}`;
  const fresh = homeLists(rows.data, resume.data, nextUp.data);
  const [shown, setShown] = useState(() => ({ version, reorder, lists: fresh }));
  let lists = shown.lists;
  if (shown.version !== version) {
    lists = shown.reorder === reorder ? orderHome(shown.lists, fresh) : fresh;
    setShown({ version, reorder, lists });
  }

  const [timedOutScope, setTimedOutScope] = useState<string | null>(null);
  const timedOut = timedOutScope === scope;
  const sectionsSettled = sections.every(settled);
  // The lead is only known once the sections answered; fetching an earlier guess would be wasted.
  const lead = sectionsSettled || timedOut ? homeLead(lists) : {};
  const movie = useMovieDetail(lead.movie, lead.movie !== undefined, { persist: true });
  const series = useSeriesDetail(lead.series, lead.series !== undefined, { persist: true });
  const season = useSeasonDetail(lead.series, lead.season, false, { persist: true });
  const computed = homeReady({
    sections,
    lead: [
      lead.movie !== undefined ? movie : null,
      lead.series !== undefined ? series : null,
      lead.season !== undefined ? season : null,
    ],
    timedOut,
  });
  // Once shown, Home stays shown: a refresh that changes the lead must not bring the skeleton back.
  const [readyScope, setReadyScope] = useState<string | null>(null);
  if (computed && readyScope !== scope) setReadyScope(scope);
  const ready = computed || readyScope === scope;

  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setTimedOutScope(scope), homeTiming.readyTimeoutMs);
    return () => clearTimeout(timer);
  }, [ready, scope]);

  const failed = sections.filter((query) => query.error).map((query) => query.error);
  const retry = () => {
    for (const query of sections) if (query.error) void query.refetch();
  };
  return {
    ...lists,
    ready,
    /** The rows failed and nothing is known: Home shows its error state. */
    rowsError: rows.data === undefined ? rows.error : null,
    failed,
    retry,
  };
}
