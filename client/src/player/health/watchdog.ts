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
export const SLIDESHOW_MIN_FRAMES = 50;
/** A brightest pixel at or below this is pure black. */
export const LUMA_BLACK = 2;
/** Pure black from the source load on for this much clock, with frames and sound standing, is no picture. */
export const LUMA_BLACK_CLOCK_S = 20;
/** The luma rule only judges the first minute of clock after a source load (later black is content). */
export const LUMA_WINDOW_S = 60;
/** Frames of this source were shown, but no interval is known yet: wait this long before calling it frozen. */
export const UNKNOWN_FPS_S = 10;

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

/** What the watchdog knows about the current source; a seek, pause or guard keeps it, a new load starts over. */
type Source = {
  /** Clock at the load. */
  position: number;
  /** Frames of this source were seen (moving, or a counter above zero at the first look). */
  framesSeen: boolean;
  /** Seconds of clock per frame, last measured. */
  interval?: number;
  /** Clock where pure black started, with the frame and audio counters at that moment. */
  dark?: { position: number; frames?: number; audio?: number };
};

type Baseline = {
  at: number;
  position: number;
  frames?: number;
  startFrames?: number;
  /** Clock where the frame counter last moved. */
  framePosition: number;
  /** The first move after the baseline: intervals are measured from here (the baseline falls mid-interval). */
  firstMove?: { position: number; frames: number };
  frameSeen: boolean;
  audio?: number;
  audioPosition: number;
  clockAt: number;
  clockPosition: number;
  native?: number;
};

const OK: HealthFinding = { verdict: 'ok', since: 0, level: 'hint', evidence: {} };

/** One health watchdog for every engine: pure, fed once a second with the engine's probe and the clock. */
export class Watchdog {
  private base: Baseline | null = null;
  private source: Source | null = null;
  private candidate: { verdict: HealthVerdict; since: number; ticks: number } | null = null;
  private drops: { at: number; presented: number; dropped: number }[] = [];
  /** Clock where frames last moved: where a black/frozen recovery should resume. */
  lastGoodPosition: number | null = null;

  /** A new source was loaded: everything starts over, including what is known about this source. */
  newSource(): void {
    this.source = null;
    this.reset();
  }

  /** Starts over: after a seek, track switch, pause or any guard (the source's facts stay). */
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
    const source = (this.source ??= {
      position: sample.position,
      framesSeen: (health.framesPresented ?? 0) > 0,
    });
    const base = (this.base ??= this.baseline(sample));
    this.track(source, base, sample);
    // Casting (AirPlay, Remote Playback): the local element neither decodes nor plays, only the clock counts.
    const local = health.external !== true;
    const pictureChecks = local && !context.pictureInPicture && context.hasVideo !== false;
    const found =
      this.clockFrozen(base, sample) ??
      (pictureChecks ? this.picture(source, base, sample) : null) ??
      (local && context.hasAudio !== false ? this.audio(base, sample) : null) ??
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

  private track(source: Source, base: Baseline, sample: WatchdogSample): void {
    const { health, position, at } = sample;
    if (position !== base.clockPosition || (health.nativePosition ?? base.native) !== base.native) {
      base.clockAt = at;
      base.clockPosition = position;
      base.native = health.nativePosition;
    }
    if (health.framesPresented !== undefined && health.framesPresented !== base.frames) {
      if (base.frames !== undefined) {
        base.frameSeen = true;
        source.framesSeen = true;
      }
      base.startFrames ??= health.framesPresented;
      base.frames = health.framesPresented;
      base.framePosition = position;
      this.lastGoodPosition = position;
      if (base.frameSeen) base.firstMove ??= { position, frames: health.framesPresented };
      const interval = frameInterval(base);
      if (interval > 0) source.interval = Math.max(source.interval ?? 0, interval);
    }
    if (health.audioProgress !== undefined && health.audioProgress !== base.audio) {
      base.audio = health.audioProgress;
      base.audioPosition = position;
    }
    if (health.luma === undefined || health.luma > LUMA_BLACK) source.dark = undefined;
    else source.dark ??= { position, frames: health.framesPresented, audio: health.audioProgress };
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

  private picture(source: Source, base: Baseline, sample: WatchdogSample): Found | null {
    const { health, position } = sample;
    // Low-fps content (stills, slideshows): at least three of its own frame intervals, kept across seeks.
    const interval = Math.max(frameInterval(base), source.interval ?? 0);
    const needed = !source.framesSeen
      ? PICTURE_CLOCK_S
      : interval > 0
        ? Math.max(PICTURE_CLOCK_S, 3 * interval)
        : UNKNOWN_FPS_S;
    if (health.framesPresented !== undefined && position - base.framePosition >= needed) {
      const evidence = { frames: health.framesPresented, clock: position - base.framePosition };
      if (source.framesSeen) return { verdict: 'picture-frozen', level: 'ladder', evidence };
      return { verdict: 'picture-black', level: 'ladder', evidence };
    }
    if (health.readyForDisplay === false && position - base.position >= PICTURE_CLOCK_S)
      return { verdict: 'picture-black', level: 'ladder', evidence: { readyForDisplay: false } };
    return this.black(source, sample);
  }

  /** Pure black since the load, inside the first minute, while neither frames nor sound move (moving = black content). */
  private black(source: Source, sample: WatchdogSample): Found | null {
    const { dark } = source;
    const { health, position } = sample;
    if (!dark || dark.position - source.position >= 1) return null;
    if (position - source.position >= LUMA_WINDOW_S) return null;
    if (position - dark.position < LUMA_BLACK_CLOCK_S) return null;
    const moving = (now: number | undefined, then: number | undefined) =>
      now !== undefined && then !== undefined && now !== then;
    if (moving(health.framesPresented, dark.frames) || moving(health.audioProgress, dark.audio))
      return null;
    return { verdict: 'picture-black', level: 'ladder', evidence: { luma: health.luma } };
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

/** Seconds of clock per presented frame between whole moves after the baseline (0 = not measured yet). */
function frameInterval(base: Baseline): number {
  const first = base.firstMove;
  if (!first || base.frames === undefined) return 0;
  const frames = base.frames - first.frames;
  return frames > 0 ? (base.framePosition - first.position) / frames : 0;
}
