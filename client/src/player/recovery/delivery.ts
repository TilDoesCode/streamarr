import { classify, type Classified } from './classify';

/** An own request that answered within this, after the break began: the delivery broke, not the connection (S6t). */
export const DELIVERY_WINDOW_MS = 30_000;
/** A server-reported delivery issue older than this no longer explains a failure. */
export const ISSUE_RECENT_MS = 60_000;

/** A network change (Wi-Fi to cellular) this close to a break makes it the connection's, not the delivery's. */
export const HANDOVER_MS = 15_000;

/** B15 `PlaybackDeliveryIssueDto`: what the server answered with an error while it delivered this playback. */
export type DeliveryIssue = {
  kind: 'audioRendition' | 'subtitleRendition' | 'segment';
  /** The master's `audio/{id}` (audioRendition). */
  renditionId?: string;
  /** The server subtitle stream (`subtitles/{index}`) of a subtitleRendition. */
  subtitleStreamIndex?: number;
  code: string;
  /** HTTP status of the answer (500 when it broke off after it started). */
  status?: number;
  /** Epoch milliseconds on the server's clock. */
  at: number;
  /** How old the issue was when the server answered (its own clock), if the answer carried the server time. */
  ageMs?: number;
  /** When it happened on this device's clock: set once, when the issue is first seen (stampIssues). */
  receivedAt?: number;
};

const KINDS = new Set(['audioRendition', 'subtitleRendition', 'segment']);
/** An ISO time must name its zone: a local-time reading would shift the issue by the zone offset. */
const ZONED = /(?:Z|[+-]\d\d:?\d\d)$/i;

/** The optional `deliveryIssues` of a progress answer; anything malformed is ignored (works before the server ships it). */
export function deliveryIssuesOf(answer: unknown, serverNow?: number): DeliveryIssue[] {
  const raw = (answer as { deliveryIssues?: unknown } | null | undefined)?.deliveryIssues;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): DeliveryIssue[] => {
    const entry = item as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') return [];
    const { kind, code, renditionId, subtitleStreamIndex, status } = entry;
    const text = typeof entry.at === 'string' ? entry.at.trim() : null;
    if (text !== null && !ZONED.test(text)) return [];
    const at = text !== null ? Date.parse(text) : entry.at;
    if (typeof kind !== 'string' || !KINDS.has(kind) || typeof code !== 'string') return [];
    if (typeof at !== 'number' || !Number.isFinite(at)) return [];
    const index = typeof subtitleStreamIndex === 'number' ? subtitleStreamIndex : undefined;
    // A subtitle issue names its stream by index (B15): without one it concerns no subtitle we show.
    if (kind === 'subtitleRendition' && index === undefined) return [];
    return [
      {
        kind: kind as DeliveryIssue['kind'],
        code,
        at,
        ...(typeof renditionId === 'string' ? { renditionId } : {}),
        ...(index !== undefined ? { subtitleStreamIndex: index } : {}),
        ...(typeof status === 'number' ? { status } : {}),
        ...(serverNow !== undefined ? { ageMs: Math.max(0, serverNow - at) } : {}),
      },
    ];
  });
}

const issueKey = (issue: DeliveryIssue) =>
  `${issue.kind}|${issue.renditionId ?? ''}|${issue.subtitleStreamIndex ?? ''}|${issue.code}|${issue.at}`;

/** Gives each issue a time on this device's clock: its server age where known, else the first answer that named it. */
export function stampIssues(
  previous: readonly DeliveryIssue[],
  next: readonly DeliveryIssue[],
  now: number
): DeliveryIssue[] {
  const seen = new Map(previous.map((issue) => [issueKey(issue), issue.receivedAt]));
  return next.map((issue) => ({
    ...issue,
    receivedAt: seen.get(issueKey(issue)) ?? now - (issue.ageMs ?? 0),
  }));
}

/** The newest issue still recent enough to explain a failure now (device clock, never the server's). */
export function recentIssue(issues: readonly DeliveryIssue[], now: number): DeliveryIssue | null {
  const fresh = issues.filter(
    (issue) => issue.receivedAt !== undefined && now - issue.receivedAt < ISSUE_RECENT_MS
  );
  return fresh.sort((a, b) => b.receivedAt! - a.receivedAt!)[0] ?? null;
}

/** What a server-reported issue makes of a media failure; subtitles are the subtitle path's, not the ladder's. */
export function issueFailure(issue: DeliveryIssue): Classified | null {
  if (issue.kind === 'audioRendition') return { category: 'T7', code: 'audio_rendition_failed' };
  if (issue.kind === 'segment') {
    const failure = classify({ kind: 'api', code: issue.code, status: issue.status });
    return failure.category === 'T11' ? { category: 'T6', code: 'delivery_interrupted' } : failure;
  }
  return null;
}

