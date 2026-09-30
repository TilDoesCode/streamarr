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
