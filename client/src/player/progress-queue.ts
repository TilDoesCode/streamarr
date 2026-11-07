import { createMMKV } from 'react-native-mmkv';

import { unwrap, type ApiClient } from '@/api/client';
import { isAppError, type AppError } from '@/api/errors';
import type { components } from '@/api/schema';
import { serverNow, serverStamp, type ServerStamp } from '@/lib/server-clock';
import { TICKS_PER_SECOND } from '@/player/playback-api';
import { deliveryIssuesOf, type DeliveryIssue } from '@/player/recovery/delivery';

export type ProgressReport = components['schemas']['WatchProgressRequest'];
/** What the server says about the reported playback (B13): false = it no longer exists. */
export type ProgressAnswer = {
  report: ProgressReport;
  playbackAlive: boolean | null;
  /** B15 (optional): what the server saw fail while delivering (recovery/delivery.ts). */
  deliveryIssues?: DeliveryIssue[];
  /** When this request was sent: only a request sent after a media break proves the server answers (S4n). */
  sentAt?: number;
};
/** `id`: this entry only (a replacement in the same millisecond is another entry); `at` on `server`'s clock. */
type Entry = {
  accountId: string;
  report: ProgressReport;
  at: number;
  id?: string;
  server?: string;
  /** `at` is an estimate (no clock anchor of this boot); the API has no field for it, so it stays local. */
  estimated?: boolean;
};

let sequence = 0;
const entryId = (at: number) => `${at.toString(36)}-${(sequence += 1).toString(36)}`;

const storage = createMMKV({ id: 'streamarr.progress-queue' });
const KEY = 'pending';
/** Heartbeats of one playback collapse, so this holds weeks of offline viewing. */
const MAX_ENTRIES = 500;
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Queued reports wait this long for the server or a sign-in (the server clamps `occurredAt` to 30 days, DL). */
const MAX_AGE_MS = 30 * 24 * 3_600_000;

function load(): Entry[] {
  try {
    const entries = (JSON.parse(storage.getString(KEY) ?? '[]') as Entry[]).filter(
      (entry) => serverNow(entry.server) - entry.at < MAX_AGE_MS
    );
    if (entries.every((entry) => entry.id)) return entries;
    // Reports queued by an older version get their ids once, so a sent one can be removed.
    const withIds = entries.map((entry) =>
      entry.id ? entry : { ...entry, id: entryId(entry.at) }
    );
    save(withIds);
    return withIds;
  } catch {
    return [];
  }
}

