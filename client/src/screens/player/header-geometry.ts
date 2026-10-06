import { useEffect, useState } from 'react';

import { fullscreenChromeInset, isFullscreen, onFullscreenChange } from '@/player/fullscreen';
import { SHELL } from '@/shell/shell-metrics';
import { useWindowControlsInset } from '@/shell/window-controls';

/** Where the large shell's player header (back, "now playing", the title line) ends: hints go below it (V2 iPad). */
export function largeHeaderBottom(
  insetTop: number,
  s: (value: number) => number,
  windowControls: number
): number {
  return Math.max(insetTop, s(64)) + windowControls + s(SHELL.button) + s(14) + s(68);
}

/** What the overlay header adds above itself: iPad window controls and Safari's full-screen chrome (review 10 P3-6). */
export function useHeaderInset(): number {
  const windowInset = useWindowControlsInset();
  const [fullscreen, setFullscreen] = useState(isFullscreen);
  useEffect(() => onFullscreenChange(() => setFullscreen(isFullscreen())), []);
  return windowInset + fullscreenChromeInset(fullscreen);
}
