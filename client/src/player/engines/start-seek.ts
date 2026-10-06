/** Seconds a landed start may differ from its target. */
export const START_TOLERANCE = 3;
/** Time events to wait after a start seek before judging whether it landed. */
const SETTLE_EVENTS = 5;

/** Applies a start position once the media is ready (earlier seeks get dropped), checks it landed, retries once. */
export class StartSeek {
  private attempts = 0;
  private eventsSinceApply = 0;
  private done: boolean;
  private gaveUp = false;

  constructor(
    readonly target: number,
    private readonly apply: (position: number) => void,
    private readonly maxAttempts = 2
  ) {
    this.done = !(target > 0);
  }

  /** True until the start landed, failed for good or was cancelled. */
  get pending(): boolean {
    return !this.done;
  }

  get applied(): boolean {
    return this.attempts > 0;
  }

  /** The seek was retried and still did not land: the item sits elsewhere (often 0:00). */
  get failed(): boolean {
    return this.gaveUp;
  }

  /** The media is ready to seek: applies the start the first time. */
  ready(): void {
    if (this.done || this.attempts > 0) return;
    this.attempts = 1;
    this.eventsSinceApply = 0;
    this.apply(this.target);
  }

  /** Reports a time event; retries the seek once if the position did not reach the target. */
  time(position: number): void {
    if (this.done || this.attempts === 0) return;
    if (Math.abs(position - this.target) <= START_TOLERANCE) {
      this.done = true;
      return;
    }
    this.eventsSinceApply += 1;
    if (this.eventsSinceApply < SETTLE_EVENTS) return;
    if (this.attempts >= this.maxAttempts) {
      this.done = true;
      this.gaveUp = true;
      return;
    }
    this.attempts += 1;
    this.eventsSinceApply = 0;
    this.apply(this.target);
  }

  /** The viewer seeked or a new source loads: the start no longer applies. */
  cancel(): void {
    this.done = true;
  }
}
