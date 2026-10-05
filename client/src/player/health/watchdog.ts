import type { EngineHealth, HealthFinding, HealthVerdict } from './types';

/** Thresholds (state-matrix § 2 a). */
export const CLOCK_FROZEN_MS = 4_000;
/** Seconds of running clock without a new frame / audio before a picture or audio verdict. */
export const PICTURE_CLOCK_S = 3;
/** A confirmed picture/audio verdict escalates to the ladder after this. */
export const LADDER_AFTER_MS = 3_000;
export const SLIDESHOW_WINDOW_MS = 10_000;
export const SLIDESHOW_HINT = 0.3;
export const SLIDESHOW_LADDER = 0.6;
/** Fewer frames than this in the window say nothing about drops (very low fps, short window). */
const SLIDESHOW_MIN_FRAMES = 50;
/** A brightest pixel at or below this is pure black. */
export const LUMA_BLACK = 2;
/** Pure black from the load on for this much clock (and only in the first minute) counts as no picture. */
export const LUMA_BLACK_CLOCK_S = 20;
const LUMA_WINDOW_S = 60;

export type WatchdogSample = {
  at: number;
  /** Controller clock (seconds). */
  position: number;
  /** The engine says it plays (not paused, not loading). */
  playing: boolean;
  /** The engine announced a stall (buffering/loading after the first picture). */
  buffering: boolean;
  health: EngineHealth;
};

export type WatchdogContext = {
  /** Phase playing, not paused, not ended, no recovery running. */
  wantsPlayback: boolean;
  /** App active / document visible. */
  visible: boolean;
  pictureInPicture: boolean;
  /** A seek or a source/track change is settling. */
  settling: boolean;
  /** The source has video (server media info, else the engine). */
  hasVideo: boolean | undefined;
  hasAudio: boolean | undefined;
};

type Baseline = {
  at: number;
  position: number;
  frames?: number;
  startFrames?: number;
  /** Clock where the frame counter last moved. */
  framePosition: number;
  frameSeen: boolean;
  audio?: number;
  audioPosition: number;
  clockAt: number;
  clockPosition: number;
  native?: number;
  darkSince?: number;
};

const OK: HealthFinding = { verdict: 'ok', since: 0, level: 'hint', evidence: {} };

/** One health watchdog for every engine: pure, fed once a second with the engine's probe and the clock. */
export class Watchdog {
  private base: Baseline | null = null;
  private candidate: { verdict: HealthVerdict; since: number; ticks: number } | null = null;
  private drops: { at: number; presented: number; dropped: number }[] = [];
  /** Clock where frames last moved: where a black/frozen recovery should resume. */
  lastGoodPosition: number | null = null;

  /** Starts over: after a load, seek, track switch, pause or any guard. */
  reset(): void {
    this.base = null;
    this.candidate = null;
    this.drops = [];
  }

  observe(sample: WatchdogSample, context: WatchdogContext): HealthFinding {
    const { health } = sample;
    const guarded =
      !context.wantsPlayback ||
      context.settling ||
      (!context.visible && !context.pictureInPicture) ||
      sample.buffering;
    if (guarded) {
      this.reset();
      return OK;
    }
    const base = (this.base ??= this.baseline(sample));
    this.track(base, sample);
    const pictureChecks =
      !context.pictureInPicture && health.external !== true && context.hasVideo !== false;
    const found =
      this.clockFrozen(base, sample) ??
      (pictureChecks ? this.picture(base, sample) : null) ??
      (context.hasAudio !== false ? this.audio(base, sample) : null) ??
      (pictureChecks ? this.slideshow(sample) : null);
    return this.confirm(found, sample.at);
  }

  private baseline(sample: WatchdogSample): Baseline {
    const { health, position, at } = sample;
    this.lastGoodPosition = position;
    return {
      at,
      position,
      frames: health.framesPresented,
      startFrames: health.framesPresented,
      framePosition: position,
      frameSeen: false,
      audio: health.audioProgress,
      audioPosition: position,
      clockAt: at,
      clockPosition: position,
      native: health.nativePosition,
    };
  }

  private track(base: Baseline, sample: WatchdogSample): void {
    const { health, position, at } = sample;
    if (position !== base.clockPosition || (health.nativePosition ?? base.native) !== base.native) {
      base.clockAt = at;
      base.clockPosition = position;
      base.native = health.nativePosition;
    }
    if (health.framesPresented !== undefined && health.framesPresented !== base.frames) {
      if (base.frames !== undefined) base.frameSeen = true;
      base.startFrames ??= health.framesPresented;
      base.frames = health.framesPresented;
      base.framePosition = position;
      this.lastGoodPosition = position;
    }
    if (health.audioProgress !== undefined && health.audioProgress !== base.audio) {
      base.audio = health.audioProgress;
      base.audioPosition = position;
    }
    if (health.luma === undefined || health.luma > LUMA_BLACK) base.darkSince = undefined;
    else base.darkSince ??= position;
  }

