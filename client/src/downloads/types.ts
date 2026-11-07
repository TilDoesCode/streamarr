import type { components } from '@/api/schema';

type Schemas = components['schemas'];
export type DownloadResponse = Schemas['DownloadResponse'];
export type DownloadListResponse = Schemas['DownloadListResponse'];
export type DownloadPrepareRequest = Schemas['DownloadPrepareRequest'];
export type DownloadCandidate = Schemas['DownloadCandidateDto'];
export type DownloadCandidatesResponse = Schemas['DownloadCandidatesResponse'];
export type DownloadPack = Schemas['DownloadPackDto'];
export type DownloadSeasonEpisode = Schemas['DownloadSeasonEpisodeDto'];
export type DownloadSeasonCandidatesResponse = Schemas['DownloadSeasonCandidatesResponse'];
export type DownloadPlanItem = Schemas['DownloadPlanItemDto'];
export type DownloadPlanResponse = Schemas['DownloadPlanResponse'];
export type DownloadMediaInfo = Schemas['PlaybackMediaInfoDto'];
export type DownloadVersion = Schemas['VersionDto'];

/** queued → preparing → downloading ⇄ paused / waiting_* → verifying → done | failed (downloads-plan.html § 7). */
export type OfflineDownloadState =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'paused'
  | 'waiting_wifi'
  | 'waiting_network'
  | 'waiting_server'
  | 'waiting_space'
  /** The removable storage the download is on is not mounted; it continues when it returns. */
  | 'waiting_volume'
  | 'verifying'
  | 'done'
  | 'failed'
  /** Being deleted (engine task, files, record; the server record follows from an outbox): no actions, no counts. */
  | 'removing';

export type OfflineDownloadKind = 'movie' | 'episode';
/** The in-app engine that plays the file as it is (never Streamybox, never the server). */
export type OfflineEngine = 'native' | 'vlc';

/** Why a download failed or waits: a server code (docs/api.md § 14) or the client's own (`disk_full`, `file_missing`, …). */
export type OfflineDownloadError = {
  code: string;
  params?: Record<string, string>;
  /** Server suggestions on a failed preparation: `retry`, `otherVersion`. */
  actions?: string[];
  /** HTTP status when the failure was an answer (0 = no answer). */
  status?: number;
  at: number;
};

/** What the offline shell and the player show without the server. */
export type OfflineMetadata = {
  /** Movie title, or the episode title (falls back to "S1 E2" in the UI). */
  title: string;
  seriesTitle?: string | null;
  overview?: string | null;
  runtimeMinutes?: number | null;
  year?: number | null;
  /** Artwork tint (design token key or hex the server sent), for placeholders and ambient light. */
  tint?: string | null;
  /** Age rating as the server shows it (e.g. `FSK 12`, `TV-14`). */
  certification?: string | null;
  genres?: string[] | null;
  seriesOverview?: string | null;
  /** The age gate's minimum age of the work (null = unrated or unknown). */
  minimumAge?: number | null;
  /** False when the work has no rating (an unrated block applies). */
  rated?: boolean;
  /** The age gate answered for this work (`minimumAge`/`rated` are its verdict); false or missing = not known. */
  accessVerified?: boolean;
  /** When that verdict was read (ms); an old one is checked again before a restricted profile plays the file. */
  accessCheckedAt?: number | null;
};

/** The viewer's last known download and age permissions (kept for offline use). */
export type ViewerPolicy = {
  /** Highest allowed minimum age; null = unrestricted. */
  maxAge: number | null;
  blockUnrated: boolean;
  allowDownloads: boolean;
  at: number;
};

/** Artwork files next to the download (relative to the engine volume root); resolve with `artworkUri`. */
export type OfflineArtwork = {
  poster?: string | null;
  backdrop?: string | null;
  /** Episode still. */
  still?: string | null;
  logo?: string | null;
};

