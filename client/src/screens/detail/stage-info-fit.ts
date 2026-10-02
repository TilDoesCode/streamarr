import { focusClearance } from '@/theme/focus-clearance';

type Ring = Parameters<typeof focusClearance>[0];

/** Highest y the info column's focus lift and ring reach, for a column at `top` with `height`. */
export function liftedTop(top: number, height: number, focus: Ring, scale: number): number {
  return top - focusClearance(focus, height, scale);
}

/** One more content step while the lifted column still crosses `limit` (TV tab bar bottom or screen top). */
export function nextInfoCut(cut: number, lifted: number, limit: number, maxCut: number): number {
  return lifted < limit && cut < maxCut ? cut + 1 : cut;
}

export const SERIES_INFO_MAX_CUT = 6;

/** "About the series" by cut: overview 4 → 1 lines, then genres, rating and facts go; progress and the link stay. */
export function seriesInfoPlan(cut: number) {
  return {
    overviewLines: Math.max(1, 4 - cut),
    genres: cut < 4,
    rating: cut < 5,
    facts: cut < 6,
  };
}

export const MOVIE_INFO_MAX_CUT = 4;

/** Movie "Details" by cut: credit values 2 → 1 lines, then the rating row, then credits from the end (one stays). */
export function movieInfoPlan(cut: number) {
  return {
    creditLines: cut ? 1 : 2,
    rating: cut < 2,
    credits: cut < 3 ? 3 : cut === 3 ? 2 : 1,
  };
}
