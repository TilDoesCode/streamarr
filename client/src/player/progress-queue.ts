import { createMMKV } from 'react-native-mmkv';

import { unwrap, type ApiClient } from '@/api/client';
import { isAppError } from '@/api/errors';
import type { components } from '@/api/schema';

export type ProgressReport = components['schemas']['WatchProgressRequest'];
type Entry = { accountId: string; report: ProgressReport; at: number };

const storage = createMMKV({ id: 'streamarr.progress-queue' });
const KEY = 'pending';
const MAX_ENTRIES = 50;
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

function load(): Entry[] {
  try {
    return JSON.parse(storage.getString(KEY) ?? '[]') as Entry[];
  } catch {
    return [];
  }
}

function save(entries: Entry[]): void {
  storage.set(KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
}

/** Server rejections (4xx) are final; transport failures, 429 and 5xx are retried later. */
function retriable(error: unknown): boolean {
  return !isAppError(error) || error.isTransient;
}

async function send(client: ApiClient, report: ProgressReport): Promise<void> {
  await unwrap(client.POST('/api/v1/viewer/watch/progress', { body: report }));
}

/** Progress reports with an offline queue: failed sends are kept (per account, persisted) and retried with backoff. */
export class ProgressQueue {
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly accountId: string,
    private readonly client: ApiClient
  ) {}

  get pending(): number {
    return load().filter((entry) => entry.accountId === this.accountId).length;
  }

  async report(report: ProgressReport): Promise<void> {
    if (this.pending) {
      this.enqueue(report);
      void this.flush();
      return;
    }
    try {
      await send(this.client, report);
    } catch (error) {
      if (retriable(error)) this.enqueue(report);
    }
  }

  private enqueue(report: ProgressReport): void {
    const entries = load();
    const last = entries.at(-1);
    // A newer heartbeat of the same playback replaces the queued one; start/stop events stay.
    if (
      last?.accountId === this.accountId &&
      last.report.event === 'progress' &&
      report.event === 'progress' &&
      last.report.playbackId === report.playbackId
    )
      entries.pop();
    entries.push({ accountId: this.accountId, report, at: Date.now() });
    save(entries);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  /** Sends the backlog in order; concurrent calls share one run so nothing is sent twice. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const entries = load();
      const next = entries.find((entry) => entry.accountId === this.accountId);
      if (!next) {
        this.attempt = 0;
        return;
      }
      try {
        await send(this.client, next.report);
      } catch (error) {
        if (retriable(error)) {
          this.attempt += 1;
          this.schedule();
          return;
        }
      }
      const current = load();
      const at = current.findIndex(
        (entry) => entry.accountId === this.accountId && entry.at === next.at
      );
      if (at >= 0) current.splice(at, 1);
      save(current);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
