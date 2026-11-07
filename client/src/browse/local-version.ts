import type { Version } from '@/browse/queries';
import type { LocalPlayTarget } from '@/downloads';

/** The release ids a download answers to (the picked one and the copy the file came from). */
export function isLocalVersion(
  version: Pick<Version, 'releaseId'>,
  local: Pick<LocalPlayTarget, 'download'> | null | undefined
): boolean {
  if (!local || !version.releaseId) return false;
  return (
    version.releaseId === local.download.releaseId ||
    version.releaseId === local.download.sourceReleaseId
  );
}

/** The downloaded version first (from the server's list, else the download's own description), then the rest. */
export function withLocalFirst(
  versions: readonly Version[],
  local: Pick<LocalPlayTarget, 'download'> | null | undefined
): Version[] {
  if (!local) return [...versions];
  const index = versions.findIndex((version) => isLocalVersion(version, local));
  if (index >= 0) return [versions[index]!, ...versions.filter((_, other) => other !== index)];
  const own = local.download.version;
  return own
    ? [{ ...own, releaseId: own.releaseId ?? local.download.releaseId }, ...versions]
    : [...versions];
}
