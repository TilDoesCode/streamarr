import {
  MAX_QUALITY_STEPS,
  MAX_STEP_DOWNS,
  STREAM_POLL_S,
  STREAM_POLLS,
  T1_BACKOFF_S,
  T4_BACKOFF_S,
  T6_BACKOFF_S,
} from './budgets';
import type { Classified, ErrorCategory } from './classify';
import type { HintKey } from './hints';

/** Ladder steps (state-matrix § 2 b.2): wait, reload, new start, lower quality, step-down, audio fallback, other version, give up. */
export type LadderStep = 'W' | 'R' | 'N' | 'Q' | 'S' | 'A' | 'V' | 'G';

export type Attempt = {
  step: LadderStep;
  category: ErrorCategory;
  code: string;
  /** Seconds on the media timeline where the step resumed. */
  position: number;
  at: number;
  /** Playback revision the step ran on (a reload is allowed once per revision). */
  revision: number;
};

export type LadderContext = {
  /** A source is attached (mid-play); otherwise the failure happened while starting. */
  attached: boolean;
  online: boolean;
  /** Seconds the server asked to wait (`Retry-After`). */
  retryAfter?: number;
  /** The quality can still go one step down (transcode above 480p, or a source above 480p). */
  canLowerQuality: boolean;
  params?: Readonly<Record<string, string>>;
  revision: number;
  /** The server already converts the audio to AAC stereo for this playback (B13 `audioFallback`). */
  audioFallback: boolean;
  /** The same failure keeps coming back (incidents within 15 min): skip the reload, another way to play. */
  recurring?: boolean;
};

export type Decision = {
  step: LadderStep;
  /** Before the step runs; `Infinity` waits for an external event (back online). */
  delayMs: number;
  /** Status hint while the step is pending or running. */
  hint?: HintKey;
};

/** Server failures to prepare a version: another version (step V) may not need them. */
const CONVERSION_FAILURES: ReadonlySet<string> = new Set([
  'transcode_failed',
  'ffmpeg_unavailable',
  'transcoding_unavailable',
  'rendition_split_failed',
  'segment_timeout',
  'step_timeout',
]);

/** Audio failures the server's audio conversion can fix (ladder step A, B13). */
export const AUDIO_CODES: ReadonlySet<string> = new Set([
  'audio_decode_error',
  'audio_silent',
  'audio_rendition_failed',
]);

/** One failure episode: every new failure continues its ladder until playback is healthy for 2 minutes. */
export class Incident {
  readonly attempts: Attempt[] = [];
  lastAt: number;

  constructor(readonly startedAt: number) {
    this.lastAt = startedAt;
  }

  count(steps: readonly LadderStep[], category?: ErrorCategory, revision?: number): number {
    return this.attempts.filter(
      (attempt) =>
        steps.includes(attempt.step) &&
        (!category || attempt.category === category) &&
        (revision === undefined || attempt.revision === revision)
    ).length;
  }

  record(attempt: Attempt): void {
    this.attempts.push(attempt);
    this.lastAt = attempt.at;
  }

  /** A step that found nothing to do (no other version) is not part of "What was tried". */
  forget(attempt: Attempt): void {
    const at = this.attempts.lastIndexOf(attempt);
    if (at >= 0) this.attempts.splice(at, 1);
  }
}

const seconds = (value: number) => value * 1000;
/** Mid-play the same source is reloaded; a failed start is started again. */
const retry = (context: LadderContext): LadderStep => (context.attached ? 'R' : 'N');
/** Another way to play while the step-down budget lasts. */
const stepDown = (incident: Incident, hint?: HintKey): Decision =>
  incident.count(['S']) < MAX_STEP_DOWNS
    ? { step: 'S', delayMs: 0, hint }
    : { step: 'G', delayMs: 0 };

