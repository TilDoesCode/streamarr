import type { TFunction } from 'i18next';

/** DL-C1's lock while the server has not confirmed a title's age rating yet (C2-08). */
export const AGE_UNVERIFIED = 'age_unverified';

/** "Checking the age rating…" for an unverified title, else the known lock's `lockedKey`. */
export function lockLabel(
  t: TFunction,
  reason: string | null | undefined,
  lockedKey: 'downloads.library.locked' | 'downloads.detail.locked'
): string {
  return t(reason === AGE_UNVERIFIED ? 'downloads.detail.ageUnverified' : lockedKey);
}
