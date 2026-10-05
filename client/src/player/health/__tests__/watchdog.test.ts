import type { EngineHealth } from '@/player/health/types';
import {
  CLOCK_FROZEN_MS,
  LADDER_AFTER_MS,
  Watchdog,
  type WatchdogContext,
  type WatchdogSample,
} from '@/player/health/watchdog';

const CONTEXT: WatchdogContext = {
  wantsPlayback: true,
  visible: true,
  pictureInPicture: false,
  settling: false,
  hasVideo: true,
  hasAudio: true,
};

/** Plays `seconds` of 1 s ticks; `step` changes the health and clock per tick. */
function run(
  watchdog: Watchdog,
  seconds: number,
  step: (second: number) => {
    position?: number;
    health?: EngineHealth;
    playing?: boolean;
    buffering?: boolean;
  },
  context: Partial<WatchdogContext> = {},
  start = 0
) {
  const findings = [];
  for (let second = start; second < start + seconds; second++) {
    const tick = step(second);
    const sample: WatchdogSample = {
      at: second * 1000,
      position: tick.position ?? second,
      playing: tick.playing ?? true,
      buffering: tick.buffering ?? false,
      health: tick.health ?? {},
    };
    findings.push(watchdog.observe(sample, { ...CONTEXT, ...context }));
  }
  return findings;
}

const healthy = (second: number): EngineHealth => ({
  framesPresented: second * 24,
  framesDropped: 0,
  audioProgress: second * 1000,
});
const verdicts = (findings: { verdict: string }[]) => findings.map((finding) => finding.verdict);

