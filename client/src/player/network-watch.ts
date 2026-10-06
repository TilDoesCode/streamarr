/** While offline: reads the network again on a timer, so the return is seen without waiting for an event (S6v). */
export class NetworkWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private offline = false;
  private background = false;

  constructor(
    private readonly refresh: (() => Promise<boolean>) | undefined,
    private readonly online: () => void,
    private readonly everyMs: number
  ) {}

  /** Runs while `offline` and the app is in the foreground; stops otherwise. */
  set(offline: boolean): void {
    this.offline = offline;
    this.run();
  }

  /** In the background the timer sleeps (no battery for an invisible hint); back in front one read at once (S4q R8). */
  setBackground(background: boolean): void {
    if (background === this.background) return;
    this.background = background;
    if (!background && this.offline) this.read();
    this.run();
  }

  stop(): void {
    this.offline = false;
    this.clear();
  }

  private run(): void {
    this.clear();
    if (!this.offline || this.background || !this.refresh) return;
    this.timer = setInterval(() => this.read(), this.everyMs);
  }

  private read(): void {
    void this.refresh?.()
      .then((online) => online && this.online())
      .catch(() => undefined);
  }

  private clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
