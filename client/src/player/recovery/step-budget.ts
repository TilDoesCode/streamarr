import { STEP_BUDGET_MS, STEP_MAX_MS } from './budgets';

/** Aborts a step that ran out of its budget; the abort reason, so callers can tell it from other aborts. */
export const STEP_TIMEOUT = new Error('step_timeout');

/** A server step's budget: a minute without server progress, five at most; expiry aborts its signal with STEP_TIMEOUT. */
export class StepBudget {
  private readonly abort = new AbortController();
  private readonly started = Date.now();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.extend();
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  /** The server reported progress: the minute starts over (never past the five). */
  extend(): void {
    if (this.abort.signal.aborted) return;
    if (this.timer) clearTimeout(this.timer);
    const left = Math.min(STEP_BUDGET_MS, this.started + STEP_MAX_MS - Date.now());
    this.timer = setTimeout(() => this.abort.abort(STEP_TIMEOUT), Math.max(0, left));
  }

  /** The step ended: no expiry. */
  end(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The step is replaced or the player stops: its requests are aborted too. */
  cancel(): void {
    this.end();
    this.abort.abort();
  }
}