function save(entries: Entry[]): void {
  storage.set(KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
}

/** Transport failures, 429 and 5xx are retried later; 401/403 wait for the next sign-in; other 4xx are final. */
function outcome(error: unknown): 'retry' | 'keep' | 'drop' {
  if (!isAppError(error) || error.isTransient) return 'retry';
  return error.status === 401 || error.status === 403 ? 'keep' : 'drop';
}

/** A queued report carries when it really happened (`occurredAt`), so late delivery never counts as now. */
function withOccurredAt(entry: Entry): ProgressReport {
  return {
    ...entry.report,
    occurredAt: entry.report.occurredAt ?? new Date(entry.at).toISOString(),
  };
}

function append(
  accountId: string,
  report: ProgressReport,
  stamp: ServerStamp,
  server: string | null
): void {
  const entries = load();
  const last = entries.at(-1);
  // A newer heartbeat of the same playback replaces the queued one; start/stop events stay.
  if (
    last?.accountId === accountId &&
    last.report.event === 'progress' &&
    report.event === 'progress' &&
    last.report.playbackId === report.playbackId
  )
    entries.pop();
  entries.push({
    accountId,
    report,
    at: stamp.at,
    id: entryId(stamp.at),
    ...(server ? { server } : {}),
    ...(stamp.estimated ? { estimated: true } : {}),
  });
  save(entries);
}

/** Queues a report without trying to send it (offline playback); `at` = when it happened on `server`'s clock. */
export function enqueueProgress(
  accountId: string,
  report: ProgressReport,
  at?: number,
  server: string | null = null
): void {
  const stamp = at === undefined ? serverStamp(server) : { at, estimated: false, uncertaintyMs: 0 };
  append(accountId, report, stamp, server);
}

/** Reports waiting for `accountId` (every account without one). */
export function pendingProgress(accountId?: string): number {
  return load().filter((entry) => !accountId || entry.accountId === accountId).length;
}

const answerListeners = new Map<string, Set<(answer: ProgressAnswer) => void>>();
const draining = new Map<string, Promise<DrainResult>>();
type DrainResult = 'done' | 'retry' | 'refused';

function notifyAnswer(accountId: string, answer: ProgressAnswer): void {
  answerListeners.get(accountId)?.forEach((listener) => listener(answer));
}

/** Sends `accountId`'s backlog in order; one run per account at a time (player and app-wide sync share it). */
export function drainProgress(
  accountId: string,
  client: ApiClient,
  onRefused?: (error: AppError) => void
): Promise<DrainResult> {
  let run = draining.get(accountId);
  if (!run) {
    run = drainAccount(accountId, client, onRefused).finally(() => draining.delete(accountId));
    draining.set(accountId, run);
  }
  return run;
}

async function drainAccount(
  accountId: string,
  client: ApiClient,
  onRefused?: (error: AppError) => void
): Promise<DrainResult> {
  for (;;) {
    const next = load().find((entry) => entry.accountId === accountId);
    if (!next) return 'done';
    try {
      notifyAnswer(accountId, await send(client, withOccurredAt(next)));
    } catch (error) {
      const result = outcome(error);
      if (result === 'keep') {
        if (isAppError(error)) onRefused?.(error);
        return 'refused';
      }
      if (result === 'retry') return 'retry';
    }
    const current = load();
    const at = current.findIndex((entry) => entry.id === next.id);
    if (at >= 0) current.splice(at, 1);
    save(current);
  }
}

/** App-wide sync (launch, reconnect, sign-in, timer): every signed-in account's backlog. */
export async function flushAllProgress(
  accounts: readonly { id: string; signedIn: boolean }[],
  clientFor: (accountId: string) => ApiClient
): Promise<void> {
  const known = new Set(accounts.map((account) => account.id));
  const entries = load();
  // Reports of a removed profile can never be sent.
  if (entries.some((entry) => !known.has(entry.accountId)))
    save(entries.filter((entry) => known.has(entry.accountId)));
  const waiting = new Set(load().map((entry) => entry.accountId));
  for (const account of accounts)
    if (account.signedIn && waiting.has(account.id))
      await drainProgress(account.id, clientFor(account.id)).catch(() => 'retry');
}

async function send(client: ApiClient, report: ProgressReport): Promise<ProgressAnswer> {
  const sentAt = Date.now();
  const call = client.POST('/api/v1/viewer/watch/progress', { body: report });
  const answer = await unwrap(call);
  const deliveryIssues = deliveryIssuesOf(answer, serverTimeOf((await call).response));
  return {
    report,
    playbackAlive: answer?.playbackAlive ?? null,
    ...(deliveryIssues.length ? { deliveryIssues } : {}),
    sentAt,
  };
}

/** The server's clock from the answer's `Date` header (issue ages are measured on it, never on this device's). */
export function serverTimeOf(
  response: { headers?: { get(name: string): string | null } } | undefined
) {
  const date = response?.headers?.get('Date');
  const at = date ? Date.parse(date) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

/** Progress reports with an offline queue: failed sends are kept (per account, persisted) and retried with backoff. */
export class ProgressQueue {
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;

  /** Every answer the server gave, also for queued reports sent later. */
  onAnswer: ((answer: ProgressAnswer) => void) | null = null;
  /** A report refused until the account signs in again (401/403): the player stops and says so. */
  onRefused: ((error: AppError) => void) | null = null;

  private readonly forward = (answer: ProgressAnswer) => this.onAnswer?.(answer);

  constructor(
    private readonly accountId: string,
    private readonly client: ApiClient,
    /** `serverKey` of the account's server: queued reports are stamped on its clock. */
    private readonly server: string | null = null
  ) {
    let listeners = answerListeners.get(accountId);
    if (!listeners) answerListeners.set(accountId, (listeners = new Set()));
    listeners.add(this.forward);
  }

  get pending(): number {
    return load().filter((entry) => entry.accountId === this.accountId).length;
  }

  /** `queueOnly`: offline playback, the report waits for the next sync with its real time. */
  async report(report: ProgressReport, { queueOnly = false } = {}): Promise<void> {
    if (queueOnly) {
      this.enqueue(report, false);
      return;
    }
    if (this.pending) {
      this.enqueue(report);
      void this.flush();
      return;
    }
    try {
      const answer = await send(this.client, report);
      this.onAnswer?.(answer);
    } catch (error) {
      const next = outcome(error);
      if (next !== 'drop') this.enqueue(report, next === 'retry');
      if (next === 'keep' && isAppError(error)) this.onRefused?.(error);
    }
  }

  private enqueue(report: ProgressReport, retry = true): void {
    append(this.accountId, report, serverStamp(this.server), this.server);
    if (retry) this.schedule();
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
    const result = await drainProgress(this.accountId, this.client, (error) =>
      this.onRefused?.(error)
    );
    if (result === 'done') this.attempt = 0;
    if (result === 'retry') {
      this.attempt += 1;
      this.schedule();
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    answerListeners.get(this.accountId)?.delete(this.forward);
  }
}

/** The report of `playback` at `position` seconds; null without a work. */
export function reportOf(
  event: ProgressReport['event'],
  playback: { workId?: string | null; playbackId?: string | null } | null,
  position: number,
  duration: number
): ProgressReport | null {
  if (!playback?.workId) return null;
  return {
    event,
    workId: playback.workId,
    playbackId: playback.playbackId,
    positionTicks: Math.round(position * TICKS_PER_SECOND),
    durationTicks: duration ? Math.round(duration * TICKS_PER_SECOND) : null,
  };
}
