import { CLOCK_FROZEN_MS } from '@/player/health/watchdog';

import { END_MARGIN_SECONDS, HINT_MS, STALL_LADDER_MS } from './budgets';
import type { ErrorCategory } from './classify';

/** The player's state at a status tick, read at one moment. */
export type TickInput = {
  now: number;
  /** No step waits, online, playing. */
  ready: boolean;
  /** Ready, not paused and no step running: a running step has its own budget (review B1). */
  calm: boolean;
  seeking: boolean;
  seekAt: number;
  stallSince: number;
  loadingSince: number;
  pictured: boolean;
  startBudget: number;
  /** A transcode loads the current source: its conversion speed decides, not the picture. */
  converting: boolean;
  /** When the buffer of this source last grew (0 = never). */
  progressAt: number;
  nearEnd: boolean;
  offline: boolean;
};

export type TickRule =
  'pictureTimeout' | 'conversionTimeout' | 'finish' | 'stallLadder' | 'offline' | null;

/** A conversion that keeps delivering but too slowly to start waits at most this long (S9b C08). */
export const SLOW_START_MAX_MS = 90_000;

/** No picture past the start budget: a transcode whose buffer still grows is slow, not broken (S9b C08). */
export function slowStart(
  input: Pick<
    TickInput,
    'now' | 'loadingSince' | 'startBudget' | 'converting' | 'progressAt' | 'pictured'
  >
): 'slow' | 'tooSlow' | null {
  const { now, loadingSince, startBudget } = input;
  if (!input.converting || !input.progressAt || !loadingSince || input.pictured) return null;
  if (now - loadingSince < startBudget) return null;
  return now - input.progressAt < startBudget && now - loadingSince < SLOW_START_MAX_MS
    ? 'slow'
    : 'tooSlow';
}

/** Once a second: a seek whose clock never arrives stalls (D29), then at most one budget rule fires. */
export function tickRules(input: TickInput): { seekStall: boolean; rule: TickRule } {
  const { now, ready, calm, stallSince } = input;
  const seekStall = calm && input.seeking && !stallSince && now - input.seekAt >= CLOCK_FROZEN_MS;
  // The start budget runs while paused too: a source that never loads is not waiting for the viewer.
  const unloaded =
    ready &&
    !!input.loadingSince &&
    !input.pictured &&
    now - input.loadingSince >= input.startBudget;
  if (unloaded) {
    const slow = slowStart(input);
    if (slow === 'slow') return { seekStall, rule: null };
    return { seekStall, rule: slow ? 'conversionTimeout' : 'pictureTimeout' };
  }
  if (calm && stallSince && input.nearEnd && now - stallSince >= HINT_MS)
    return { seekStall, rule: 'finish' };
  if (calm && stallSince && now - stallSince >= STALL_LADDER_MS)
    return { seekStall, rule: 'stallLadder' };
  return { seekStall, rule: input.offline ? 'offline' : null };
}

/** A playlist without ENDLIST reads as live (Safari) or as cut short (hls.js): the server's length is the title's (S9a D10, S9a2 C12). */
export function titleLength(engine: number, server: number): number {
  if (server > 0 && !(engine > server - END_MARGIN_SECONDS)) return server;
  return Number.isFinite(engine) && engine > 0 ? engine : server;
}

/** Failures a fresh viewer switch answers by going back to the previous choice (S9a2 B13b). */
const SWITCH_BACK: ReadonlySet<ErrorCategory> = new Set(['T5', 'T6', 'T7']);

/** A viewer's switch whose new source fails before its first picture goes back instead of down the ladder. */
export function switchesBack(pictured: boolean, category: ErrorCategory): boolean {
  return !pictured && SWITCH_BACK.has(category);
}
