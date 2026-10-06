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
  /** The server repairs this release: its ETA in ms (null = unknown); undefined = no repair (C04). */
  repairEtaMs?: number | null;
  /** The server gave up the repair of this release while it stalls (C04). */
  repairAborted?: boolean;
  /** Short stalls keep coming (3 in 2 min, or 2 rebuffers > 4 s on a transcode): the stall ladder at once (C03, C08). */
  repeated?: boolean;
};

export type TickRule =
  | 'pictureTimeout'
  | 'conversionTimeout'
  | 'finish'
  | 'stallLadder'
  | 'repairAborted'
  | 'offline'
  | null;

/** A stall while the server repairs waits for it this long at most (its ETA, 15–90 s) (C04). */
export const REPAIR_WAIT_MAX_MS = 90_000;

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
  if (calm && stallSince && input.repairAborted) return { seekStall, rule: 'repairAborted' };
  // The server mends the release: its repair, not the network, holds the picture (C04).
  if (calm && stallSince && input.repairEtaMs !== undefined) {
    const wait = Math.min(
      REPAIR_WAIT_MAX_MS,
      Math.max(STALL_LADDER_MS, input.repairEtaMs ?? Infinity)
    );
    return { seekStall, rule: now - stallSince >= wait ? 'stallLadder' : null };
  }
  if (calm && stallSince && (input.repeated || now - stallSince >= STALL_LADDER_MS))
    return { seekStall, rule: 'stallLadder' };
  return { seekStall, rule: input.offline ? 'offline' : null };
}

/** Beyond this many times the server's length an engine length is a guess (VLC from the bytes of a cut file), not longer media. */
const GUESSED_LENGTH = 2;

/** The server's length is the title's when the engine reads it as live, cut short, or guesses it (S9a D10, C12, S9c VLC). */
export function titleLength(engine: number, server: number, guessed = false): number {
  const close = Math.abs(engine - server) <= END_MARGIN_SECONDS;
  if (server > 0 && guessed && !close) return server;
  if (server > 0 && engine > server * GUESSED_LENGTH) return server;
  if (server > 0 && !(engine > server - END_MARGIN_SECONDS)) return server;
  return Number.isFinite(engine) && engine > 0 ? engine : server;
}

/** Failures a fresh viewer switch answers by going back to the previous choice (S9a2 B13b). */
const SWITCH_BACK: ReadonlySet<ErrorCategory> = new Set(['T5', 'T6', 'T7']);

/** A viewer's switch whose new source fails before its first picture goes back instead of down the ladder. */
export function switchesBack(pictured: boolean, category: ErrorCategory): boolean {
  return !pictured && SWITCH_BACK.has(category);
}

const QUALITY_STEPS = [2160, 1080, 720, 480];

/** One quality step below what plays now (and below the viewer's own cap); null at the bottom. */
export function lowerHeightOf(
  playing: number,
  preferences: { maxHeight?: number | null }
): number | null {
  const current = Math.min(playing, preferences.maxHeight ?? Infinity);
  return QUALITY_STEPS.find((height) => height < current) ?? null;
}

/** Three stalls in two minutes, or two rebuffers over 4 s on a transcode, are one slow source (state matrix § 2 b.3). */
export const REPEAT_WINDOW_MS = 120_000;
const REPEAT_STALLS = 3;
const LONG_REBUFFER_MS = 4_000;
const LONG_REBUFFERS = 2;

/** Stall starts and long rebuffers of one playback; a quiet 2 min forgets them, a new source or a step clears them. */
export class StallHistory {
  private starts: number[] = [];
  private long: number[] = [];

  started(now: number): void {
    this.starts = [...this.recent(this.starts, now), now];
  }

  ended(now: number, since: number): void {
    if (now - since > LONG_REBUFFER_MS) this.long = [...this.recent(this.long, now), now];
  }

  /** The current stall makes it one too many; `fast` = measured throughput well above the bitrate (not the network). */
  repeated(now: number, stallSince: number, converting: boolean, fast: boolean): boolean {
    if (!stallSince || fast) return false;
    if (this.recent(this.starts, now).length >= REPEAT_STALLS) return true;
    const longNow = now - stallSince > LONG_REBUFFER_MS ? 1 : 0;
    return converting && this.recent(this.long, now).length + longNow >= LONG_REBUFFERS;
  }

  clear(): void {
    this.starts = [];
    this.long = [];
  }

  private recent(list: number[], now: number): number[] {
    return list.filter((at) => now - at < REPEAT_WINDOW_MS);
  }
}

/** Measured throughput well above the bitrate: stalls are not the network's. */
export function throughputOk(
  bandwidthBps: number | undefined,
  bitrateKbps: number | null | undefined
): boolean {
  return !!bandwidthBps && !!bitrateKbps && bandwidthBps >= 1.2 * bitrateKbps * 1000;
}
