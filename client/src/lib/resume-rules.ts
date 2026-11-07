import type { components } from '@/api/schema';

/** When progress is a resume point and when a title counts as played (a server's watch-progress rules, DL-S 8). */
export type ResumeRules = components['schemas']['ViewerResumeRulesDto'];

/** The server's defaults: for a server that never sent its own (an older server, a record never seen online). */
export const DEFAULT_RESUME_RULES: ResumeRules = {
  playedPercent: 90,
  minResumePercent: 5,
  minResumeDurationSeconds: 300,
};

/** Watched time after which a title always counts as started (the server's `StartedAfter`, not a setting). */
const STARTED_AFTER_SECONDS = 120;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A profile's `resume` object; null when the server sends none (older servers) or an unusable one. */
export function resumeRulesOf(value: Partial<ResumeRules> | null | undefined): ResumeRules | null {
  if (!value) return null;
  const { playedPercent, minResumePercent, minResumeDurationSeconds } = value;
  if (!isCount(playedPercent) || !isCount(minResumePercent) || !isCount(minResumeDurationSeconds))
    return null;
  return { playedPercent, minResumePercent, minResumeDurationSeconds };
}

export const sameResumeRules = (a: ResumeRules, b: ResumeRules) =>
  a.playedPercent === b.playedPercent &&
  a.minResumePercent === b.minResumePercent &&
  a.minResumeDurationSeconds === b.minResumeDurationSeconds;

/** Where a position resumes like the server keeps it: 0 when played, for too short a title or before it counts as started. */
export function resumePointOf(
  seconds: number,
  durationSeconds: number | null | undefined,
  rules: ResumeRules = DEFAULT_RESUME_RULES
): { seconds: number; played: boolean } {
  const position = Math.max(0, seconds);
  if (!durationSeconds || durationSeconds <= 0) return { seconds: position, played: false };
  const percent = (position * 100) / durationSeconds;
  if (percent >= rules.playedPercent) return { seconds: 0, played: true };
  const started = percent >= rules.minResumePercent || position >= STARTED_AFTER_SECONDS;
  const resumable = durationSeconds >= rules.minResumeDurationSeconds && started;
  return { seconds: resumable ? position : 0, played: false };
}
