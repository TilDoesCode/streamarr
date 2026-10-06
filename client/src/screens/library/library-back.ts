import { useIsFocused } from 'expo-router';

import { tvFocus } from '@/components/focus/tv-focus';
import { useMenuClaim } from '@/components/focus/tv-menu';

export type LibraryZone = 'genres' | 'sort' | 'grid' | null;

export type LibraryFilterParams = { genre?: string; sort?: string };

/** A genre or sort change replaces the page's params on every platform: one Library entry, Back leaves it (F11). */
export function applyLibraryFilter(
  router: { setParams(params: LibraryFilterParams): void },
  params: LibraryFilterParams
): void {
  router.setParams(params);
}

/** TV Back inside a library page: grid or sort -> the selected chip, the chip -> the rail, else the shell's Back. */
export function libraryBackStep(zone: LibraryZone): {
  step: 'chip' | 'rail' | null;
  zone: LibraryZone;
} {
  if (zone === 'genres') return { step: 'rail', zone: null };
  if (zone) return { step: 'chip', zone };
  return { step: null, zone: null };
}

/** Apple TV: grid and sort take Menu for their own step; at the chips tvOS moves focus to the tab bar natively. */
export function libraryMenuClaim(zone: LibraryZone, screenFocused: boolean): 'always' | null {
  return screenFocused && (zone === 'grid' || zone === 'sort') ? 'always' : null;
}

/** Apple TV: claims Menu for the page's own step while the page is the visible screen. */
export function useLibraryMenuClaim(zone: LibraryZone): void {
  useMenuClaim(libraryMenuClaim(zone, useIsFocused()));
}

/** The page's Back step; none while the Menu press came from the tab bar (Start comes first there). */
export function libraryBack(
  zone: LibraryZone,
  inTabBar: boolean
): ReturnType<typeof libraryBackStep> {
  return inTabBar ? { step: null, zone } : libraryBackStep(zone);
}

/** The chip Back step: the header scrolls back into view first, the chip takes focus once it is laid out on screen. */
export function backToChip(
  list: { scrollToOffset: (params: { offset: number; animated?: boolean }) => void } | null,
  chip: () => { requestTVFocus?: () => void } | null,
  nextFrame: (run: () => void) => unknown = requestAnimationFrame
): void {
  list?.scrollToOffset({ offset: 0, animated: false });
  nextFrame(() => tvFocus(chip()));
}
