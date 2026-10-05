import type { Classified, ErrorCategory } from './classify';
import type { HintKey } from './hints';

/** Ladder steps (state-matrix § 2 b.2): wait, reload, new start, lower quality, step-down, other version, give up. */
export type LadderStep = 'W' | 'R' | 'N' | 'Q' | 'S' | 'V' | 'G';

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
};

export type Decision = {
  step: LadderStep;
  /** Before the step runs; `Infinity` waits for an external event (back online). */
  delayMs: number;
  /** Status hint while the step is pending or running. */
  hint?: HintKey;
};

/** Healthy playback after which an incident and its budgets end. */
export const INCIDENT_RESET_MS = 120_000;
/** Offline longer than this gives up (the card retries on its own once online). */
export const OFFLINE_BUDGET_MS = 120_000;
const T1_BACKOFF_S = [2, 4, 8, 16];
const T4_BACKOFF_S = [5, 10, 20];
const T6_BACKOFF_S = [5, 15];
/** Every incident ends on a card after this many steps, whatever the categories say. */
export const MAX_ATTEMPTS = 12;
/** Step-downs per incident: direct → remux → transcode → VLC at most. */
export const MAX_STEP_DOWNS = 3;
const STREAM_POLL_S = 10;
const STREAM_POLLS = 12;
const MAX_QUALITY_STEPS = 2;

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
  switch (category) {
    case 'T1': {
      if (code === 'tls_error' || code === 'mixed_content') return { step: 'G', delayMs: 0 };
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
      if (starts < (context.attached ? 1 : 2))
        return {
          step: 'N',
          delayMs: after(context.retryAfter, T6_BACKOFF_S[starts]!),
          hint: 'serverError',
        };
      return context.attached && incident.count(['S'], 'T6') < 1
        ? stepDown(incident)
        : { step: 'G', delayMs: 0 };
    }
    case 'T7':
      if (context.attached && incident.count(['R'], 'T7', context.revision) < 1)
        return { step: 'R', delayMs: 0, hint: 'reloading' };
      if (context.attached) return stepDown(incident, 'noPicture');
      // No method of this version plays here: another version may.
      return code === 'no_more_methods' && incident.count(['V']) < 1
        ? { step: 'V', delayMs: 0 }
        : { step: 'G', delayMs: 0 };
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
    T7: ['otherVersion', 'useVlc'],
    T8: ['otherVersion'],
    T9: [],
    T10: ['retry'],
    T11: code.startsWith('invalid_') ? [] : ['retry'],
  };
  return [...new Set([...server, ...own[category]])];
}
