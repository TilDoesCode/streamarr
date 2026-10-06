import { SUBTITLE_RETRIES, SUBTITLE_RETRY_MS } from '@/player/recovery/budgets';

/** What the retry needs from the player. */
export type SubtitleRetryHost = {
  /** The viewer's subtitle now (server index); null when none is shown. */
  current(): number | null;
  release(): string | null;
  /** Shows the failed subtitles again; false when the engine has no track for them. */
  show(index: number): boolean;
  /** Since when playback runs healthy (picture, no stall, no step); 0 = not healthy now. */
  healthySince?(): number;
};

type Entry = {
  index: number;
  release: string | null;
  retrying: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

/** Failed subtitles (C22, C23): off, back after a healthy minute; a second failure in this playback keeps them off (S4p R1). */
export class SubtitleRetry {
  private entry: Entry | null = null;
  /** Failures per release and track in this playback (a stall drop counts too: a track that blocks AVPlayer never loops). */
  private readonly failures = new Map<string, number>();

  constructor(private readonly host: SubtitleRetryHost) {}

  /** The shown subtitles failed; null when none were shown. `retryLater` says whether they come back on their own. */
  fail(shown = this.host.current()): { index: number; retryLater: boolean } | null {
    const entry = this.entry;
    // While they are off, more failures of the same subtitles find nothing shown and change nothing.
    const index = entry?.retrying ? entry.index : shown;
    if (index === null) return null;
    const release = this.host.release();
    const key = `${release}|${index}`;
    const failures = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, failures);
    this.clear();
    const retryLater = failures <= SUBTITLE_RETRIES;
    this.entry = { index, release, retrying: false, timer: null };
    if (retryLater) this.schedule(SUBTITLE_RETRY_MS);
    return { index, retryLater };
  }

  private schedule(ms: number): void {
    const entry = this.entry;
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.retry(), ms);
  }

  private retry(): void {
    const entry = this.entry;
    if (!entry) return;
    entry.timer = null;
    // The viewer chose other subtitles meanwhile (theirs win), or another release has other indexes.
    if (this.host.current() !== null || this.host.release() !== entry.release) return this.clear();
    // Back only after a whole healthy minute with them off: never straight into the next stall.
    const since = this.host.healthySince?.();
    if (since !== undefined) {
      const healthyFor = since ? Date.now() - since : 0;
      if (healthyFor < SUBTITLE_RETRY_MS) return this.schedule(SUBTITLE_RETRY_MS - healthyFor);
    }
    if (!this.host.show(entry.index)) return this.clear();
    entry.retrying = true;
  }

  clear(): void {
    if (this.entry?.timer) clearTimeout(this.entry.timer);
    this.entry = null;
  }
}
