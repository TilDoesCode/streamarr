import { AUTO_RETRIES, AUTO_RETRY_WINDOW_MS, ONLINE_SETTLE_MS } from './budgets';

/** A "connection lost" card retries once the network stayed back for a moment, a few times per 10 minutes (A25). */
export class AutoRetry {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private recent: number[] = [];

  /** Back online: after the settle time, `retry` runs if `wanted` still holds and the window has room. */
  schedule(wanted: () => boolean, retry: () => void): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = Date.now();
      this.recent = this.recent.filter((at) => now - at < AUTO_RETRY_WINDOW_MS);
      if (!wanted() || this.recent.length >= AUTO_RETRIES) return;
      this.recent.push(now);
      retry();
    }, ONLINE_SETTLE_MS);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
