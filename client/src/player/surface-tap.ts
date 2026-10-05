/** What a single tap on the picture does on web: a mouse click toggles playback; a touch on hidden controls only shows them. */
export function webSurfaceTap(
  controlsVisible: boolean,
  pointerType: string | null
): 'toggle' | 'show' {
  return controlsVisible || pointerType === 'mouse' ? 'toggle' : 'show';
}
