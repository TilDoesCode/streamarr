/** Repair states of `RepairStatusInfo.state` that mean the server is still mending the release (C04). */
const DONE = new Set(['none', 'ready', 'notNeeded', 'failed', 'cancelled', 'evicted', 'unknown']);
/** The server gave up mending the release (C04: same release once more, then another version). */
const ABORTED = new Set(['failed', 'cancelled', 'evicted']);

export const repairAborted = (state: string | null | undefined) => !!state && ABORTED.has(state);

/** The server is repairing missing data of this release right now. */
export function isRepairing(state: string | null | undefined): boolean {
  return !!state && !DONE.has(state);
}

/** A stall polls the repair this often while it may wait for it (C04). */
export const REPAIR_POLL_MS = 5_000;
/** Polls in a row with the same state and progress: the answer is a stale snapshot, not a running repair. */
const STALE_POLLS = 2;

type RepairInfo =
  | {
      jobId?: string | null;
      state?: string | null;
      progressPercent?: number;
      processedBytes?: number;
    }
  | null
  | undefined;

/** Whether a stall may wait for the server's repair: only while polls see it move, and once per repair (C04). */
export class RepairHold {
  private last = '';
  private unchanged = 0;
  private readonly spent = new Set<string>();
  private holding: string | null = null;

  /** One poll's answer (or the start's snapshot): the same state and progress again counts toward stale. */
  seen(repair: RepairInfo): void {
    const key = repair
      ? `${repair.jobId}|${repair.state}|${repair.progressPercent}|${repair.processedBytes}`
      : '';
    this.unchanged = key === this.last ? this.unchanged + 1 : 0;
    this.last = key;
  }

  /** The current stall waits for this repair: it moves, and no earlier stall used its hold. */
  holds(repair: RepairInfo): boolean {
    if (!repair || !isRepairing(repair.state) || this.unchanged >= STALE_POLLS) return false;
    const id = repair.jobId ?? '';
    if (this.holding === id) return true;
    if (this.spent.has(id)) return false;
    this.spent.add(id);
    this.holding = id;
    return true;
  }

  /** A new stall: the hold of the last one is spent. */
  stallStarted(): void {
    this.holding = null;
  }
}
