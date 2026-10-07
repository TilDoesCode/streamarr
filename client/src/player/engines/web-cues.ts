/** The cue placement the browser had before a lift, to put back when the controls hide. */
type Placement = { line: number | 'auto'; snapToLines: boolean; lineAlign: string };
type Cue = Partial<Placement> & object;
type Track = { mode: string; cues?: ArrayLike<Cue> | null; activeCues?: ArrayLike<Cue> | null };

const placed = new WeakMap<object, Placement>();

/** Puts one cue above the bottom `fraction` of the picture (VTTCue line in percent), or back where it was. */
export function liftCue(cue: Cue, fraction: number): void {
  if (!('line' in cue)) return;
  if (fraction <= 0) {
    const before = placed.get(cue);
    if (!before) return;
    Object.assign(cue, before);
    placed.delete(cue);
    return;
  }
  if (!placed.has(cue))
    placed.set(cue, {
      line: cue.line ?? 'auto',
      snapToLines: cue.snapToLines ?? true,
      lineAlign: cue.lineAlign ?? 'start',
    });
  Object.assign(cue, {
    snapToLines: false,
    line: Math.round((1 - fraction) * 100),
    lineAlign: 'end',
  });
}

/** The cues of the showing text tracks: all of them on a change of the lift, the active ones as playback runs. */
export function liftCues(
  tracks: ArrayLike<Track> | null | undefined,
  fraction: number,
  activeOnly = false
): void {
  for (let i = 0; tracks && i < tracks.length; i++) {
    const track = tracks[i]!;
    if (track.mode !== 'showing') continue;
    const cues = activeOnly ? track.activeCues : (track.cues ?? track.activeCues);
    for (let j = 0; cues && j < cues.length; j++) liftCue(cues[j]!, fraction);
  }
}
