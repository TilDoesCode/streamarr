/** While offline: reads the network again on a timer, so the return is seen without waiting for an event (S6v). */
export class NetworkWatch {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly refresh: (() => Promise<boolean>) | undefined,
    private readonly online: () => void,
    private readonly everyMs: number
  ) {}

  /** Runs while `offline`; stops otherwise. */
  set(offline: boolean): void {
    this.stop();
    if (!offline || !this.refresh) return;
    const refresh = this.refresh;
    this.timer = setInterval(() => {
      void refresh()
        .then((online) => online && this.online())
        .catch(() => undefined);
    }, this.everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