/** The failures a server issue may refine: stalls and delivery breaks only; anything else, now or future, stays itself (S4q R4). */
const REFINABLE = new Set([
  'playback_stalled',
  'seek_stalled',
  'segment_timeout',
  'segment_unavailable',
  'server_error',
  'delivery_interrupted',
  'stream_interrupted',
  'network_unreachable',
]);
/** An online connection failure that, with own requests answering, is the stream's delivery breaking (S4m). */
const BREAKS = new Set(['stream_interrupted', 'network_unreachable', 'timeout']);

/** A broken media request while online and the app's own requests answer: the stream's delivery, never "connection lost". */
export function deliveryFailure(
  failure: Classified,
  context: {
    online: boolean;
    /** When the newest own request that succeeded was SENT (an answer already in flight at the break proves nothing). */
    serverOkAt: number;
    /** When the media requests began to break (a one-shot error: now, so only a later request counts). */
    brokeAt: number;
    /** When the device last changed its network (Wi-Fi to cellular); 0 = never. */
    networkChangedAt?: number;
    now: number;
    issue: DeliveryIssue | null;
  }
): Classified {
  const { category, code } = failure;
  const connectionOnline = category === 'T1' && context.online && BREAKS.has(code);
  // A server report only refines a stall or a delivery break: never offline, TLS or a real decoder failure (S4n, S4q).
  const refinable = REFINABLE.has(code) && (category !== 'T1' || context.online);
  const reported = context.issue && refinable ? issueFailure(context.issue) : null;
  if (reported) return reported;
  if (!connectionOnline) return failure;
  const handover =
    !!context.networkChangedAt && context.networkChangedAt >= context.brokeAt - HANDOVER_MS;
  const answering =
    context.serverOkAt > context.brokeAt && context.now - context.serverOkAt < DELIVERY_WINDOW_MS;
  if (handover || !answering) return failure;
  return { category: 'T6', code: 'delivery_interrupted', detail: failure.detail };
}

/** Issues of the playing playback that concern what plays now: the failing rendition only (S4n, review R5). */
export function issuesFor(
  issues: readonly DeliveryIssue[],
  now: { current: boolean; audioRendition: string | null; subtitleIndex: number | null }
): DeliveryIssue[] {
  if (!now.current) return [];
  return issues.filter((issue) => {
    if (issue.kind === 'subtitleRendition') return issue.subtitleStreamIndex === now.subtitleIndex;
    if (!issue.renditionId) return true;
    if (issue.kind === 'audioRendition') return issue.renditionId === now.audioRendition;
    return true;
  });
}

/** What the player knows of the stream's delivery: own answers, the start of a media break, the server's issues. */
export class DeliveryState {
  /** When the last own request that answered was sent (S4n: an answer in flight at a break proves nothing). */
  private serverOkAt = 0;
  /** When the current run of status-less media retries began (AVPlayer -1005). */
  private brokeAt = 0;
  private issues: DeliveryIssue[] = [];
  /** The playback the issues were reported for: a new start of another playback forgets them. */
  private issuesOf: string | null = null;

  /** A progress answer; issues are kept for the playing playback only (S4n, C7). */
  answered(
    sentAt: number,
    reportFor: string | null | undefined,
    playing: string | null,
    issues: DeliveryIssue[]
  ): boolean {
    this.serverOkAt = Math.max(this.serverOkAt, sentAt);
    if (!playing || reportFor !== playing) return false;
    this.issues = stampIssues(this.issuesOf === playing ? this.issues : [], issues, Date.now());
    this.issuesOf = playing;
    return true;
  }

  /** A status-less retry that is not part of a running break starts one. */
  retried(at: number, status: number | undefined, audio: boolean, breaking: boolean): void {
    if (!status && !audio && !breaking) this.brokeAt = at;
  }

  /** Issues that concern what plays now: this playback, the failing rendition only (S4n, review R5). */
  relevant(now: {
    playbackId: string | null;
    audioRendition: string | null;
    subtitleIndex: number | null;
  }) {
    return issuesFor(this.issues, { ...now, current: this.issuesOf === now.playbackId });
  }

  /** The failure as the delivery explains it (S4m, S4n). */
  refine(
    failure: Classified,
    context: {
      online: boolean;
      breaking: boolean;
      networkChangedAt: number;
      issue: DeliveryIssue | null;
    },
    now = Date.now()
  ): Classified {
    return deliveryFailure(failure, {
      online: context.online,
      serverOkAt: this.serverOkAt,
      brokeAt: context.breaking ? this.brokeAt : now,
      now,
      networkChangedAt: context.networkChangedAt,
      issue: context.issue,
    });
  }
}
