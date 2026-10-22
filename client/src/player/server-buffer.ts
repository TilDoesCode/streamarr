import { useEffect, useState } from 'react';

import type { ApiClient } from '@/api/client';

import { getPlaybackBuffer, type PlaybackBuffer } from './playback-api';

/** A part of the file the server holds, as fractions [0..1] of the file (≈ the timeline). */
export type ServerRange = { start: number; end: number };

/** The server holds little news within a few seconds; one poll per interval while the controls show. */
export const SERVER_BUFFER_POLL_MS = 5_000;

const NONE: readonly ServerRange[] = [];

/** The answer's ranges, clamped and rounded to 0.1 % (finer steps would only re-render the player). */
export function serverRanges(buffer: PlaybackBuffer | null | undefined): readonly ServerRange[] {
  if (!buffer?.known) return NONE;
  if (buffer.complete) return [{ start: 0, end: 1 }];
  const round = (value: number | undefined) =>
    Math.round(Math.min(1, Math.max(0, value ?? 0)) * 1000) / 1000;
  return (buffer.ranges ?? [])
    .map((range) => ({ start: round(range.start), end: round(range.end) }))
    .filter((range) => range.end > range.start);
}

const sameRanges = (a: readonly ServerRange[], b: readonly ServerRange[]) =>
  a.length === b.length &&
  a.every((range, i) => range.start === b[i]?.start && range.end === b[i]?.end);

/** What the server holds of the playback's file; polled only while `active` (controls showing), never after it is complete. */
export function useServerBuffer(
  client: ApiClient | undefined,
  playbackId: string | null | undefined,
  active: boolean
): readonly ServerRange[] {
  const [state, setState] = useState<{ id: string | null; ranges: readonly ServerRange[] }>({
    id: null,
    ranges: NONE,
  });
  const id = playbackId ?? null;
  const ranges = state.id === id ? state.ranges : NONE;
  const complete = ranges.length === 1 && ranges[0]?.start === 0 && ranges[0]?.end === 1;

  useEffect(() => {
    if (!client || !id || !active || complete) return;
    const abort = new AbortController();
    const poll = () => {
      getPlaybackBuffer(client, id, abort.signal).then(
        (buffer) => {
          const next = serverRanges(buffer);
          setState((shown) =>
            shown.id === id && sameRanges(shown.ranges, next) ? shown : { id, ranges: next }
          );
        },
        // A failed poll keeps the last ranges; the next one may answer.
        () => undefined
      );
    };
    poll();
    const timer = setInterval(poll, SERVER_BUFFER_POLL_MS);
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, [client, id, active, complete]);

  return ranges;
}
