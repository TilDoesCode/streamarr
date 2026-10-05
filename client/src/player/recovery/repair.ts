/** Repair states of `RepairStatusInfo.state` that mean the server is still mending the release (C04). */
const DONE = new Set(['ready', 'notNeeded', 'failed', 'cancelled', 'unknown']);

/** The server is repairing missing data of this release right now. */
export function isRepairing(state: string | null | undefined): boolean {
  return !!state && !DONE.has(state);
}
