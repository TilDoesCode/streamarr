import { unwrap, type ApiClient } from '@/api/client';
import type { components } from '@/api/schema';
import { parseWorkId } from '@/lib/work-id';

import type {
  DownloadListResponse,
  DownloadPrepareRequest,
  DownloadResponse,
  OfflineMetadata,
  ViewerPolicy,
} from './types';

type Sizes = components['schemas']['ArtworkSizesDto'] | null | undefined;

/** Remote artwork of a work (absolute URLs, no auth) the snapshot copies next to the file. */
export type ArtworkUrls = {
  poster?: string | null;
  backdrop?: string | null;
  still?: string | null;
  logo?: string | null;
};

export type WorkSnapshot = { meta: OfflineMetadata; artwork: ArtworkUrls };

/** The server calls of one account the manager needs (docs/api.md § 14). */
export type DownloadsServerApi = {
  /** Origin the relative `fileUrl` hangs off. */
  baseUrl: string;
  prepare(body: DownloadPrepareRequest): Promise<DownloadResponse>;
  get(
    downloadId: string,
    options?: { waitMs?: number; deviceId?: string; signal?: AbortSignal }
  ): Promise<DownloadResponse>;
  list(deviceId: string): Promise<DownloadListResponse>;
  renew(downloadId: string, deviceId?: string): Promise<DownloadResponse>;
  complete(downloadId: string, bytesReceived: number): Promise<DownloadResponse>;
  remove(downloadId: string): Promise<void>;
  /** The viewer's download and age permissions (`/viewer/me`). */
  policy(): Promise<ViewerPolicy>;
  /** Metadata + artwork URLs for the offline snapshot. */
  snapshot(workId: string): Promise<WorkSnapshot>;
  /** The age gate's verdict of a work (rejects when the server cannot say). */
  access(workId: string): Promise<Partial<OfflineMetadata>>;
};

const pick = (sizes: Sizes, size: 'small' | 'medium' | 'large', fallback?: string | null) =>
  sizes?.[size] ?? fallback ?? null;

type Permissions = components['schemas']['ViewerPermissionsDto'];

/** The parts of the viewer's permissions downloads keep for offline use. */
export function policyOf(permissions: Permissions | null, at: number): ViewerPolicy {
  return {
    maxAge: permissions?.maxAge ?? null,
    blockUnrated: permissions?.blockUnrated ?? false,
    allowDownloads: permissions?.allowDownloads ?? true,
    at,
  };
}

/** The age gate's verdict of a work (`minimumAge`, rated or not); throws when the server cannot say. */
export async function fetchAccessVerdict(
  client: ApiClient,
  workId: string,
  now = Date.now()
): Promise<Partial<OfflineMetadata>> {
  const access = await unwrap(
    client.GET('/api/v1/viewer/access/{workId}', { params: { path: { workId } } })
  );
  return { ...verdictOf(access.reason, access.minimumAge ?? null), accessCheckedAt: now };
}

/** What an access answer says about the title (§ 13); an answer that names no rating is no verdict. */
export function verdictOf(
  reason: string | null | undefined,
  minimumAge: number | null
): Pick<OfflineMetadata, 'minimumAge' | 'rated' | 'accessVerified' | 'accessReason'> {
  const accessReason = reason ?? null;
  switch (reason) {
    case 'within_age_limit':
    case 'above_age_limit':
      return { minimumAge, rated: true, accessVerified: true, accessReason };
    case 'unrated_allowed':
    case 'unrated_blocked':
      return { minimumAge: null, rated: false, accessVerified: true, accessReason };
    // The server cannot rate it (TMDB does not know the title): unknown, asked again like a failure.
    case 'rating_unavailable':
      return { minimumAge: null, rated: false, accessVerified: false, accessReason };
    // Checked without age rules: a known rating holds for any profile, a missing one says nothing.
    default:
      return minimumAge === null
        ? { minimumAge: null, accessVerified: false, accessReason }
        : { minimumAge, rated: true, accessVerified: true, accessReason };
  }
}

/** The verdict, or nothing when the server cannot say (the record stays unverified). */
const ageOf = (client: ApiClient, workId: string) =>
  fetchAccessVerdict(client, workId).catch(() => ({}) as Partial<OfflineMetadata>);

