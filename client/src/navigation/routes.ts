import type { Href } from 'expo-router';

import { parseWorkId } from '@/lib/work-id';

/** Detail route of a catalog item (TMDB id): movies and series have their own screens. */
export function titleHref(item: { mediaType: string | null; tmdbId: number }): Href {
  const id = String(item.tmdbId);
  return item.mediaType === 'series' || item.mediaType === 'tv'
    ? { pathname: '/series/[id]', params: { id } }
    : { pathname: '/movie/[id]', params: { id } };
}

/** Detail route of a work id (episodes and seasons open their series). */
export function workHref(workId: string | null | undefined): Href | undefined {
  const ref = parseWorkId(workId);
  if (!ref) return undefined;
  const id = String(ref.tmdbId);
  return ref.kind === 'movie'
    ? { pathname: '/movie/[id]', params: { id } }
    : { pathname: '/series/[id]', params: { id } };
}

export type PlayRequest = {
  workId: string;
  title: string;
  /** Omitted: the server plays its recommended version. */
  releaseId?: string | null;
  /** Start position in seconds (0 = from the start). */
  startSeconds?: number;
};

/** Player route; the playback is created there (`playbackId` "new"). */
export function playHref({ workId, title, releaseId, startSeconds }: PlayRequest): Href {
  return {
    pathname: '/play/[playbackId]',
    params: {
      playbackId: 'new',
      workId,
      title,
      ...(releaseId ? { releaseId } : null),
      ...(startSeconds !== undefined ? { start: String(Math.floor(startSeconds)) } : null),
    },
  };
}

/** Detail route for "Back to details": episodes and seasons open their series on that season. */
export function detailHref(workId: string | null | undefined): Href | undefined {
  const ref = parseWorkId(workId);
  if (!ref || ref.kind === 'movie' || ref.kind === 'series') return workHref(workId);
  return {
    pathname: '/series/[id]',
    params: { id: String(ref.tmdbId), season: String(ref.season) },
  };
}

export type RouteLeaf = { name: string; params?: object };

/** Whether `opener` (the focused leaf route under the player) is the detail screen of `workId`. */
export function isDetailOf(
  opener: RouteLeaf | undefined,
  workId: string | null | undefined
): boolean {
  const ref = parseWorkId(workId);
  const id = (opener?.params as { id?: unknown } | undefined)?.id;
  if (!ref || !opener || String(id) !== String(ref.tmdbId)) return false;
  return ref.kind === 'movie'
    ? opener.name === 'movie/[id]'
    : opener.name.startsWith('series/[id]');
}

type NavState = { index?: number; routes: { name: string; params?: object; state?: NavState }[] };

/** Focused leaf of the route below the top of `state` (the screen that opened the player). */
export function openerLeaf(state: NavState | undefined): RouteLeaf | undefined {
  if (!state) return undefined;
  const index = state.index ?? state.routes.length - 1;
  let route = state.routes[index - 1];
  while (route?.state)
    route = route.state.routes[route.state.index ?? route.state.routes.length - 1];
  return route && { name: route.name, params: route.params };
}
