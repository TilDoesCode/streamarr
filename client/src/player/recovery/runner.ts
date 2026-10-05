import type { ErrorParams } from '@/api/errors';

import type { Classified } from './classify';
import type { HintKey, HintParams } from './hints';
import {
  INCIDENT_RESET_MS,
  INCIDENT_STUCK_MS,
  MAX_ATTEMPTS,
  OFFLINE_BUDGET_MS,
  RECURRING_INCIDENTS,
  RECURRING_WINDOW_MS,
  STEP_BUDGET_MS,
} from './budgets';
import {
  Incident,
  nextStep,
  type Attempt,
  type Decision,
  type LadderContext,
  type LadderStep,
} from './ladder';

import { StepBudget, STEP_TIMEOUT } from './step-budget';

export { STEP_TIMEOUT } from './step-budget';

/** The viewer's audio and subtitle (server indexes) at the moment of the failure; every step keeps them. */
export type StepTracks = { audio: number | null; subtitle: number | null };

export type StatusHint = { key: HintKey; params?: HintParams };

export type FailureExtra = {
  /** Where the recovery resumes, when it is not the current position (a black or frozen picture). */
  position?: number;
  params?: ErrorParams;
  status?: number;
  retryAfter?: number;
  serverActions?: string[];
  hint?: StatusHint;
  /** The failure says the source is gone (a failed server playback): only a new start helps. */
  detached?: boolean;
  /** The old picture still plays: the step runs without a hint (the server lost the playback, B13). */
  quiet?: boolean;
};

