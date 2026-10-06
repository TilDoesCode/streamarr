/** Repair states of `RepairStatusInfo.state` that mean the server is still mending the release (C04). */
const DONE = new Set(['none', 'ready', 'notNeeded', 'failed', 'cancelled', 'evicted', 'unknown']);
/** The server gave up mending the release (C04: same release once more, then another version). */
const ABORTED = new Set(['failed', 'cancelled', 'evicted']);

export const repairAborted = (state: string | null | undefined) => !!state && ABORTED.has(state);

/** The server is repairing missing data of this release right now. */
export function isRepairing(state: string | null | undefined): boolean {
  return !!state && !DONE.has(state);
}
