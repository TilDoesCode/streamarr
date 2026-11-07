/** The server's resume rules (viewer settings, admin-only to read): its defaults apply to local positions too. */
export const RESUME_RULES = {
  minResumePercent: 5,
  playedPercent: 90,
  minResumeDurationSeconds: 300,
  startedAfterSeconds: 120,
} as const;

/** Where a position resumes like the server keeps it: 0 when played, for too short a title or before it counts as started. */
export function resumePointOf(
  seconds: number,
  durationSeconds: number | null | undefined,
  rules = RESUME_RULES
): { seconds: number; played: boolean } {
  const position = Math.max(0, seconds);
  if (!durationSeconds || durationSeconds <= 0) return { seconds: position, played: false };
  const percent = (position * 100) / durationSeconds;
  if (percent >= rules.playedPercent) return { seconds: 0, played: true };
  const started = percent >= rules.minResumePercent || position >= rules.startedAfterSeconds;
  const resumable = durationSeconds >= rules.minResumeDurationSeconds && started;
  return { seconds: resumable ? position : 0, played: false };
}
