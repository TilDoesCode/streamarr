/** Native apps are always full screen. */
export const fullscreenAvailable = false;

export function isFullscreen(): boolean {
  return true;
}

export function toggleFullscreen(): void {}

export function onFullscreenChange(_listener: () => void): () => void {
  return () => undefined;
}

export function fullscreenChromeInset(_fullscreen: boolean): number {
  return 0;
}
