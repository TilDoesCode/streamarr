import { INCIDENT_RESET_MS, SUBTITLE_RETRIES, SUBTITLE_RETRY_MS } from '@/player/recovery/budgets';

/** What the retry needs from the player. */
export type SubtitleRetryHost = {
  /** The viewer's subtitle now (server index); null when none is shown. */
  current(): number | null;
  release(): string | null;
  /** Shows the failed subtitles again; false when the engine has no track for them. */
  show(index: number): boolean;
};

type Entry = {
  index: number;
  release: string | null;
  failures: number;
  at: number;
  retrying: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

/** Failed subtitles (C22, C23): off, one retry a minute later; a failure after a healthy stretch starts over (review B5). */
export class SubtitleRetry {
  private entry: Entry | null = null;

  constructor(private readonly host: SubtitleRetryHost) {}

  /** The shown subtitles failed; null when none were shown. `retryLater` says whether they come back on their own. */
  fail(now = Date.now()): { index: number; retryLater: boolean } | null {
    const entry = this.entry;
    // While they are off, more failures of the same subtitles find nothing shown and change nothing.
    const index = entry?.retrying ? entry.index : this.host.current();
    if (index === null) return null;
    const recent = !!entry && entry.index === index && now - entry.at < INCIDENT_RESET_MS;
    const failures = (recent ? entry.failures : 0) + 1;
    this.clear();
    const retryLater = failures <= SUBTITLE_RETRIES;
    const timer = retryLater ? setTimeout(() => this.retry(), SUBTITLE_RETRY_MS) : null;
    this.entry = { index, release: this.host.release(), failures, at: now, retrying: false, timer };
    return { index, retryLater };
  }

  private retry(): void {
    const entry = this.entry;
    if (!entry) return;
    entry.timer = null;
    // The viewer chose other subtitles meanwhile (theirs win), or another release has other indexes.
    if (this.host.current() !== null || this.host.release() !== entry.release) return this.clear();
    if (!this.host.show(entry.index)) return this.clear();
    entry.retrying = true;
  }

  clear(): void {
    if (this.entry?.timer) clearTimeout(this.entry.timer);
    this.entry = null;
  }
}
