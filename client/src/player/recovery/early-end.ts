import { clock } from '@/player/format';

import type { Classified } from './classify';
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
