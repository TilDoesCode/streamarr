import { isActiveDownload, STORAGE_RESERVE_BYTES } from './manager';
import type {
  OfflineDownload,
  OfflineLibrary,
  OfflineSeasonGroup,
  OfflineSeriesGroup,
  SpaceVerdict,
  ViewerPolicy,
} from './types';

/** Why this profile may not play a finished download now (age rules, also offline), else null. */
export function lockOf(
  download: OfflineDownload,
  policy: ViewerPolicy | null
): 'age_restricted' | null {
  if (download.error?.code === 'age_restricted') return 'age_restricted';
  if (!policy) return null;
  const age = download.meta.minimumAge;
  if (age === null || age === undefined)
    return download.meta.rated === false && policy.blockUnrated ? 'age_restricted' : null;
  return policy.maxAge !== null && age > policy.maxAge ? 'age_restricted' : null;
}

/** Parked until this profile signs in again (signed out, or its file link was revoked); resumes on its own then. */
export const waitsForSignIn = (download: Pick<OfflineDownload, 'state' | 'error'>) =>
  download.state === 'waiting_server' &&
  (download.error?.code === 'signed_out' || download.error?.code === 'download_revoked');

/** Bytes a download occupies on the device now (the whole file once done, else what arrived). */
export const bytesOnDevice = (download: OfflineDownload) =>
  download.state === 'done' ? (download.sizeBytes ?? download.bytesWritten) : download.bytesWritten;

/** 0–1 while transferring; 1 once done; null before the size is known. */
export function downloadProgress(download: OfflineDownload): number | null {
  if (download.state === 'done') return 1;
  const total = download.sizeBytes ?? download.estimatedBytes;
  return total ? Math.min(1, download.bytesWritten / total) : null;
}

const byTitle = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** One account's downloads grouped like the Downloads screen: series (seasons, episodes) and movies. */
export function groupLibrary(
  accountKey: string | null,
  downloads: readonly OfflineDownload[]
): OfflineLibrary {
  const all = downloads.filter((download) => download.accountKey === accountKey);
  const series = new Map<string, OfflineSeriesGroup>();
  const movies: OfflineDownload[] = [];
  for (const download of all) {
    if (download.kind === 'movie' || !download.seriesId) {
      movies.push(download);
      continue;
    }
    let group = series.get(download.seriesId);
    if (!group) {
      group = {
        seriesId: download.seriesId,
        title: download.meta.seriesTitle || download.meta.title,
        artworkOf: download,
        seasons: [],
        episodeCount: 0,
        bytes: 0,
      };
      series.set(download.seriesId, group);
    }
    if (!group.title && download.meta.seriesTitle) group.title = download.meta.seriesTitle;
    if (!group.artworkOf.artwork.poster && download.artwork.poster) group.artworkOf = download;
    let season: OfflineSeasonGroup | undefined = group.seasons.find(
      (item) => item.seasonId === download.seasonId
    );
    if (!season) {
      season = {
        seasonId: download.seasonId ?? `${download.seriesId}-s00`,
        seasonNumber: download.seasonNumber ?? 0,
        episodes: [],
        bytes: 0,
      };
      group.seasons.push(season);
    }
    season.episodes.push(download);
    season.bytes += bytesOnDevice(download);
    group.episodeCount += 1;
    group.bytes += bytesOnDevice(download);
  }
  const groups = [...series.values()];
  for (const group of groups) {
    group.seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);
    for (const season of group.seasons)
      season.episodes.sort((a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
  }
  groups.sort((a, b) => byTitle(a.title, b.title));
  movies.sort((a, b) => byTitle(a.meta.title, b.meta.title));
  return {
    accountKey,
    all,
    active: all.filter((download) => isActiveDownload(download) || download.state === 'failed'),
    series: groups,
    movies,
    bytes: all.reduce((sum, download) => sum + bytesOnDevice(download), 0),
  };
}

/** Whether `neededBytes` fits next to what is already queued (`availableBytes` = free − committed − reserve). */
export function spaceVerdict(
  neededBytes: number,
  availableBytes: number,
  estimate = false
): SpaceVerdict {
  const needed = Math.max(0, neededBytes);
  const available = Math.max(0, availableBytes);
  return {
    fits: needed <= available,
    neededBytes: needed,
    availableBytes: available,
    missingBytes: Math.max(0, needed - available),
    estimate,
  };
}

/** The verdict while the free space is not known: nothing reads as fitting. */
export function unknownSpace(neededBytes: number, estimate = false): SpaceVerdict {
  const needed = Math.max(0, neededBytes);
  return {
    fits: false,
    neededBytes: needed,
    availableBytes: 0,
    missingBytes: 0,
    estimate,
    unknown: true,
  };
}

/** `availableBytes` from free space and committed bytes (what the manager uses before an enqueue). */
export function availableFrom(freeBytes: number, committedBytes: number): number {
  return Math.max(0, freeBytes - committedBytes - STORAGE_RESERVE_BYTES);
}