export type OfflineDownload = {
  /** Local id: engine task id and the server `clientRef` (≤ 64 printable characters). */
  id: string;
  /** Owner: `downloadAccountKey(account)` (server + viewer), stable across sign-out and sign-in. */
  accountKey: string;
  /** Server record (`POST /viewer/downloads`); null until the preparation was accepted. */
  downloadId: string | null;
  /** Server preparation stage while `preparing`: `queued`, `resolving`, `probing` (else null). */
  serverState: string | null;
  workId: string;
  kind: OfflineDownloadKind;
  /** Series work id (`tmdb-tv-1396`), season work id (`tmdb-tv-1396-s02`) and numbers; null for movies. */
  seriesId: string | null;
  seasonId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  /** The version the viewer picked. */
  releaseId: string;
  /** The release the file comes from (another copy of the picked one after a server fallback). */
  sourceReleaseId: string | null;
  /** The version as the candidates/ready answer described it (spec chips, release name). */
  version: DownloadVersion | null;
  /** Saved once ready: the engine that plays the file here. */
  engine: OfflineEngine | null;
  /** Tracks of the file (audio/subtitle switching without the server). */
  mediaInfo: DownloadMediaInfo | null;
  fileName: string | null;
  container: string | null;
  /** Under the engine volume root; never an absolute URI (iOS container paths change). */
  relativePath: string | null;
  volumeId: string;
  etag: string | null;
  /** Exact bytes once the server prepared the file. */
  sizeBytes: number | null;
  /** The candidate's size (exact or estimated) until then. */
  estimatedBytes: number | null;
  bytesWritten: number;
  state: OfflineDownloadState;
  error: OfflineDownloadError | null;
  /** Epoch ms of the next automatic attempt while waiting. */
  retryAt: number | null;
  /** Restarts from 0 after the file changed (validator/size); a second one fails. */
  restarts: number;
  /** A restart a Pause, removal or sign-out interrupted (its reason): the next Resume finishes it. */
  restartReason?: string | null;
  /** When the file capability expires unless renewed (ISO). */
  expiresAt: string | null;
  /** The server acknowledged `POST …/complete`. */
  serverCompleted: boolean;
  meta: OfflineMetadata;
  artwork: OfflineArtwork;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

/** What `downloads.start` needs per movie/episode. */
export type DownloadRequestItem = {
  workId: string;
  releaseId: string;
  /** For the size before the server prepared the file and for the version chips meanwhile. */
  candidate?: Pick<DownloadCandidate, 'sizeBytes' | 'version'> | null;
  /** `auto` (default), `native` or `vlc`. */
  engine?: 'auto' | 'native' | 'vlc';
  /** Known metadata (saves a catalog request); the manager completes the snapshot itself. */
  meta?: Partial<OfflineMetadata>;
};

export type DownloadSettings = {
  /** Default true: transfers only on unmetered networks. */
  wifiOnly: boolean;
  /** Default 2 (1–6). */
  maxConcurrent: number;
  /** Default false: delete a download once it was watched to the end. */
  deleteWatched: boolean;
};

/** The viewer's last position of a downloaded work on this device. */
export type LocalPosition = {
  seconds: number;
  durationSeconds: number | null;
  /** Epoch ms of the report on the server's clock: online the newer of local and server wins. */
  at: number;
  played: boolean;
  /** `at` is an estimate (no clock anchor of this boot), off by up to `uncertaintyMs`. */
  estimated?: boolean;
  uncertaintyMs?: number;
  /** The viewer started over or seeked in that playback: the smaller position is meant. */
  restarted?: boolean;
};

export type OfflineSeasonGroup = {
  seasonId: string;
  seasonNumber: number;
  episodes: OfflineDownload[];
  bytes: number;
};

export type OfflineSeriesGroup = {
  seriesId: string;
  title: string;
  /** The first episode with artwork lends the series its poster/backdrop. */
  artworkOf: OfflineDownload;
  seasons: OfflineSeasonGroup[];
  episodeCount: number;
  bytes: number;
};

/** One account's downloads, grouped like the Downloads screen (Series → Season → Episode, then movies). */
export type OfflineLibrary = {
  accountKey: string | null;
  all: OfflineDownload[];
  /** Not done yet (queued … verifying, failed), oldest first. */
  active: OfflineDownload[];
  series: OfflineSeriesGroup[];
  movies: OfflineDownload[];
  /** Bytes on the device (done files plus partial ones). */
  bytes: number;
};

export type SpaceVerdict = {
  fits: boolean;
  neededBytes: number;
  /** Free minus what queued downloads still need minus a reserve. */
  availableBytes: number;
  /** 0 when it fits. */
  missingBytes: number;
  /** The size is an estimate (indexer/pack share): the exact one comes with the preparation. */
  estimate: boolean;
  /** The free space is not known (yet): `fits` is false, the UI shows a pending state, not a verdict. */
  unknown?: boolean;
};

export type DownloadStorage = {
  freeBytes: number;
  totalBytes: number;
  /** Streamarr downloads on this device (every profile). */
  usedBytes: number;
  /** Everything else on the volume. */
  otherBytes: number;
  /** Bytes queued and running downloads still need. */
  committedBytes: number;
  /** What a new download may use (free − committed − reserve). */
  availableBytes: number;
};

export type DownloadsSupport =
  | { supported: true; reason: null }
  | { supported: false; reason: 'platform' | 'engine' | 'permission' | 'signed_out' };

/** What Play/Resume starts when a finished download exists (also online). */
export type LocalPlayTarget = {
  download: OfflineDownload;
  /** `file://` resolved now (never stored). */
  uri: string;
  engine: OfflineEngine;
  mediaInfo: DownloadMediaInfo | null;
  /** Local position (seconds) if any; the player still compares it with the server's when online. */
  position: LocalPosition | null;
};
