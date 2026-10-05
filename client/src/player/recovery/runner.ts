import type { ErrorParams } from '@/api/errors';

import type { Classified } from './classify';
import type { HintKey, HintParams } from './hints';
import {
  Incident,
  INCIDENT_RESET_MS,
  MAX_ATTEMPTS,
  nextStep,
  type Attempt,
  type Decision,
  type LadderContext,
  type LadderStep,
} from './ladder';

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
};

export type Recovery = {
  decision: Decision;
  failure: Classified;
  extra: FailureExtra;
  position: number;
  tracks: StepTracks;
  due: number;
  /** The step was started; it ends with the first picture of its source (or the next failure). */
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

/** The server and source work a step may take before it counts as failed (polls of a new start included). */
export const STEP_BUDGET_MS = 90_000;

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
  private stepAbort: AbortController | null = null;
  private stepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: RecoveryHost) {}

  get attempts(): Attempt[] {
    return this.incident?.attempts.slice() ?? [];
  }

  /** A failure: the next ladder step of the running incident, or the card. Repeats while a step waits are absorbed. */
  handle(failure: Classified, extra: FailureExtra = {}): void {
    const current = this.current;
    if (current && !current.running) return;
    const now = Date.now();
    if (!this.incident || now - this.incident.lastAt > INCIDENT_RESET_MS)
      this.incident = new Incident(now);
    const incident = this.incident;
    const situation = this.host.situation();
    const decision =
      incident.attempts.length >= MAX_ATTEMPTS
        ? ({ step: 'G', delayMs: 0 } as Decision)
        : nextStep(incident, failure, {
            ...situation,
            attached: situation.attached && !this.sourceDead && !extra.detached,
            retryAfter: extra.retryAfter,
            params: extra.params,
          });
    if (decision.step === 'W') return;
    const tracks = current?.tracks ?? this.host.tracks();
    const position = extra.position ?? current?.position ?? this.host.resumePosition();
    this.cancel();
    if (decision.step === 'G') return this.host.giveUp(failure, extra, incident.attempts.slice());
    this.current = {
      decision,
      failure,
      extra,
      position,
      tracks,
      due: now + decision.delayMs,
      running: false,
      timer: null,
    };
    this.schedule(decision.delayMs);
    this.host.changed();
  }

  /** A step that waits (backoff, offline) runs now. */
  runNow(): void {
    if (this.current && !this.current.running) this.schedule(0);
  }

  /** Back online: a step that waited for the network runs. */
  online(): void {
    if (this.current && !this.current.running && this.current.due === Infinity) this.schedule(0);
  }

  /** The source shows a picture: the step worked. */
  recovered(): void {
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
    if (this.stepTimer) clearTimeout(this.stepTimer);
    this.stepTimer = null;
    this.stepAbort?.abort();
    this.stepAbort = null;
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
    if (step === 'N') this.sourceDead = true;
    this.replacing = step === 'N';
    const abort = new AbortController();
    this.stepAbort = abort;
    // The step's own budget: a server that never gets the new source ready fails the step.
    this.stepTimer = setTimeout(() => abort.abort(new Error('step_timeout')), STEP_BUDGET_MS);
    let ran = true;
    let thrown: unknown = undefined;
    try {
      ran = await this.host.run(step, recovery, abort.signal);
    } catch (error) {
      thrown = abort.signal.aborted && this.current === recovery ? STEP_TIMEOUT : error;
    }
    if (this.stepAbort === abort) {
      if (this.stepTimer) clearTimeout(this.stepTimer);
      this.stepTimer = null;
      this.stepAbort = null;
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

/** Thrown into `stepError` when a step ran out of its budget. */
export const STEP_TIMEOUT = new Error('step_timeout');