describe('Watchdog (state-matrix § 2 a)', () => {
  it('casting (external playback): only the clock counts, no picture and no sound rule (review B2)', () => {
    const findings = run(new Watchdog(), 20, (second) => ({
      health: { external: true, framesPresented: 0, audioProgress: 0, framesDropped: second * 50 },
    }));
    expect(new Set(verdicts(findings))).toEqual(new Set(['ok']));
    const frozen = run(new Watchdog(), 8, () => ({ position: 5, health: { external: true } }));
    expect(verdicts(frozen)).toContain('clock-frozen');
  });

  it('low-fps content: the frame interval of the source survives a seek (review R4)', () => {
    const watchdog = new Watchdog();
    const still = (from: number) => (second: number) => ({
      position: from + second,
      health: { framesPresented: 1 + Math.floor(second / 12), audioProgress: second * 1000 },
    });
    // The first minute learns the interval (before that, the 10 s fallback may flicker a hint, never the ladder).
    const learning = run(watchdog, 40, still(0));
    expect(
      learning.filter((finding) => finding.level === 'ladder' && finding.verdict !== 'ok')
    ).toEqual([]);
    watchdog.reset();
    // One frame per 12 s: without the source's interval the 10 s fallback would call it frozen.
    expect(verdicts(run(watchdog, 30, still(500), {}, 40))).not.toContain('picture-frozen');
  });

  it('frames shown before the first look but no interval known: frozen only after 10 s (review N10)', () => {
    const findings = run(new Watchdog(), 10, (second) => ({
      health: { framesPresented: 100 + Math.floor(second / 8) },
    }));
    expect(verdicts(findings).filter((verdict) => verdict !== 'ok')).toEqual([]);
    const stuck = run(new Watchdog(), 16, () => ({ health: { framesPresented: 100 } }));
    expect(verdicts(stuck)).toContain('picture-frozen');
  });

  it('slideshow needs 50 frames in the window: very low fps content with drops is no slideshow (K07)', () => {
    const findings = run(new Watchdog(), 25, (second) => ({
      health: { framesPresented: second, framesDropped: second * 3, audioProgress: second * 1000 },
    }));
    expect(verdicts(findings)).not.toContain('slideshow');
  });

  it('stays quiet on healthy playback', () => {
    const findings = run(new Watchdog(), 60, (second) => ({ health: healthy(second) }));
    expect(new Set(verdicts(findings))).toEqual(new Set(['ok']));
  });

  it('picture-black: the clock runs 3 s while no frame was ever presented, then escalates', () => {
    const watchdog = new Watchdog();
    const findings = run(watchdog, 12, (second) => ({
      health: { framesPresented: 0, audioProgress: second * 1000 },
    }));
    const first = findings.findIndex((finding) => finding.verdict === 'picture-black');
    expect(first).toBe(4);
    expect(findings[first]!.level).toBe('hint');
    const ladder = findings.findIndex((finding) => finding.level === 'ladder');
    expect(ladder * 1000 - findings[first]!.since).toBe(LADDER_AFTER_MS);
  });

  it('picture-black also from readyForDisplay false when frames are unknown', () => {
    const findings = run(new Watchdog(), 8, (second) => ({
      health: { readyForDisplay: false, audioProgress: second },
    }));
    expect(verdicts(findings)).toContain('picture-black');
  });

  it('picture-frozen: frames moved, then stood still while the clock ran; it remembers the last good position', () => {
    const watchdog = new Watchdog();
    const findings = run(watchdog, 15, (second) => ({
      health: { framesPresented: Math.min(second, 5) * 24, audioProgress: second * 1000 },
    }));
    expect(verdicts(findings)).toContain('picture-frozen');
    expect(verdicts(findings)).not.toContain('picture-black');
    expect(watchdog.lastGoodPosition).toBe(5);
  });

  it('audio-silent: the audio counter stands still while the clock and the picture run', () => {
    const findings = run(new Watchdog(), 10, (second) => ({
      health: { framesPresented: second * 24, audioProgress: Math.min(second, 2) * 1000 },
    }));
    expect(verdicts(findings)).toContain('audio-silent');
  });

  it('clock-frozen: the engine says it plays, nothing stalls, the clock stands', () => {
    const findings = run(new Watchdog(), 8, (second) => ({
      position: Math.min(second, 2),
      health: healthy(Math.min(second, 2)),
    }));
    const first = findings.findIndex((finding) => finding.verdict === 'clock-frozen');
    expect(first * 1000).toBeGreaterThanOrEqual(CLOCK_FROZEN_MS + 2000);
    expect(findings[first]!.level).toBe('ladder');
  });

  it('no clock-frozen while the engine clock itself runs (time events lag, D35)', () => {
    const findings = run(new Watchdog(), 10, (second) => ({
      position: 1,
      health: { ...healthy(second), nativePosition: second },
    }));
    expect(verdicts(findings)).not.toContain('clock-frozen');
  });

  it('slideshow: a hint above 30 % dropped frames over 10 s, the ladder above 60 %', () => {
    const at = (share: number) =>
      run(new Watchdog(), 14, (second) => ({
        health: {
          framesPresented: Math.round(second * 24 * (1 - share)),
          framesDropped: Math.round(second * 24 * share),
          audioProgress: second * 1000,
        },
      })).filter((finding) => finding.verdict === 'slideshow');
    expect(at(0.2)).toEqual([]);
    expect(at(0.4).at(-1)).toMatchObject({ level: 'hint', evidence: { percent: 40 } });
    expect(at(0.7).at(-1)).toMatchObject({ level: 'ladder', evidence: { percent: 70 } });
  });

  it('a verdict needs two consecutive ticks', () => {
    // The audio counter stands for exactly 3 s of clock (one tick over the rule), then moves again.
    const findings = run(new Watchdog(), 12, (second) => ({
      health: {
        framesPresented: second * 24,
        audioProgress: (second <= 5 ? Math.min(second, 2) : second) * 1000,
      },
    }));
    expect(verdicts(findings)).not.toContain('audio-silent');
    const held = run(new Watchdog(), 12, (second) => ({
      health: {
        framesPresented: second * 24,
        audioProgress: (second <= 6 ? Math.min(second, 2) : second) * 1000,
      },
    }));
    expect(verdicts(held)).toContain('audio-silent');
  });

  describe('false-positive guards', () => {
    const black = (second: number) => ({ health: { framesPresented: 0, audioProgress: second } });
    it.each<[string, Partial<WatchdogContext>]>([
      ['paused / not wanting playback', { wantsPlayback: false }],
      ['settling after a load, seek or track switch', { settling: true }],
      ['hidden tab / backgrounded app', { visible: false }],
      ['audio-only media', { hasVideo: false }],
    ])('no picture verdict while %s', (_name, context) => {
      expect(verdicts(run(new Watchdog(), 20, black, context))).not.toContain('picture-black');
    });

    it('picture-in-picture keeps only the clock rules', () => {
      const findings = run(new Watchdog(), 20, black, { pictureInPicture: true });
      expect(verdicts(findings)).not.toContain('picture-black');
      const frozen = run(new Watchdog(), 10, () => ({ position: 1 }), { pictureInPicture: true });
      expect(verdicts(frozen)).toContain('clock-frozen');
    });

    it('external playback (AirPlay, Remote Playback) skips picture rules', () => {
      const findings = run(new Watchdog(), 20, (second) => ({
        health: { framesPresented: 0, external: true, audioProgress: second },
      }));
      expect(verdicts(findings)).not.toContain('picture-black');
    });

    it('a stall the engine announced is the stall timeline, not a verdict', () => {
      const findings = run(new Watchdog(), 20, () => ({ position: 5, buffering: true }));
      expect(new Set(verdicts(findings))).toEqual(new Set(['ok']));
    });

    it('unknown counters never guess', () => {
      const findings = run(new Watchdog(), 20, () => ({ health: {} }));
      expect(new Set(verdicts(findings))).toEqual(new Set(['ok']));
    });

    it('very low fps content (a still every 5 s) is not frozen', () => {
      const findings = run(new Watchdog(), 40, (second) => ({
        health: { framesPresented: Math.floor(second / 5), audioProgress: second * 1000 },
      }));
      expect(verdicts(findings)).not.toContain('picture-frozen');
    });

    it('a guard starts every rule over', () => {
      const watchdog = new Watchdog();
      run(watchdog, 3, black);
      run(watchdog, 1, black, { wantsPlayback: false }, 3);
      const after = run(watchdog, 4, black, {}, 4);
      expect(verdicts(after)).not.toContain('picture-black');
    });
  });

  describe('pure black pixels (luma, where readable)', () => {
    // Counters the platform cannot read: only the picture's brightness tells.
    const blind = (luma: number) => (second: number) => ({ position: second, health: { luma } });

    it('from the source load on for 20 s of clock, with nothing moving, is no picture', () => {
      expect(verdicts(run(new Watchdog(), 26, blind(0)))).toContain('picture-black');
      expect(verdicts(run(new Watchdog(), 26, blind(40)))).not.toContain('picture-black');
    });

    it('black with frames or sound moving is black content (overture, black opening), never a verdict (review B1)', () => {
      const frames = run(new Watchdog(), 40, (second) => ({
        health: { ...healthy(second), luma: 0 },
      }));
      expect(verdicts(frames)).not.toContain('picture-black');
      const sound = run(new Watchdog(), 40, (second) => ({
        health: { audioProgress: second * 1000, luma: 0 },
      }));
      expect(verdicts(sound)).not.toContain('picture-black');
    });

    it('black reached by a seek is content: the rule is anchored to the source load, not to the last reset (review B1)', () => {
      const watchdog = new Watchdog();
      run(watchdog, 10, (second) => ({ position: second, health: { luma: 90 } }));
      run(
        watchdog,
        1,
        (second) => ({ position: second, health: { luma: 0 } }),
        { settling: true },
        10
      );
      const after = run(
        watchdog,
        30,
        (second) => ({ position: 1000 + second, health: { luma: 0 } }),
        {},
        11
      );
      expect(verdicts(after)).not.toContain('picture-black');
    });

    it('black that starts after the load is content, even with nothing moving (review B1)', () => {
      const watchdog = new Watchdog();
      run(watchdog, 10, (second) => ({ position: second, health: { luma: 90 } }));
      const later = run(
        watchdog,
        30,
        (second) => ({ position: second, health: { luma: 0 } }),
        {},
        10
      );
      expect(verdicts(later)).not.toContain('picture-black');
    });

    it('only the first minute after the load is judged: a seek past it into the same black says nothing (K08)', () => {
      const watchdog = new Watchdog();
      run(watchdog, 5, blind(0));
      run(
        watchdog,
        1,
        (second) => ({ position: second, health: { luma: 0 } }),
        { settling: true },
        5
      );
      const after = run(
        watchdog,
        6,
        (second) => ({ position: 300 + second, health: { luma: 0 } }),
        {},
        6
      );
      expect(verdicts(after)).not.toContain('picture-black');
    });

    it('a new source starts the minute over', () => {
      const watchdog = new Watchdog();
      run(watchdog, 70, (second) => ({ position: second, health: { luma: 90 } }));
      watchdog.newSource();
      expect(
        verdicts(
          run(watchdog, 26, (second) => ({ position: 70 + second, health: { luma: 0 } }), {}, 70)
        )
      ).toContain('picture-black');
    });
  });
});