export type Recovery = {
  decision: Decision;
  failure: Classified;
  extra: FailureExtra;
  position: number;
  tracks: StepTracks;
  /** The other version a V step chose: a retry after its failure starts that release, never the old one. */
  releaseId?: string;
  due: number;
  /** The step was started; it ends with the first picture of its source (or the next failure). */
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

/** Categories that wait with their own budget and hint (offline, server countdowns, another device, the system). */
const OWN_WAIT = new Set(['T3', 'T4', 'T9', 'T10']);

/** What the runner needs from the player: the situation, the step actions and the way out. */
export type RecoveryHost = {
  /** Whether a source is attached and the facts the ladder decides on. */
  situation(): Omit<LadderContext, 'retryAfter' | 'params' | 'attached'> & { attached: boolean };
  resumePosition(): number;
  tracks(): StepTracks;
  /** Runs one step; resolves false when it changed nothing (a no-op the ladder must not wait for). */
  run(step: LadderStep, recovery: Recovery, signal: AbortSignal): Promise<boolean>;
  /** A step threw: its classified failure enters the ladder. */
  stepError(error: unknown): { failure: Classified; extra: FailureExtra };
  giveUp(failure: Classified, extra: FailureExtra, tried: Attempt[]): void;
  changed(): void;
};

/** Runs the recovery ladder: one incident, one pending or running step, its budgets and cancellation. */
export class RecoveryRunner {
  current: Recovery | null = null;
  private incident: Incident | null = null;
  /** A new start stopped the old playback: until a source attaches, retries are new starts. */
  private sourceDead = false;
  /** A step is replacing the source: errors of the old one are noise. */
  replacing = false;
  private budget: StepBudget | null = null;
  /** Since when the viewer looks at a spinner instead of the picture in this incident. */
  private stuckSince = 0;
  /** Last time a running step's server reported progress (a state change). */
  private progressAt = 0;
  /** Codes that started incidents (for "keeps coming back"). */
  private history: { code: string; at: number }[] = [];

  constructor(private readonly host: RecoveryHost) {}

  get attempts(): Attempt[] {
    return this.incident?.attempts.slice() ?? [];
  }

  /** A failure: the next ladder step of the running incident, or the card. Repeats while a step waits are absorbed. */
  handle(failure: Classified, extra: FailureExtra = {}): void {
    const current = this.current;
    if (current && !current.running) return;
    const now = Date.now();
    let recurring = false;
    if (!this.incident || now - this.incident.lastAt > INCIDENT_RESET_MS) {
      this.incident = new Incident(now);
      this.history = this.history.filter((entry) => now - entry.at < RECURRING_WINDOW_MS);
      this.history.push({ code: failure.code, at: now });
      const same = this.history.filter((entry) => entry.code === failure.code).length;
      recurring = same >= RECURRING_INCIDENTS;
    }
    const incident = this.incident;
    const situation = this.host.situation();
    const decision =
      incident.attempts.length >= MAX_ATTEMPTS || this.stuckTooLong(failure, now)
        ? ({ step: 'G', delayMs: 0 } as Decision)
        : nextStep(incident, failure, {
            ...situation,
            attached: situation.attached && !this.sourceDead && !extra.detached,
            retryAfter: extra.retryAfter,
            params: extra.params,
            recurring,
          });
    if (decision.step === 'W') return;
    const tracks = current?.tracks ?? this.host.tracks();
    const position = extra.position ?? current?.position ?? this.host.resumePosition();
    const releaseId = current?.releaseId;
    this.cancel();
    if (decision.step === 'G') {
      this.stuckSince = 0;
      return this.host.giveUp(failure, extra, incident.attempts.slice());
    }
    if (!extra.quiet) this.stuckSince ||= now;
    this.current = {
      decision,
      failure,
      extra,
      position,
      tracks,
      releaseId,
      due: now + decision.delayMs,
      running: false,
      timer: null,
    };
    this.schedule(decision.delayMs);
    this.host.changed();
  }

  /** The spinner has been up for a minute in this incident and the server shows no progress: the card (§ 2 c). */
  private stuckTooLong(failure: Classified, now: number): boolean {
    if (!this.stuckSince || OWN_WAIT.has(failure.category)) return false;
    if (failure.category === 'T1' && !this.host.situation().online) return false;
    return now - this.stuckSince >= INCIDENT_STUCK_MS && now - this.progressAt >= STEP_BUDGET_MS;
  }

  /** The viewer moved: a waiting step resumes where the viewer is now, with the viewer's tracks (review B4). */
  reposition(position: number, tracks?: StepTracks): void {
    const current = this.current;
    if (!current || current.running) return;
    current.position = position;
    if (tracks) current.tracks = tracks;
    this.host.changed();
  }

  /** The viewer picked audio or subtitles in the engine: a waiting step keeps the new pick. */
  retrack(tracks: StepTracks): void {
    const current = this.current;
    if (current && !current.running) current.tracks = tracks;
  }

  /** The server reports progress for the running step (a new start state): its budget starts over. */
  progress(): void {
    if (!this.current?.running || !this.budget) return;
    this.progressAt = Date.now();
    this.budget.extend();
  }

  /** The other version a V step is starting (kept for the retries of that start). */
  choose(releaseId: string): void {
    if (this.current) this.current.releaseId = releaseId;
  }

  /** Offline for longer than its budget while a step waits for the network: the card. */
  expireOffline(offlineFor: number): void {
    const current = this.current;
    if (!current || current.due !== Infinity || offlineFor < OFFLINE_BUDGET_MS) return;
    this.clear();
    this.stuckSince = 0;
    this.host.giveUp(current.failure, current.extra, this.attempts);
  }

  /** A step that waits (backoff, offline) runs now. */
  runNow(): void {
    if (this.current && !this.current.running) this.schedule(0);
  }

  /** Back online: a step that waited for the network runs. */
  online(): void {
    if (this.current && !this.current.running && this.current.due === Infinity) this.schedule(0);
  }

  /** The source shows a picture: the step worked, and the viewer is no longer stuck. */
  recovered(): void {
    this.stuckSince = 0;
    if (this.current?.running) this.clear();
  }

  /** A source was attached: retries may reload it again. */
  attached(): void {
    this.sourceDead = false;
  }

  /** The viewer's own switch or a stop replaces whatever the ladder planned. */
  cancel(): void {
    this.clear();
  }

  /** Forgets the incident too (the viewer's Retry starts with a fresh budget). */
  reset(): void {
    this.cancel();
    this.incident = null;
    this.stuckSince = 0;
  }

  /** Starts a step now without a failure (the card's Retry). */
  start(step: LadderStep, failure: Classified, position: number): void {
    this.cancel();
    this.current = {
      decision: { step, delayMs: 0, hint: 'reloading' },
      failure,
      extra: {},
      position,
      tracks: this.host.tracks(),
      due: Date.now(),
      running: false,
      timer: null,
    };
    this.schedule(0);
  }

  private clear(): void {
    const current = this.current;
    if (current?.timer) clearTimeout(current.timer);
    this.budget?.cancel();
    this.budget = null;
    this.replacing = false;
    this.current = null;
  }

  private schedule(delayMs: number): void {
    const recovery = this.current;
    if (!recovery) return;
    if (recovery.timer) clearTimeout(recovery.timer);
    recovery.timer = null;
    recovery.due = Date.now() + delayMs;
    if (delayMs === Infinity) return;
    if (delayMs > 0) recovery.timer = setTimeout(() => this.schedule(0), delayMs);
    else void this.execute(recovery);
  }

  private async execute(recovery: Recovery): Promise<void> {
    if (this.current !== recovery) return;
    recovery.running = true;
    const { step } = recovery.decision;
    const attempt: Attempt = {
      step,
      category: recovery.failure.category,
      code: recovery.failure.code,
      position: recovery.position,
      at: Date.now(),
      revision: this.host.situation().revision,
    };
    const incident = this.incident;
    incident?.record(attempt);
    this.host.changed();
    // A new start and another version stop the old playback: until a source attaches, retries start anew (review B5).
    const replaces = step === 'N' || step === 'V';
    if (replaces) this.sourceDead = true;
    this.replacing = replaces;
    // The step's own budget: a server that never gets the new source ready fails the step.
    const budget = new StepBudget();
    this.budget = budget;
    this.progressAt = 0;
    let ran = true;
    let thrown: unknown = undefined;
    try {
      ran = await this.host.run(step, recovery, budget.signal);
    } catch (error) {
      thrown =
        budget.signal.reason === STEP_TIMEOUT && this.current === recovery ? STEP_TIMEOUT : error;
    }
    if (this.budget === budget) {
      budget.end();
      this.budget = null;
      this.replacing = false;
    }
    // Replaced meanwhile (cancelled, a newer failure, or given up).
    if (this.current !== recovery) return;
    if (thrown !== undefined) {
      const { failure, extra } = this.host.stepError(thrown);
      return this.handle(failure, extra);
    }
    // A step that changed nothing must not leave a spinner: the ladder goes on from here, or ends.
    if (!ran) {
      incident?.forget(attempt);
      this.clear();
      return this.host.giveUp(recovery.failure, recovery.extra, this.attempts);
    }
    this.host.changed();
  }
}
