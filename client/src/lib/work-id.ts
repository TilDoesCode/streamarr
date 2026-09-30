/** A work id of the catalog: `tmdb-movie-603`, `tmdb-tv-1399`, `tmdb-tv-1399-s01`, `tmdb-tv-1399-s01e02`. */
export type WorkRef =
  | { kind: 'movie'; tmdbId: number }
  | { kind: 'series'; tmdbId: number }
  | { kind: 'season'; tmdbId: number; season: number }
  | { kind: 'episode'; tmdbId: number; season: number; episode: number };

const PATTERN = /^tmdb-(movie|tv)-(\d+)(?:-s(\d+)(?:e(\d+))?)?$/;

export function parseWorkId(workId: string | null | undefined): WorkRef | undefined {
  const match = workId ? PATTERN.exec(workId) : null;
  if (!match) return undefined;
  const tmdbId = Number(match[2]);
  if (match[1] === 'movie') return match[3] === undefined ? { kind: 'movie', tmdbId } : undefined;
  if (match[3] === undefined) return { kind: 'series', tmdbId };
  const season = Number(match[3]);
  if (match[4] === undefined) return { kind: 'season', tmdbId, season };
  return { kind: 'episode', tmdbId, season, episode: Number(match[4]) };
}
