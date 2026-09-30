import type { Href } from 'expo-router';

/** Detail route of a catalog item (TMDB id): movies and series have their own screens. */
export function titleHref(item: { mediaType: string | null; tmdbId: number }): Href {
  const id = String(item.tmdbId);
  return item.mediaType === 'series' || item.mediaType === 'tv'
    ? { pathname: '/series/[id]', params: { id } }
    : { pathname: '/movie/[id]', params: { id } };
}

/** Player route; `playbackId` comes from the playback API (M4.2), the placeholder passes the work. */
export function playHref(playbackId: string, work: { workId: string | null; title: string }): Href {
  return {
    pathname: '/play/[playbackId]',
    params: { playbackId, work: work.workId ?? '', title: work.title },
  };
}
