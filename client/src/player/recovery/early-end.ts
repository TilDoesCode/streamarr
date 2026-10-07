import type { ApiClient } from '@/api/client';
import { toAppError } from '@/api/errors';
import { clock } from '@/player/format';
import { getPlayback, TICKS_PER_SECOND, type Playback } from '@/player/playback-api';

import { classify, type Classified } from './classify';
import type { FailureExtra } from './runner';

/** Two early ends further apart than this are a connection that keeps breaking, not a short file (D26). */
const SAME_END_S = 3;

/** An end before the duration that is the network's: offline, or ends at different places (VLC reports a drop as the end). */
export function transportEnd(
  offline: boolean,
  endAt: number,
  firstEnd?: number
): Classified | null {
  if (offline) return { category: 'T1', code: 'network_unreachable' };
  if (firstEnd !== undefined && Math.abs(endAt - firstEnd) > SAME_END_S)
    return { category: 'T1', code: 'stream_interrupted' };
  return null;
}

/** A stall or a black reload at the place a short playlist ended: the same end again, never damaged data (V2 C12). */
export function endsAgain(
  failure: Classified,
  playlistEnd: number | undefined,
  position: number
): boolean {
  if (playlistEnd === undefined || Math.abs(position - playlistEnd) > SAME_END_S) return false;
  return ['playback_stalled', 'seek_stalled', 'picture_timeout'].includes(failure.code);
}

/** The file is shorter than the server's length: the failure and its "ends at …" line; null when it is the real end. */
export function shortFile(
  endAt: number,
  length: number
): { failure: Classified; extra: FailureExtra } | null {
  if (endAt >= length - SAME_END_S) return null;
  return {
    failure: { category: 'T8', code: 'end_of_stream' },
    extra: {
      position: endAt,
      hint: { key: 'endedEarly', params: { time: clock(endAt), missing: clock(length - endAt) } },
    },
  };
}

/** What an engine "ended" means: an empty file (C31), the end, an early end to confirm (D26), or nothing yet. */
export function engineEnd(input: {
  position: number;
  /** The title's length (the server's wins over a cut playlist, S9b C12). */
  duration: number;
  /** What the engine itself loaded: under a second is an empty file. */
  engineDuration: number;
  loadPosition: number;
  /** No picture for EMPTY_END_MS since the load. */
  blank: boolean;
  pictured: boolean;
  startFloor: number;
  /** Where the last early end of this incident was. */
  firstEnd?: number;
}):
  { kind: 'empty' } | { kind: 'end' } | { kind: 'early'; endAt: number; firstEnd?: number } | null {
  const { position, duration, loadPosition, startFloor } = input;
  const media = input.engineDuration;
  // A file with no or under a second of media: nothing to watch, so it is explained, never "ended".
  if (loadPosition < 1 && ((media > 0 && media < 1) || input.blank)) return { kind: 'empty' };
  if (!duration) return null;
  if (position >= duration - 3) return { kind: 'end' };
  // A reloaded short file often ends again before any time event: its position is the one it was loaded at.
  if (input.firstEnd !== undefined)
    return { kind: 'early', endAt: startFloor ? loadPosition : position, firstEnd: input.firstEnd };
  // expo-video reports playToEnd while a new source loads; a source that played and stops short ended early.
  if (!input.pictured || startFloor) return null;
  return { kind: 'early', endAt: position };
}

/** The title's length as the server knows it now; a 404/410 means the playback is gone (an early end that restarts). */
export async function serverLength(
  client: ApiClient,
  playback: Playback | null,
  signal: AbortSignal
): Promise<{ length: number } | { lost: Classified }> {
  let confirmed = playback;
  if (playback?.playbackId) {
    try {
      confirmed = await getPlayback(client, playback.playbackId, signal);
    } catch (error) {
      const appError = toAppError(error);
      if (appError.status === 404 || appError.status === 410)
        return { lost: classify({ kind: 'api', code: appError.code, status: appError.status }) };
    }
  }
  return { length: (confirmed?.mediaInfo?.durationTicks ?? 0) / TICKS_PER_SECOND };
}

/** Asks the server about a playback: gone (404/410) restarts, signed out meanwhile is the Sign in card (A03, A09). */
export async function lostOnServer(
  client: ApiClient,
  playbackId: string,
  signal: AbortSignal
): Promise<{ failure: Classified; extra: FailureExtra } | null> {
  try {
    await getPlayback(client, playbackId, signal);
    return null;
  } catch (error) {
    const appError = toAppError(error);
    const failure = classify({ kind: 'api', code: appError.code, status: appError.status });
    const gone = appError.status === 404 || appError.status === 410;
    if (!gone && failure.category !== 'T3') return null;
    return { failure, extra: { params: appError.params, status: appError.status } };
  }
}
