export type EndOverlay = 'upNext' | 'endCard' | null;

export type EndInput = {
  playing: boolean;
  ended: boolean;
  hasNext: boolean;
  upNextDismissed: boolean;
  blocked: boolean;
  remaining: number;
  duration: number;
  upNextSeconds: number;
};

/** Which end-of-playback overlay shows: the up-next countdown first, the end card once it is gone. */
export function endOverlay(input: EndInput): EndOverlay {
  if (!input.playing || input.blocked) return null;
  const nearEnd = input.ended || (input.duration > 0 && input.remaining <= input.upNextSeconds);
  if (input.hasNext && !input.upNextDismissed && nearEnd) return 'upNext';
  return input.ended ? 'endCard' : null;
}
