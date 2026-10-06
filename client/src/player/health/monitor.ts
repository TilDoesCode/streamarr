import type { PlayerEngine } from '@/player/engines/types';

import type { EngineHealth, HealthFinding, HealthVerdict } from './types';
import { Watchdog, type WatchdogContext } from './watchdog';

/** The watchdog reads the engine probe this often while playback runs. */
export const HEALTH_TICK_MS = 1_000;
/** A probe answer later than this is no answer: the clock rules run without it (code review native #3). */
export const PROBE_TIMEOUT_MS = 1_500;
/** After this many unanswered probes in a row the engine counts as having none until the next source. */
export const PROBE_GIVE_UP = 3;

/** What the monitor needs from the player: the engine, the guards, and where its findings go. */
export type MonitorHost = {
  engine(): PlayerEngine | null;
  closed(): boolean;
  /** The guards of the moment and whether the player knows of a stall. */
  context(health: EngineHealth): WatchdogContext & { buffering: boolean };
  /** A frozen clock joins the stall timeline. */
  stall(): void;
  /** A confirmed picture/audio/slideshow verdict enters the ladder; `resumeAt` is where frames last moved. */
  escalate(
    verdict: Exclude<HealthVerdict, 'ok' | 'clock-frozen'>,
    resumeAt: number | undefined
  ): void;
  changed(): void;
};

/** Runs the watchdog once a second on every engine; without a probe (native until S6/S7) only the clock rules can fire. */
export class HealthMonitor {
  readonly watchdog = new Watchdog();
  /** The current finding below the ladder threshold (shown as a hint). */
  finding: HealthFinding | null = null;
  last: EngineHealth = {};
  /** The engine's own clock when it ran ahead of stalled time events (D35). */
  nativeClock: { position: number; at: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  /** The probe still unanswered from an earlier tick: asked again only once it settles. */
  private pending: Promise<EngineHealth> | null = null;
  private missed = 0;

  constructor(private readonly host: MonitorHost) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), HEALTH_TICK_MS);
  }

  /** A new source: the watchdog forgets what it learnt about the last one (luma window, frame interval). */
  newSource(): void {
    this.watchdog.newSource();
    this.nativeClock = null;
    this.missed = 0;
    this.pending = null;
    if (this.finding) {
      this.finding = null;
      this.host.changed();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** After a load, a seek or a track switch the judgement starts over. */
  reset(): void {
    this.watchdog.reset();
    if (this.finding) {
      this.finding = null;
      this.host.changed();
    }
  }

  private async tick(): Promise<void> {
    const engine = this.host.engine();
    if (!engine || this.busy || this.host.closed()) return;
    this.busy = true;
    let health: EngineHealth = {};
    try {
      health = await this.probe(engine);
    } finally {
      this.busy = false;
    }
    if (this.host.engine() !== engine || this.host.closed()) return;
    this.last = health;
    const snapshot = engine.getSnapshot();
    const now = Date.now();
    const { buffering, ...context } = this.host.context(health);
    const finding = this.watchdog.observe(
      {
        at: now,
        position: snapshot.position,
        playing: snapshot.state === 'playing',
        buffering,
        health,
      },
      context
    );
    const native = health.nativePosition;
    this.nativeClock =
      native !== undefined && snapshot.state === 'playing' && native - snapshot.position > 2
        ? { position: native, at: now }
        : null;
    this.judge(finding);
  }

  /** The engine's answer within PROBE_TIMEOUT_MS, else `{}`; a probe that keeps missing is not asked any more. */
  private async probe(engine: PlayerEngine): Promise<EngineHealth> {
    if (!engine.readHealth || this.missed >= PROBE_GIVE_UP) return {};
    const asked = (this.pending ??= engine.readHealth().catch(() => ({})));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(
      (resolve) => (timer = setTimeout(resolve, PROBE_TIMEOUT_MS, null))
    );
    const answer = await Promise.race([asked, late]);
    clearTimeout(timer);
    if (answer === null) {
      this.missed += 1;
      return {};
    }
    this.pending = null;
    this.missed = 0;
    return answer;
  }

  /** Clock-frozen joins the stall timeline; the others hint, then enter the ladder. */
  private judge(finding: HealthFinding): void {
    const previous = this.finding;
    if (finding.verdict === 'ok') {
      if (previous) {
        this.finding = null;
        this.host.changed();
      }
      return;
    }
    if (finding.verdict === 'clock-frozen') {
      this.finding = null;
      return this.host.stall();
    }
    if (finding.level === 'ladder') {
      this.finding = null;
      const resumeAt =
        finding.verdict === 'slideshow' ? undefined : (this.watchdog.lastGoodPosition ?? undefined);
      this.watchdog.reset();
      return this.host.escalate(finding.verdict, resumeAt);
    }
    this.finding = finding;
    if (previous?.verdict !== finding.verdict) this.host.changed();
  }
}
