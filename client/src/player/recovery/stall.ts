import type { EngineKind } from '@/player/engines/types';

import { LOAD_RETRY_RECENT_MS, STATE_BUDGET_MS } from './budgets';
import { classify, type Classified } from './classify';

/** A media request the engine retries on its own: its HTTP status, whether only the audio fails, and when. */
export type LoadRetry = { status: number; audio: boolean; at: number };

/** A media request answered 404/410: the server no longer knows the playback (T2). */
export const lostPlayback = (status: number | undefined) => status === 404 || status === 410;

/** Why a long stall happened: the audio rendition, a server error the engine retries (5xx), else a slow source (T5). */
export function stallFailure(
  retry: LoadRetry | null,
  now: number,
  afterSeek: boolean,
  engine: EngineKind
): Classified {
  const recent = !!retry && now - retry.at < LOAD_RETRY_RECENT_MS;
  if (recent && retry.audio) return { category: 'T7', code: 'audio_rendition_failed' };
  // A native engine retrying without any status (AVPlayer -1005) lost the stream: connection or delivery, never "slow" (S6t).
  if (recent && retry.status === 0 && engine !== 'web')
    return { category: 'T1', code: 'stream_interrupted' };
  // A 5xx the engine retries is the server's; classify makes a 504 (its own wait budget) T5 too (review M20).
  // A 404/410 the server answered "alive" for (S4p): the playback's segments are gone, a bounded new start (T2).
  if (recent && (retry.status >= 500 || lostPlayback(retry.status)))
    return classify({
      kind: 'engine',
      engine,
      reason: 'networkError:fragLoadError',
      status: retry.status,
    });
  return { category: 'T5', code: afterSeek ? 'seek_stalled' : 'playback_stalled' };
}

/** Start states the client bounds with a card; a queue or a release search waits as long as the server lets it (review R1). */
const HARD_STATES = new Set(['planning', 'fallback', 'starting']);

/** A start state twice past its budget while online: the card with Retry and Other version (B16, E02). */
export function startStuck(state: string, since: number, now: number, offline: boolean): boolean {
  const budget = STATE_BUDGET_MS[state];
  return !offline && HARD_STATES.has(state) && !!budget && !!since && now - since >= 2 * budget;
}
