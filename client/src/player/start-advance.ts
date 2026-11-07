/** Wall time a start that missed its ±3 s landing must play on at normal speed before it counts (an engine's overshoot). */
export const START_ADVANCE_MS = 5_000;
/** Seconds the clock may differ from the wall time it played over. */
const ADVANCE_TOLERANCE = 1;
/** The player has no speed setting: it always plays at normal speed. */
const PLAYBACK_RATE = 1;

/** Proves a start by playback: the clock advancing with the wall clock for 5 s (a stale or jumping clock never does). */
export class StartAdvance {
  private anchor: { target: number; position: number; at: number } | null = null;

  /** A reading that does not count (paused, buffering, the engine still seeking): the 5 s begin again. */
  reset(): void {
    this.anchor = null;
  }

  /** A reading while playing; true once the clock advanced like the wall clock for at least 5 s. */
  playing(target: number, position: number, at: number): boolean {
    const anchor = this.anchor;
    if (!anchor || anchor.target !== target) {
      this.anchor = { target, position, at };
      return false;
    }
    const wall = at - anchor.at;
    const expected = (wall / 1000) * PLAYBACK_RATE;
    if (Math.abs(position - anchor.position - expected) > ADVANCE_TOLERANCE) {
      this.anchor = { target, position, at };
      return false;
    }
    return wall >= START_ADVANCE_MS;
  }
}
