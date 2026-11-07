import { routeFromUrl } from './title-link';

/** A link to /movies names its segment, so the phones' Library tab opens on Movies (not on the last choice). */
export function libraryLink(url: string): string {
  const route = routeFromUrl(url);
  if (!/^\/movies\/?(\?.*)?$/.test(route) || /[?&]kind=/.test(route)) return url;
  return route.includes('?') ? `${route}&kind=movie` : `${route.replace(/\/$/, '')}?kind=movie`;
}
