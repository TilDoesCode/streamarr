/** Playback clock `m:ss` or `h:mm:ss`. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Hold-scrub step for a held ◀/▶ key: accelerates with the key-repeat count. */
export function scrubStep(direction: -1 | 1, repeat: number): number {
  const base = direction < 0 ? 10 : 30;
  if (repeat <= 0) return direction * base;
  if (repeat < 8) return direction * 10;
  if (repeat < 20) return direction * 30;
  if (repeat < 40) return direction * 60;
  return direction * 120;
}

/** Episode code parsed from a canonical episode work id (`tmdb-tv-1396-s01e02`). */
export function parseEpisodeWorkId(
  workId: string
): { tmdbId: number; season: number; episode: number } | null {
  const match = /^tmdb-tv-(\d+)-s(\d+)e(\d+)$/.exec(workId);
  if (!match) return null;
  return { tmdbId: Number(match[1]), season: Number(match[2]), episode: Number(match[3]) };
}
