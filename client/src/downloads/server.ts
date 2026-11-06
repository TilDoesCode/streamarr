import { unwrap, type ApiClient } from '@/api/client';
import type { components } from '@/api/schema';
import { parseWorkId } from '@/lib/work-id';

import type {
  DownloadListResponse,
  DownloadPrepareRequest,
  DownloadResponse,
  OfflineMetadata,
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

/** `status` 0 = no answer (transport failure). */
export type FileStatus = { status: number; code: string | null };

const FILE_PROBE_TIMEOUT_MS = 8_000;

/** One byte of the file (no auth: the capability is the credential); an error answer carries `error.code`. */
export async function probeFile(url: string, fetcher: typeof fetch = fetch): Promise<FileStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_PROBE_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      headers: { Range: 'bytes=0-0', Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.ok) return { status: response.status, code: null };
    const body = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    const code = body?.error?.code;
    return { status: response.status, code: typeof code === 'string' ? code : null };
  } catch {
    return { status: 0, code: null };
  } finally {
    clearTimeout(timer);
  }
}

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
  renew(downloadId: string): Promise<DownloadResponse>;
  complete(downloadId: string, bytesReceived: number): Promise<DownloadResponse>;
  remove(downloadId: string): Promise<void>;
  /** What the file URL answers right now and the server's error code (the engine only reports the status). */
  fileStatus(url: string): Promise<FileStatus>;
  /** Metadata + artwork URLs for the offline snapshot. */
  snapshot(workId: string): Promise<WorkSnapshot>;
};

const pick = (sizes: Sizes, size: 'small' | 'medium' | 'large', fallback?: string | null) =>
  sizes?.[size] ?? fallback ?? null;

export async function fetchWorkSnapshot(client: ApiClient, workId: string): Promise<WorkSnapshot> {
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
    renew: (downloadId) =>
      unwrap(
        client.POST('/api/v1/viewer/downloads/{downloadId}/renew', {
          params: { path: { downloadId } },
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
    fileStatus: (url) => probeFile(url),
    snapshot: (workId) => fetchWorkSnapshot(client, workId),
  };
}
