/** Wall time a start that missed its ±3 s landing must play on at normal speed before it counts (an engine's overshoot). */
export const START_ADVANCE_MS = 5_000;
/** Seconds the clock may differ from the wall time it played over. */
const ADVANCE_TOLERANCE = 1;
/** The player has no speed setting: it always plays at normal speed. */
const PLAYBACK_RATE = 1;
/** Seconds past its target an engine's start may land (a keyframe, a segment); a proof begins no further away. */
const MAX_OVERSHOOT = 30;

/** Proves a start by playback: one unbroken 5 s epoch from near its target, the clock moving with the wall clock. */
export class StartAdvance {
  private anchor: { target: number; position: number; at: number } | null = null;

  /** Anything that breaks playback (a pause, a stall, a seek, a new source, the background): the 5 s begin again. */
  reset(): void {
    this.anchor = null;
  }

  /** A reading while playing; true once the clock advanced like the wall clock for at least 5 s. */
  playing(target: number, position: number, at: number): boolean {
    const anchor = this.anchor;
    if (anchor?.target === target) {
      const wall = at - anchor.at;
      const expected = (wall / 1000) * PLAYBACK_RATE;
      if (Math.abs(position - anchor.position - expected) <= ADVANCE_TOLERANCE)
        return wall >= START_ADVANCE_MS;
    }
    // An old source's clock far past the target never begins a proof.
    this.anchor = position - target <= MAX_OVERSHOOT ? { target, position, at } : null;
    return false;
  }
}