  /** The engine says it plays, nothing announced a stall, yet neither clock moves (D35, C12, C18). */
  private clockFrozen(base: Baseline, sample: WatchdogSample): Found | null {
    if (!sample.playing || sample.at - base.clockAt < CLOCK_FROZEN_MS) return null;
    return {
      verdict: 'clock-frozen',
      level: 'ladder',
      evidence: { position: sample.position, frozenMs: sample.at - base.clockAt },
    };
  }

  private picture(base: Baseline, sample: WatchdogSample): Found | null {
    const { health, position } = sample;
    const sinceLoad = position - base.position;
    // Low-fps content (stills, slideshows): wait for at least three of its own frame intervals.
    const needed =
      base.frameSeen && base.frames !== undefined
        ? Math.max(PICTURE_CLOCK_S, 3 * frameInterval(base))
        : PICTURE_CLOCK_S;
    if (health.framesPresented !== undefined && position - base.framePosition >= needed) {
      const evidence = { frames: health.framesPresented, clock: position - base.framePosition };
      if (base.frameSeen) return { verdict: 'picture-frozen', level: 'ladder', evidence };
      return { verdict: 'picture-black', level: 'ladder', evidence };
    }
    if (health.readyForDisplay === false && sinceLoad >= PICTURE_CLOCK_S)
      return { verdict: 'picture-black', level: 'ladder', evidence: { readyForDisplay: false } };
    if (
      base.darkSince !== undefined &&
      base.darkSince - base.position < 1 &&
      sinceLoad < LUMA_WINDOW_S &&
      position - base.darkSince >= LUMA_BLACK_CLOCK_S
    )
      return { verdict: 'picture-black', level: 'ladder', evidence: { luma: health.luma } };
    return null;
  }

  /** Audio is expected, its counter exists and stood still while the clock ran (C20, C27, D36). */
  private audio(base: Baseline, sample: WatchdogSample): Found | null {
    if (sample.health.audioProgress === undefined) return null;
    if (sample.position - base.audioPosition < PICTURE_CLOCK_S) return null;
    return {
      verdict: 'audio-silent',
      level: 'ladder',
      evidence: { audio: sample.health.audioProgress, clock: sample.position - base.audioPosition },
    };
  }

  /** Dropped share of the frames over the last 10 s (C29, D38). */
  private slideshow(sample: WatchdogSample): Found | null {
    const { framesPresented, framesDropped } = sample.health;
    if (framesPresented === undefined || framesDropped === undefined) return null;
    this.drops.push({ at: sample.at, presented: framesPresented, dropped: framesDropped });
    while (this.drops.length > 1 && sample.at - this.drops[1]!.at >= SLIDESHOW_WINDOW_MS)
      this.drops.shift();
    const first = this.drops[0]!;
    if (sample.at - first.at < SLIDESHOW_WINDOW_MS) return null;
    const dropped = framesDropped - first.dropped;
    const total = framesPresented - first.presented + dropped;
    if (total < SLIDESHOW_MIN_FRAMES) return null;
    const share = dropped / total;
    if (share <= SLIDESHOW_HINT) return null;
    return {
      verdict: 'slideshow',
      level: share > SLIDESHOW_LADDER ? 'ladder' : 'hint',
      evidence: { percent: Math.round(share * 100) },
    };
  }

  /** A verdict must hold for two consecutive ticks; a picture/audio verdict escalates after LADDER_AFTER_MS. */
  private confirm(found: Found | null, at: number): HealthFinding {
    if (!found) {
      this.candidate = null;
      return OK;
    }
    const candidate =
      this.candidate?.verdict === found.verdict
        ? { ...this.candidate, ticks: this.candidate.ticks + 1 }
        : { verdict: found.verdict, since: at, ticks: 1 };
    this.candidate = candidate;
    if (candidate.ticks < 2) return OK;
    const escalates =
      found.level === 'ladder' &&
      (found.verdict === 'clock-frozen' ||
        found.verdict === 'slideshow' ||
        at - candidate.since >= LADDER_AFTER_MS);
    return {
      verdict: found.verdict,
      since: candidate.since,
      level: escalates ? 'ladder' : 'hint',
      evidence: found.evidence,
    };
  }
}

type Found = Omit<HealthFinding, 'since'>;

/** Seconds of clock per presented frame since the baseline (0 = unknown). */
function frameInterval(base: Baseline): number {
  const frames = (base.frames ?? 0) - (base.startFrames ?? 0);
  return frames > 0 ? (base.framePosition - base.position) / frames : 0;
}
