import { SHELL } from '@/shell/shell-metrics';

/** Where the large shell's player header (back, "now playing", the title line) ends: hints go below it (V2 iPad). */
export function largeHeaderBottom(
  insetTop: number,
  s: (value: number) => number,
  windowControls: number
): number {
  return Math.max(insetTop, s(64)) + windowControls + s(SHELL.button) + s(14) + s(68);
}
