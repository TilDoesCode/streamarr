import { Platform } from 'react-native';

import type { EngineState, PlayerEngine } from '@/player/engines/types';

/** An "alive" answer holds this long: 404 retries every 0.1–4 s never become a request storm (S4p). */
export const ALIVE_FRESH_MS = 10_000;

/** Asks the server whether a playback still exists: one request at a time, an "alive" answer reused for a while. */
export class GoneCheck {
  private pending: { id: string; answer: Promise<boolean> } | null = null;
  private alive: { id: string; at: number } | null = null;

  constructor(private readonly ask: (playbackId: string) => Promise<boolean>) {}

  async gone(playbackId: string): Promise<boolean> {
    if (this.alive?.id === playbackId && Date.now() - this.alive.at < ALIVE_FRESH_MS) return false;
    if (this.pending?.id !== playbackId) {
      const answer = this.ask(playbackId).finally(() => {
        if (this.pending?.answer === answer) this.pending = null;
      });
      this.pending = { id: playbackId, answer };
    }
    const alive = await this.pending.answer;
    if (alive) this.alive = { id: playbackId, at: Date.now() };
    return !alive;
  }
}

/** What the player sees at the moment a decision is due. */
export type PlayerSignals = {
  /** AVPlayer (expo-video on iOS/tvOS): subtitle segment errors carry no URI, a broken rendition stalls everything. */
  avplayer: boolean;
  state: EngineState;
  subtitlesShown: boolean;
  paused: boolean;
  pictured: boolean;
  stalled: boolean;
  /** A time event came within the last 2 s. */
  clockRuns: boolean;
};

/** A media 404/410 the engine retries, after the server answered: gone restarts, a subtitle segment drops the subtitles. */
export function lostRequest(
  gone: boolean,
  player: PlayerSignals
): 'restart' | 'subtitles' | 'ignore' {
  if (gone) return 'restart';
  // The server still has the playback: a URI-less 404 while picture and clock run with subtitles on is theirs (S6u).
  const running = player.state === 'playing' && player.clockRuns && !player.stalled;
  if (player.avplayer && player.subtitlesShown && player.pictured && running) return 'subtitles';
  // Anything else waits for the stall ladder (bounded new starts), never a restart per retry (S4p B3, B5).
  return 'ignore';
}

/** On AVPlayer a stall with subtitles on and nothing else explaining it: subtitles off is the first try (S4n). */
export function subtitleStalls(
  player: PlayerSignals,
  explained: { retrying: boolean; issue: boolean }
): boolean {
  // Offline never reaches here: the stall ladder only runs online.
  if (!player.avplayer || player.state !== 'buffering' || !player.subtitlesShown) return false;
  return !explained.retrying && !explained.issue;
}

/** A stall this old asks the server whether the playback still exists (S6u: a gone playback restarts first). */
export const STALL_PROBE_MS = 1_000;

/** What the watch needs from the player. */
export type LostWatchHost = {
  /** The playing playback's id; null when there is none. */
  playbackId(): string | null;
  /** Nothing may start now: closed, not playing, or a step pending or running. */
  busy(): boolean;
  signals(): PlayerSignals;
  /** The server lost the playback: a new start at the position. */
  restart(): void;
  /** The 404 was a subtitle segment: the subtitle path. */
  subtitles(): void;
};

/** Lost requests and long stalls ask the server first; its answer decides (S4o, S4p). */
export class LostWatch {
  private probed = false;

  constructor(
    private readonly host: LostWatchHost,
    private readonly check: GoneCheck
  ) {}

  /** A media 404/410 the engine retries: paused waits for play, else the server's answer decides. */
  async lostRequest(): Promise<void> {
    const id = this.host.playbackId();
    if (!id || this.host.signals().paused || this.host.busy()) return;
    const gone = await this.check.gone(id);
    if (this.host.playbackId() !== id || this.host.busy()) return;
    const decision = lostRequest(gone, this.host.signals());
    if (decision === 'restart') this.host.restart();
    else if (decision === 'subtitles') this.host.subtitles();
  }

  /** A new stall may ask once more. */
  stallStarted(): void {
    this.probed = false;
  }

  /** Each status tick: a stall older than STALL_PROBE_MS asks once, never offline or while a step runs. */
  stallTick(stallSince: number, now: number, offline: boolean): void {
    if (!stallSince || this.probed || now - stallSince < STALL_PROBE_MS) return;
    if (offline || this.host.busy()) return;
    this.probed = true;
    void this.probeStall();
  }

  private async probeStall(): Promise<void> {
    const id = this.host.playbackId();
    if (!id || !(await this.check.gone(id))) return;
    if (this.host.playbackId() !== id || this.host.busy()) return;
    this.host.restart();
  }
}

/** Time events within this keep the clock running (AVPlayer sends one about every 0.5 s while it plays). */
const CLOCK_RUNS_MS = 2_000;

/** The player's signals now, from its engine and its own state. */
export function signalsOf(
  engine: PlayerEngine | null,
  paused: boolean,
  pictured: boolean,
  stallSince: number,
  lastTimeAt: number
): PlayerSignals {
  const snapshot = engine?.getSnapshot();
  return {
    avplayer: engine?.kind === 'expo-video' && Platform.OS === 'ios',
    state: snapshot?.state ?? 'idle',
    subtitlesShown: !!snapshot?.tracks.subtitles.some((track) => track.selected),
    paused,
    pictured,
    stalled: !!stallSince,
    clockRuns: Date.now() - lastTimeAt < CLOCK_RUNS_MS,
  };
}
