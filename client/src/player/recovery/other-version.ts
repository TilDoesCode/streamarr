import type { DeviceProfile } from '@modules/media-caps';

import { unwrap, type ApiClient } from '@/api/client';
import type { components } from '@/api/schema';
import { versionHints } from '@/player/device-profile';

type Version = components['schemas']['VersionDto'];

/** The best other version this device can play (server rank, predicted method known), never one already tried. */
export function pickOtherVersion(
  versions: readonly Version[],
  tried: ReadonlySet<string>
): string | null {
  const playable = versions.filter(
    (version) =>
      !!version.releaseId &&
      !tried.has(version.releaseId) &&
      !!version.predictedMethod &&
      version.predictedMethod !== 'unknown'
  );
  return [...playable].sort((a, b) => a.rank - b.rank)[0]?.releaseId ?? null;
}

/** Ladder step V: asks the server for the work's versions with this device's hints. */
export async function nextVersion(
  client: ApiClient,
  workId: string,
  profile: DeviceProfile,
  tried: ReadonlySet<string>,
  signal: AbortSignal
): Promise<string | null> {
  const response = await unwrap(
    client.GET('/api/v1/viewer/catalog/works/{workId}/versions', {
      // A device without a measured profile asks without hints (no predictions, so nothing qualifies).
      params: { path: { workId }, query: profile.engines ? versionHints(profile) : undefined },
      signal,
    })
  );
  return pickOtherVersion(response.versions ?? [], tried);
}
