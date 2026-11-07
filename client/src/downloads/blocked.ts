import type { OfflineDownload, ViewerPolicy } from './types';

/** Refusals that block a download until the viewer may download the work again (no Retry while blocked). */
export const BLOCKED_CODES: ReadonlySet<string> = new Set([
  'downloads_not_allowed',
  'age_restricted',
]);

export const isBlockedDownload = (download: Pick<OfflineDownload, 'error'>) =>
  !!download.error && BLOCKED_CODES.has(download.error.code);

const number = (value: string | number | null | undefined) => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

/**
 * Whether the persisted permissions would let the server serve a blocked download again (it is then asked, never
 * assumed). Age refusals carry the server's decision (`reason`, `minimumAge`, `viewerMaxAge`, docs/api.md § 13).
 */
export function allowedAgain(
  download: Pick<OfflineDownload, 'error' | 'meta'>,
  policy: ViewerPolicy | null
): boolean {
  if (!policy?.allowDownloads || !download.error) return false;
  if (download.error.code === 'downloads_not_allowed') return true;
  if (download.error.code !== 'age_restricted') return false;
  if (policy.maxAge === null) return true;
  const params = download.error.params ?? {};
  if (params.reason === 'unrated_blocked') return !policy.blockUnrated;
  // TMDB had no rating then: the server decides again.
  if (params.reason === 'rating_unavailable') return true;
  const minimum = number(params.minimumAge) ?? number(download.meta.minimumAge);
  if (minimum !== null) return minimum <= policy.maxAge;
  if (download.meta.rated === false) return !policy.blockUnrated;
  const before = number(params.viewerMaxAge);
  return before !== null && policy.maxAge > before;
}
