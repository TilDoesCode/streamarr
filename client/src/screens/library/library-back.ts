export type LibraryZone = 'genres' | 'sort' | 'grid' | null;

/** TV Back inside a library page: grid or sort -> the selected chip, the chip -> the rail, else the shell's Back. */
export function libraryBackStep(zone: LibraryZone): {
  step: 'chip' | 'rail' | null;
  zone: LibraryZone;
} {
  if (zone === 'genres') return { step: 'rail', zone: null };
  if (zone) return { step: 'chip', zone };
  return { step: null, zone: null };
}

/** The chip Back step: the header scrolls back into view first, the chip takes focus once it is laid out on screen. */
export function backToChip(
  list: { scrollToOffset: (params: { offset: number; animated?: boolean }) => void } | null,
  chip: () => { requestTVFocus?: () => void } | null,
  nextFrame: (run: () => void) => unknown = requestAnimationFrame
): void {
  list?.scrollToOffset({ offset: 0, animated: false });
  nextFrame(() => chip()?.requestTVFocus?.());
}