export async function fetchWorkSnapshot(client: ApiClient, workId: string): Promise<WorkSnapshot> {
  const snapshot = await fetchCatalogSnapshot(client, workId);
  return { ...snapshot, meta: { ...snapshot.meta, ...(await ageOf(client, workId)) } };
}

async function fetchCatalogSnapshot(client: ApiClient, workId: string): Promise<WorkSnapshot> {
  const ref = parseWorkId(workId);
  if (ref?.kind === 'movie') {
    const movie = await unwrap(
      client.GET('/api/v1/viewer/catalog/movies/{tmdbId}', {
        params: { path: { tmdbId: ref.tmdbId } },
      })
    );
    return {
      meta: {
        title: movie.title ?? '',
        overview: movie.overview,
        runtimeMinutes: movie.runtimeMinutes,
        year: movie.year,
        tint: movie.tint,
        certification: movie.certification,
        genres: movie.genres ?? null,
      },
      artwork: {
        poster: pick(movie.posterSizes, 'medium', movie.posterUrl),
        backdrop: pick(movie.backdropSizes, 'large', movie.backdropUrl),
        logo: movie.logoUrl,
      },
    };
  }
  if (ref?.kind !== 'episode') throw new Error(`not a movie or episode: ${workId}`);
  const [series, season] = await Promise.all([
    unwrap(
      client.GET('/api/v1/viewer/catalog/series/{tmdbId}', {
        params: { path: { tmdbId: ref.tmdbId } },
      })
    ),
    unwrap(
      client.GET('/api/v1/viewer/catalog/series/{tmdbId}/seasons/{seasonNumber}', {
        params: { path: { tmdbId: ref.tmdbId, seasonNumber: ref.season } },
      })
    ),
  ]);
  const episode = (season.episodes ?? []).find((item) => item.episodeNumber === ref.episode);
  return {
    meta: {
      title: episode?.title ?? '',
      seriesTitle: series.title ?? season.seriesTitle,
      overview: episode?.overview,
      seriesOverview: series.overview,
      runtimeMinutes: episode?.runtimeMinutes ?? series.runtimeMinutes,
      year: series.year,
      tint: season.tint ?? series.tint,
      certification: series.certification,
      genres: series.genres ?? null,
    },
    artwork: {
      poster:
        pick(season.posterSizes, 'medium', season.posterUrl) ??
        pick(series.posterSizes, 'medium', series.posterUrl),
      backdrop: pick(series.backdropSizes, 'large', series.backdropUrl),
      still: pick(episode?.stillSizes, 'medium', episode?.stillUrl),
      logo: series.logoUrl,
    },
  };
}

export function createDownloadsServerApi(client: ApiClient, baseUrl: string): DownloadsServerApi {
  return {
    baseUrl,
    prepare: (body) => unwrap(client.POST('/api/v1/viewer/downloads', { body })),
    get: (downloadId, { waitMs, deviceId, signal } = {}) =>
      unwrap(
        client.GET('/api/v1/viewer/downloads/{downloadId}', {
          params: { path: { downloadId }, query: { waitMs, deviceId } },
          signal,
        })
      ),
    list: (deviceId) =>
      unwrap(
        client.GET('/api/v1/viewer/downloads', {
          params: { query: { device: 'this', deviceId } },
        })
      ),
    renew: (downloadId, deviceId) =>
      unwrap(
        client.POST('/api/v1/viewer/downloads/{downloadId}/renew', {
          params: { path: { downloadId }, query: deviceId ? { deviceId } : undefined },
        })
      ),
    complete: (downloadId, bytesReceived) =>
      unwrap(
        client.POST('/api/v1/viewer/downloads/{downloadId}/complete', {
          params: { path: { downloadId } },
          body: { bytesReceived },
        })
      ),
    remove: async (downloadId) => {
      await unwrap(
        client.DELETE('/api/v1/viewer/downloads/{downloadId}', {
          params: { path: { downloadId } },
        })
      );
    },
    policy: async () =>
      policyOf((await unwrap(client.GET('/api/v1/viewer/me'))).permissions ?? null, Date.now()),
    snapshot: (workId) => fetchWorkSnapshot(client, workId),
    access: (workId) => fetchAccessVerdict(client, workId),
  };
}
