import { useEffect, useState } from 'react';

import { fullscreenChromeInset, isFullscreen, onFullscreenChange } from '@/player/fullscreen';
import { LARGE_TITLE_MAX_WIDTH } from '@/player/overlay-labels';
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

/** The large header's title: 80 % of the window, and with a glass side panel open it ends before the panel (Q2-01). */
export function largeTitleMaxWidth(
  windowWidth: number,
  s: (value: number) => number,
  panelWidth: number | null
): number | `${number}%` {
  if (panelWidth === null) return LARGE_TITLE_MAX_WIDTH;
  // Left inset of the header, the panel's right inset and width, and a gap before the panel.
  return Math.max(0, windowWidth - s(96) - s(64) - s(panelWidth) - s(32));
}

/** What the overlay header adds above itself: iPad window controls and Safari's full-screen chrome (review 10 P3-6). */
export function useHeaderInset(): number {
  const windowInset = useWindowControlsInset();
  const [fullscreen, setFullscreen] = useState(isFullscreen);
  useEffect(() => onFullscreenChange(() => setFullscreen(isFullscreen())), []);
  return windowInset + fullscreenChromeInset(fullscreen);
}
