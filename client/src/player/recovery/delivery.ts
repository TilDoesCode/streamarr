import { classify, type Classified } from './classify';

/** An own request that answered within this, after the break began: the delivery broke, not the connection (S6t). */
export const DELIVERY_WINDOW_MS = 30_000;
/** A server-reported delivery issue older than this no longer explains a failure. */
export const ISSUE_RECENT_MS = 60_000;

/** B15 (server, in progress): what the server saw fail while it delivered this playback. */
export type DeliveryIssue = {
  kind: 'audioRendition' | 'subtitleRendition' | 'segment';
  renditionId?: string;
  code: string;
  /** Epoch milliseconds. */
  at: number;
};

const KINDS = new Set(['audioRendition', 'subtitleRendition', 'segment']);

/** The optional `deliveryIssues` of a progress answer; anything malformed is ignored (works before the server ships it). */
export function deliveryIssuesOf(answer: unknown): DeliveryIssue[] {
  const raw = (answer as { deliveryIssues?: unknown } | null | undefined)?.deliveryIssues;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): DeliveryIssue[] => {
    const entry = item as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') return [];
    const { kind, code, renditionId } = entry;
    const at = typeof entry.at === 'string' ? Date.parse(entry.at) : entry.at;
    if (typeof kind !== 'string' || !KINDS.has(kind) || typeof code !== 'string') return [];
    if (typeof at !== 'number' || !Number.isFinite(at)) return [];
    return [
      {
        kind: kind as DeliveryIssue['kind'],
        code,
        at,
        ...(typeof renditionId === 'string' ? { renditionId } : {}),
      },
    ];
  });
}

/** The newest issue still recent enough to explain a failure now. */
export function recentIssue(issues: readonly DeliveryIssue[], now: number): DeliveryIssue | null {
  const fresh = issues.filter((issue) => now - issue.at < ISSUE_RECENT_MS);
  return fresh.sort((a, b) => b.at - a.at)[0] ?? null;
}

/** What a server-reported issue makes of a media failure; subtitles are the subtitle path's, not the ladder's. */
export function issueFailure(issue: DeliveryIssue): Classified | null {
  if (issue.kind === 'audioRendition') return { category: 'T7', code: 'audio_rendition_failed' };
  if (issue.kind === 'segment') {
    const failure = classify({ kind: 'api', code: issue.code });
    return failure.category === 'T11' ? { category: 'T6', code: 'delivery_interrupted' } : failure;
  }
  return null;
}

/** A broken media request while online and the app's own requests answer: the stream's delivery, never "connection lost". */
export function deliveryFailure(
  failure: Classified,
  context: {
    online: boolean;
    serverOkAt: number;
    /** When the media requests began to break (a one-shot error: now, so only a later answer counts). */
    brokeAt: number;
    now: number;
    issue: DeliveryIssue | null;
  }
): Classified {
  const reported = context.issue ? issueFailure(context.issue) : null;
  if (reported && failure.category !== 'T2' && failure.category !== 'T3') return reported;
  if (failure.category !== 'T1' || !context.online) return failure;
  const answering =
    context.serverOkAt > context.brokeAt && context.now - context.serverOkAt < DELIVERY_WINDOW_MS;
  if (!answering || failure.code === 'tls_error' || failure.code === 'mixed_content')
    return failure;
  return { category: 'T6', code: 'delivery_interrupted', detail: failure.detail };
}
