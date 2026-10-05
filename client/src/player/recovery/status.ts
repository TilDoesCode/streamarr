import { clock } from '@/player/format';
import type { HealthFinding } from '@/player/health/types';

import { decoderFormat, type SystemCause } from './classify';

import { HINT_ACTIONS, type HintAction, type HintParams } from './hints';
import type { Recovery, StatusHint } from './runner';

/** Status timeline (state-matrix § 2 c): spinner after 1 s of a stall, a hint after 4 s, the ladder after 15 s. */
export const SPINNER_MS = 1_000;
export const HINT_MS = 4_000;
/** A server start state longer than this explains itself (E02); repairing follows its own ETA. */
export const STATE_BUDGET_MS: Record<string, number> = {
  queued: 60_000,
  resolving: 60_000,
  fallback: 60_000,
  planning: 30_000,
  starting: 45_000,
};

/** What the status layer shows over the picture: spinner, one hint line and its actions. */
export type PlayerStatus = {
  spinner: boolean;
  hint: StatusHint | null;
  actions: readonly HintAction[];
};

/** Everything the status depends on, read from the controller at one moment. */
export type StatusInput = {
  now: number;
  phase: string;
  offline: boolean;
  recovery: Recovery | null;
  /** Since when the current source loads without a picture (0 = it showed one). */
  loadingSince: number;
  stallSince: number;
  seekAt: number;
  seeking: boolean;
  paused: boolean;
  systemPaused: boolean;
  /** Why the OS paused (null/undefined = somewhere outside the app). */
  systemCause?: SystemCause | null;
  /** AirPlay / external playback with the receiver's name when known. */
  external?: { device?: string } | null;
  autoplay: 'muted' | 'blocked' | null;
  health: HealthFinding | null;
  /** Where frames last moved (the frozen-picture hint says where it resumes). */
  frozenAt: number;
  /** The latest server start state and since when. */
  serverState: string;
  serverStateSince: number;
  method: string | null | undefined;
  bitrateKbps: number | null | undefined;
  bandwidthBps: number | undefined;
};

const NONE: PlayerStatus = { spinner: false, hint: null, actions: [] };

const show = (hint: StatusHint | null, spinner: boolean): PlayerStatus => ({
  spinner,
  hint,
  actions: hint ? HINT_ACTIONS[hint.key] : [],
});

/** Spinner, hint and actions over the picture (state-matrix § 2 c), derived from the controller's state. */
export function statusOf(input: StatusInput): PlayerStatus {
  const { now, phase, recovery } = input;
  if (phase === 'failed' || phase === 'stopped' || phase === 'resume') return NONE;
  const loading = !!input.loadingSince;
  if (input.offline) return show({ key: 'offline' }, loading || !!input.stallSince || !!recovery);
  if (recovery?.running)
    // A step runs: say what it does; the viewer's own actions wait until it is done.
    return { spinner: true, hint: runningHint(recovery), actions: [] };
  if (recovery) {
    const params: HintParams = {
      ...recovery.extra.params,
      seconds: Math.max(1, Math.ceil((recovery.due - now) / 1000)),
      time: clock(recovery.position),
    };
    const hint: StatusHint = { key: recovery.decision.hint ?? 'reloading', params };
    const actions = HINT_ACTIONS[hint.key].filter(
      (action) => action === 'tryNow' || action === 'back'
    );
    return { spinner: true, hint, actions };
  }
  if (phase === 'starting') {
    const budget = STATE_BUDGET_MS[input.serverState];
    const slow = !!budget && !!input.serverStateSince && now - input.serverStateSince >= budget;
    return show(slow ? { key: 'startSlow', params: { cause: 'preparing' } } : null, false);
  }
  if (phase !== 'playing') return NONE;
  if (input.systemPaused)
    return show(
      { key: 'pausedBySystem', params: { cause: input.systemCause ?? 'outside' } },
      false
    );
  if (input.autoplay === 'blocked') return show({ key: 'autoplayBlocked' }, false);
  if (loading) {
    const slow = now - input.loadingSince >= HINT_MS;
    return show(
      slow ? { key: 'startSlow', params: { cause: slowCause(input.method) } } : null,
      true
    );
  }
  if (input.stallSince && !input.paused) {
    const since = now - input.stallSince;
    const spinner = since >= SPINNER_MS || now - input.seekAt < 2 * SPINNER_MS;
    return show(since >= HINT_MS ? stallHint(input) : null, spinner);
  }
  // A seek that has not arrived after half a second shows the spinner (D29).
  if (input.seeking && !input.paused && now - input.seekAt >= SPINNER_MS / 2)
    return show(null, true);
  const health = input.health;
  if (health && !input.paused) {
    if (health.verdict === 'slideshow')
      return show(
        { key: 'deviceSlow', params: { percent: Number(health.evidence.percent) } },
        false
      );
    if (health.verdict === 'audio-silent') return show({ key: 'noAudio' }, false);
    if (health.verdict === 'picture-frozen')
      return show({ key: 'recovering', params: { time: clock(input.frozenAt) } }, true);
    return show({ key: 'noPicture' }, true);
  }
  if (input.autoplay === 'muted') return show({ key: 'mutedAutoplay' }, false);
  if (input.external)
    return show({ key: 'airplay', params: { device: input.external.device ?? 'AirPlay' } }, false);
  return NONE;
}

/** What a running step says (no countdown: it is happening now). */
export function runningHint(recovery: Recovery): StatusHint {
  const { step } = recovery.decision;
  const { category, code } = recovery.failure;
  const params = { time: clock(recovery.position) };
  if (step === 'Q') return { key: 'lowering', params };
  const format = /decode_error$/.test(code) ? decoderFormat(recovery.failure.detail) : null;
  if (step === 'S' && format) return { key: 'decoder', params: { ...params, format } };
  if (step === 'S') return { key: code === 'picture_black' ? 'noPicture' : 'steppingDown', params };
  if (step === 'V') return { key: 'switchingVersion', params };
  if (step === 'N' && category === 'T2') return { key: 'restarting', params };
  if (code === 'picture_frozen') return { key: 'recovering', params };
  return { key: 'reloading', params };
}

/** Why a stall lasts: measured throughput below the bitrate, a slow conversion, or just slow loading (C03, C08). */
function stallHint(input: StatusInput): StatusHint {
  const { bandwidthBps: bandwidth, bitrateKbps: bitrate } = input;
  if (bandwidth && bitrate && bandwidth < 1.2 * bitrate * 1000)
    return {
      key: 'slowNet',
      params: {
        measured: Math.round(bandwidth / 100_000) / 10,
        needed: Math.round(bitrate / 100) / 10,
      },
    };
  return { key: input.method === 'transcode' ? 'serverSlow' : 'buffering' };
}

function slowCause(method: string | null | undefined): string {
  return method === 'transcode'
    ? 'converting'
    : method === 'remux'
      ? 'preparing'
      : 'slowConnection';
}
