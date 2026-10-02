import type { Version } from '@/browse/queries';
import { predictedMethod, type PredictedMethod } from '@/browse/version-format';

export type PlayAction = 'play' | 'resume' | 'restart';

type WatchLike = { lastReleaseId?: string | null } | null | undefined;

export type PlayTarget =
  | { state: 'loading' | 'error' | 'none' }
  | {
      state: 'ready';
      version: Version;
      method: PredictedMethod;
      /** Sent with the play call; undefined lets the server start its recommendation (Play, as before). */
      releaseId?: string;
      /** The version is the one the viewer played last. */
      isLastPlayed: boolean;
      /** Resume: the last played version is no longer offered, so the recommendation starts. */
      lastPlayedMissing: boolean;
      /** A version that plays direct here when the target does not ("Direct possible: 1080p WEB-DL"). */
      directAlternative?: Version;
    };

/** The recommended version (else rank 1, else the first). */
export function recommendedVersion(versions: readonly Version[]): Version | undefined {
  return (
    versions.find((version) => version.recommended) ??
    [...versions].sort((a, b) => a.rank - b.rank)[0]
  );
}

/** The one rule which version Play / Resume / Start over start; the chip row shows the same target. */
export function playTarget(
  versions: readonly Version[] | undefined,
  watch: WatchLike,
  action: PlayAction,
  failed = false
): PlayTarget {
  if (!versions) return { state: failed ? 'error' : 'loading' };
  if (!versions.length) return { state: 'none' };
  const recommended = recommendedVersion(versions)!;
  const lastId = watch?.lastReleaseId ?? undefined;
  const last = lastId ? versions.find((version) => version.releaseId === lastId) : undefined;
  const lastPlayable = !!last && (predictedMethod(last) ?? 'unknown') !== 'unknown';
  // Start over plays what the viewer chose before, like Resume.
  const useLast = action !== 'play' && lastPlayable;
  const version = useLast ? last! : recommended;
  const method = predictedMethod(version) ?? 'unknown';
  const directAlternative =
    method === 'direct' || method === 'vlc'
      ? undefined
      : versions.find(
          (other) =>
            other !== version &&
            predictedMethod(other) === 'direct' &&
            height(other) >= height(version)
        );
  return {
    state: 'ready',
    version,
    method,
    releaseId: useLast ? (version.releaseId ?? undefined) : undefined,
    isLastPlayed: !!lastId && version.releaseId === lastId,
    lastPlayedMissing: action !== 'play' && !!lastId && !last,
    directAlternative,
  };
}

// "2160p" / "4K" → 2160; unknown → 0. A lower-resolution direct version is no better choice.
function height(version: Version): number {
  const resolution = version.resolution ?? '';
  if (/^(4k|uhd)/i.test(resolution)) return 2160;
  return Number.parseInt(resolution, 10) || 0;
}
