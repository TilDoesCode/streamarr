import type { DownloadEngine } from '@/downloads/engine';
import { parseWorkId } from '@/lib/work-id';

import { lockOf } from './library';
import type { DownloadManager } from './manager';
import { getDownloadEngine, getDownloadManager } from './provider';
import type { LocalPlayTarget, LocalPosition, OfflineDownload } from './types';

/** The finished download Play/Resume starts (also online); `releaseId` = an explicit other version, which streams. */
export function resolveLocalPlayTarget(
  workId: string,
  accountKey: string,
  manager: DownloadManager | null = getDownloadManager(),
  engine: DownloadEngine = getDownloadEngine(),
  releaseId?: string | null
): LocalPlayTarget | null {
  if (!manager || !engine.isSupported) return null;
  const download = manager.store
    .forAccount(accountKey)
    .find((item) => item.workId === workId && item.state === 'done');
  if (!download?.relativePath || !download.engine) return null;
  if (lockOf(download, manager.store.policy(accountKey))) return null;
  if (releaseId && releaseId !== download.releaseId && releaseId !== download.sourceReleaseId)
    return null;
  try {
    return {
      download,
      uri: engine.uriFor(download.relativePath, download.volumeId),
      engine: download.engine,
      mediaInfo: download.mediaInfo,
      position: manager.store.position(accountKey, workId),
    };
  } catch {
    return null;
  }
}

/** `resolveLocalPlayTarget` after checking the file on disk (exists, full size); a missing file fails the record. */
export async function checkLocalPlayTarget(
  workId: string,
  accountKey: string,
  manager: DownloadManager | null = getDownloadManager(),
  engine: DownloadEngine = getDownloadEngine(),
  releaseId?: string | null
): Promise<LocalPlayTarget | null> {
  const target = resolveLocalPlayTarget(workId, accountKey, manager, engine, releaseId);
  if (!target || !manager) return target;
  return (await manager.verifyLocalFile(target.download.id)) ? target : null;
}

/** Seconds to start a local playback at: the newer of the local position and the server's (by time). */
export function resumeSecondsOf(
  local: LocalPosition | null,
  server: { seconds: number; at: number | null } | null
): number {
  const localSeconds = local && !local.played ? local.seconds : 0;
  if (!server || server.at === null) return localSeconds;
  if (!local || server.at > local.at) return server.seconds;
  return localSeconds;
}

const order = (download: OfflineDownload) =>
  (download.seasonNumber ?? 0) * 10_000 + (download.episodeNumber ?? 0);

/** Offline up-next: the next finished download of the same series after `workId` (null at the end). */
export function nextDownloadedEpisode(
  workId: string,
  accountKey: string,
  manager: DownloadManager | null = getDownloadManager()
): OfflineDownload | null {
  const ref = parseWorkId(workId);
  if (!manager || ref?.kind !== 'episode') return null;
  const seriesId = `tmdb-tv-${ref.tmdbId}`;
  const current = ref.season * 10_000 + ref.episode;
  return (
    manager.store
      .forAccount(accountKey)
      .filter(
        (download) =>
          download.seriesId === seriesId && download.state === 'done' && order(download) > current
      )
      .sort((a, b) => order(a) - order(b))[0] ?? null
  );
}