/** The next step for a classified failure within its incident (state-matrix § 2 b.3). */
export function nextStep(
  incident: Incident,
  failure: Classified,
  context: LadderContext
): Decision {
  const { category, code } = failure;
  const after = (wait: number | undefined, fallback: number) => seconds(wait ?? fallback);
  // A device failure that keeps coming back is not fixed by reloading again (R5); server and network faults never step down.
  const deviceFailure =
    (category === 'T7' && code !== 'media_damaged') || code === 'playback_slideshow';
  if (context.recurring && context.attached && deviceFailure && incident.attempts.length === 0)
    return stepDown(incident, category === 'T5' ? 'deviceSlow' : 'noPicture');
  switch (category) {
    case 'T1': {
      // Retrying cannot get past a certificate problem or a network that answers with its own sign-in page (A26).
      if (code === 'tls_error' || code === 'mixed_content' || code === 'network_intercepted')
        return { step: 'G', delayMs: 0 };
      if (!context.online) return { step: retry(context), delayMs: Infinity, hint: 'offline' };
      const tries = incident.count(['R', 'N'], 'T1');
      if (tries < T1_BACKOFF_S.length)
        return {
          step: retry(context),
          delayMs: seconds(T1_BACKOFF_S[tries]!),
          hint: 'reconnecting',
        };
      if (tries === T1_BACKOFF_S.length) return { step: 'N', delayMs: 0, hint: 'reconnecting' };
      return { step: 'G', delayMs: 0 };
    }
    case 'T2':
      return incident.count(['N'], 'T2') < 1
        ? { step: 'N', delayMs: 0, hint: 'restarting' }
        : { step: 'G', delayMs: 0 };
    case 'T3':
      return { step: 'G', delayMs: 0 };
    case 'T4': {
      if (context.params?.reason === 'insufficient_disk') return { step: 'G', delayMs: 0 };
      const tries = incident.count(['R', 'N'], 'T4');
      if (tries >= T4_BACKOFF_S.length) return { step: 'G', delayMs: 0 };
      return {
        step: retry(context),
        delayMs: after(context.retryAfter, T4_BACKOFF_S[tries]!),
        hint: 'serverBusy',
      };
    }
    case 'T5': {
      // The server could not get a start or switch ready in its 60 s (B13b): its playback failed, so a fresh start,
      // then another version, then the card with the server's actions (retry, lower quality).
      if (code === 'start_timeout' && !context.attached) {
        if (incident.count(['N'], 'T5') < 1) return { step: 'N', delayMs: 0, hint: 'reloading' };
        return incident.count(['V']) < 1 ? { step: 'V', delayMs: 0 } : { step: 'G', delayMs: 0 };
      }
      // A seek that never continues: reload at the target once before lowering the quality (C09).
      if (code === 'seek_stalled' && context.attached && incident.count(['R'], 'T5') < 1)
        return { step: 'R', delayMs: 0, hint: 'reloading' };
      if (context.canLowerQuality && incident.count(['Q']) < MAX_QUALITY_STEPS)
        return { step: 'Q', delayMs: 0, hint: 'buffering' };
      return context.attached ? stepDown(incident, 'buffering') : { step: 'G', delayMs: 0 };
    }
    case 'T6': {
      const reloads = incident.count(['R'], 'T6');
      if (context.attached && reloads < T6_BACKOFF_S.length)
        return {
          step: 'R',
          delayMs: after(context.retryAfter, T6_BACKOFF_S[reloads]!),
          hint: 'serverError',
        };
      const starts = incident.count(['N'], 'T6');
      // A conversion that fails again on a fresh start will not work on a third: another version is next (S9a B06).
      if (starts < (context.attached || CONVERSION_FAILURES.has(code) ? 1 : 2))
        return {
          step: 'N',
          delayMs: after(context.retryAfter, T6_BACKOFF_S[starts]!),
          hint: 'serverError',
        };
      if (context.attached && incident.count(['S'], 'T6') < 1) return stepDown(incident);
      // The server cannot prepare this version (conversion fails or never starts): another version may play (S9a B06).
      if (CONVERSION_FAILURES.has(code) && incident.count(['V']) < 1)
        return { step: 'V', delayMs: 0 };
      return { step: 'G', delayMs: 0 };
    }
    case 'T7': {
      const audio = AUDIO_CODES.has(code) && context.attached;
      // An audio codec the device refuses: reloading cannot help, converting the audio can (D13, C27).
      if (
        audio &&
        code === 'audio_decode_error' &&
        !context.audioFallback &&
        incident.count(['A']) < 1
      )
        return { step: 'A', delayMs: 0, hint: 'noAudio' };
      // The server's audio failed even converted: the card, no further reloads or step-downs.
      if (code === 'audio_rendition_failed' && incident.count(['A']) >= 1)
        return { step: 'G', delayMs: 0 };
      if (context.attached && incident.count(['R'], 'T7', context.revision) < 1)
        return { step: 'R', delayMs: 0, hint: audio ? 'noAudio' : 'reloading' };
      // Silence after a reload: the server converts the audio before another method is tried (C20, D36).
      if (audio && !context.audioFallback && incident.count(['A']) < 1)
        return { step: 'A', delayMs: 0, hint: 'noAudio' };
      if (code === 'audio_rendition_failed') return { step: 'G', delayMs: 0 };
      if (context.attached) return stepDown(incident, 'noPicture');
      // No method of this version plays here: another version may.
      return code === 'no_more_methods' && incident.count(['V']) < 1
        ? { step: 'V', delayMs: 0 }
        : { step: 'G', delayMs: 0 };
    }
    case 'T8':
      if (context.attached && incident.count(['R'], 'T8') < 1)
        return { step: 'R', delayMs: 0, hint: 'reloading' };
      if (incident.count(['V']) < 1) return { step: 'V', delayMs: 0 };
      return { step: 'G', delayMs: 0 };
    case 'T9':
      if (code === 'too_many_streams' && incident.count(['N'], 'T9') < STREAM_POLLS)
        return { step: 'N', delayMs: seconds(STREAM_POLL_S), hint: 'waitingForStream' };
      return { step: 'G', delayMs: 0 };
    case 'T10':
      return { step: 'W', delayMs: Infinity, hint: 'pausedBySystem' };
    case 'T11': {
      // The app itself failed (an engine that throws): repeating it only hides the code (S9a E09).
      if (code === 'player_internal_error') return { step: 'G', delayMs: 0 };
      if (context.attached && incident.count(['R'], 'T11') < 1)
        return { step: 'R', delayMs: 0, hint: 'reloading' };
      if (code.startsWith('invalid_') || incident.count(['N'], 'T11') >= 1)
        return { step: 'G', delayMs: 0 };
      return { step: 'N', delayMs: 0, hint: 'reloading' };
    }
  }
}

/** Card actions per category after the ladder gave up; the server's own suggestions come first. */
export function cardActions(
  category: ErrorCategory,
  code: string,
  server: readonly string[] = []
): string[] {
  const own: Record<ErrorCategory, string[]> = {
    T1: code === 'tls_error' ? [] : ['retry'],
    T2: ['retry'],
    T3: ['signIn'],
    T4: ['retry'],
    T5: ['lowerQuality', 'otherVersion'],
    T6: ['retry', 'otherVersion'],
    T7:
      code === 'audio_rendition_failed'
        ? ['retry', 'otherVersion']
        : code === 'picture_timeout'
          ? ['retry', 'otherVersion', 'useVlc']
          : ['otherVersion', 'useVlc'],
    T8: ['otherVersion'],
    T9: [],
    T10: ['retry'],
    T11: code.startsWith('invalid_') ? [] : ['retry'],
  };
  return [...new Set([...server, ...own[category]])];
}
