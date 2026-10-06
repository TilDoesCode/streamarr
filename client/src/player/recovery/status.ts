import { clock } from '@/player/format';
import type { HealthFinding } from '@/player/health/types';

import type { SystemCause } from '@/player/engines/types';

import { decoderFormat } from './classify';

import { HINT_ACTIONS, type HintAction, type HintParams } from './hints';
import type { Recovery, StatusHint } from './runner';

import { HINT_MS, SPINNER_MS, STATE_BUDGET_MS } from './budgets';

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
  /** The last video segment's server wait and transfer (web, C08). */
  fetch?: { waitMs: number; transferMs: number; bytes: number };
  /** Media seconds delivered per second waited over the last segments (web). */
  conversionRate?: number;
  /** A transcode past its start budget whose buffer still grows: slow, not broken (S9b C08). */
  slowConversion?: boolean;
  /** The server is repairing missing data of a direct-play release (C04). */
  repairing?: boolean;
  /** The engine is retrying a failed media request right now: its HTTP status, and whether only the audio fails. */
  serverRetry?: { status?: number; audio?: boolean } | null;
};

/** A first byte later than this is a slow link or server, not the engine (S9b START). */
const SLOW_FIRST_BYTE_MS = 2_000;
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
  // A silent restart behind a picture that still plays; once the old picture stalls, the restart is said (review B1).
  if (recovery?.extra.quiet) {
    if (loading) return show(null, true);
    if (!input.stallSince || input.paused) return NONE;
    const hint = now - input.stallSince >= HINT_MS ? runningHint(recovery) : null;
    return { spinner: true, hint, actions: [] };
  }
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
  // A start and a viewer's switch wait for the server alike: past its state budget the card explains (E02, S9a P8).
  if (phase === 'starting' || phase === 'switching') {
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
    if (input.slowConversion) return show({ key: 'serverSlow' }, true);
    const slow = now - input.loadingSince >= HINT_MS;
    return show(slow ? { key: 'startSlow', params: { cause: slowCause(input) } } : null, true);
  }
  if (input.stallSince && !input.paused && input.serverRetry) {
    // The engine already knows why it stalls: say so at once, and offer nothing that cannot help (S9a C10, D36).
    const { audio, status } = input.serverRetry;
    if (audio) return show({ key: 'noAudio' }, true);
    if (status !== undefined && status >= 400) return show({ key: 'serverRetrying' }, true);
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
  if (step === 'A') return { key: 'convertingAudio', params };
  if (step === 'N' && category === 'T2') return { key: 'restarting', params };
  if (step === 'R' && (code === 'audio_rendition_failed' || code === 'audio_silent'))
    return { key: 'noAudio', params };
  if (code === 'picture_frozen') return { key: 'recovering', params };
  if (code === 'delivery_interrupted') return { key: 'streamBreaks', params };
  return { key: 'reloading', params };
}

/** Why a stall lasts: measured throughput below the bitrate, a slow conversion, or just slow loading (C03, C08). */
function stallHint(input: StatusInput): StatusHint {
  const { bandwidthBps, bitrateKbps: bitrate, fetch } = input;
  if (input.repairing) return { key: 'serverRepairing' };
  // Only a transcode converts; it is slow when it delivers less media than real time over several segments (C08, review B3).
  // A long server wait before a fast transfer is the same measurement for one segment (S9a C08).
  const waited = !!fetch && fetch.waitMs >= SLOW_FIRST_BYTE_MS && fetch.waitMs > fetch.transferMs;
  if (
    input.method === 'transcode' &&
    ((input.conversionRate !== undefined && input.conversionRate < 1) || waited)
  )
    return { key: 'serverSlow' };
  const bandwidth =
    fetch && fetch.transferMs > 0 ? (fetch.bytes * 8 * 1000) / fetch.transferMs : bandwidthBps;
  if (bandwidth && bitrate && bandwidth < 1.2 * bitrate * 1000)
    return {
      key: 'slowNet',
      params: {
        measured: Math.round(bandwidth / 100_000) / 10,
        needed: Math.round(bitrate / 100) / 10,
      },
    };
  // "Converts slower" only when measured (S9b2 C11): an unexplained stall is just loading.
  return { key: 'buffering' };
}

/** Why a start or seek takes long: the server's work, a measured slow link, else the engine still opening the file (S9b). */
function slowCause(input: StatusInput): string {
  if (input.method === 'transcode') return 'converting';
  if (input.method === 'remux') return 'preparing';
  const { bandwidthBps: bandwidth, bitrateKbps: bitrate, fetch } = input;
  const slowLink = !!bandwidth && !!bitrate && bandwidth < 1.2 * bitrate * 1000;
  return slowLink || (fetch?.waitMs ?? 0) >= SLOW_FIRST_BYTE_MS ? 'slowConnection' : 'loadingFile';
}
