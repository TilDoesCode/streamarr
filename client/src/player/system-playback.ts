import type { EngineHealth } from '@/player/health/types';
import type { PlayerEngine, SystemCause } from '@/player/engines/types';
import { SYSTEM_PAUSE_MS } from '@/player/recovery/budgets';

/** What the player tells this helper: its engine, whether a card or stop ended playback, and its pause flag. */
export type SystemHost = {
  engine(): PlayerEngine | null;
  /** A failure card, the sign-in card or a stop is shown: nothing may play again by itself. */
  terminal(): boolean;
  paused(): boolean;
  /** The viewer's pause flag follows the system (no engine command). */
  follow(paused: boolean): void;
  /** A pause of the engine the app did not ask for may be adopted now (picture shown, no step, not ended). */
  adoptable(): boolean;
  report(): void;
  changed(): void;
};

/** Pauses and resumes by the OS (call, audio focus, lock, PiP ✕) and AirPlay (A12–A18). */
export class SystemPlayback {
  /** The engine paused without the app asking (call, other audio, headphones, lock …). */
  paused = false;
  /** Why, when the engine knows (null = somewhere outside the app). */
  cause: SystemCause | null = null;
  /** AirPlay / external playback shows the picture elsewhere. */
  external: { device?: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: SystemHost) {}

  /** Paused/resumed from the system controls; a resume behind a card is refused (review native #1). */
  onUserPlayback(paused: boolean, cause?: SystemCause): void {
    if (!paused && this.host.terminal()) return void this.host.engine()?.pause();
    this.host.follow(paused);
    if (paused && cause) this.paused = true;
    if (!paused) this.paused = false;
    this.cause = paused ? (cause ?? null) : null;
    if (paused) this.host.report();
    this.host.changed();
  }

  /** The engine plays: a system pause ends on its own (end of a call); an app pause or a card holds it. */
  onPlaying(): void {
    if (this.host.terminal()) return void this.host.engine()?.pause();
    if (this.paused) {
      this.clear();
      this.host.follow(false);
    } else if (this.host.paused()) this.host.engine()?.pause();
  }

  /** A pause the app did not ask for (native engines; web reports `userPlayback`) is adopted after a moment. */
  onPaused(): void {
    const engine = this.host.engine();
    if (!engine || engine.kind === 'web' || this.host.paused() || !this.host.adoptable()) return;
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.host.engine() !== engine || engine.getSnapshot().state !== 'paused') return;
      if (this.host.paused() || !this.host.adoptable() || this.host.terminal()) return;
      this.host.follow(true);
      this.paused = true;
      this.cause = null;
      this.host.report();
      this.host.changed();
    }, SYSTEM_PAUSE_MS);
  }

  /** The viewer resumed: no system pause is left to explain. */
  clear(): void {
    this.paused = false;
    this.cause = null;
  }

  onExternal(active: boolean, device?: string): void {
    this.external = active ? { device } : null;
    this.host.changed();
  }

  /** The current engine's probe says where the picture is; an engine without a device name is still "elsewhere". */
  probed(health: EngineHealth): void {
    if (health.external === undefined || !!health.external === !!this.external) return;
    this.external = health.external ? {} : null;
    this.host.changed();
  }

  /** A new engine or a teardown: AirPlay of the old engine ended with it (review native #2). */
  engineGone(): void {
    this.cancel();
    if (!this.external) return;
    this.external = null;
    this.host.changed();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
