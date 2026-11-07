// Public surface of the download core (DL-C1) for screens and DL-C2; the engine stays behind `@/downloads/engine`.
export type * from './types';
export { downloadAccountKey, normalizeSeasonId, workPartsOf } from './keys';
export { allowedAgain, BLOCKED_CODES, isBlockedDownload } from './blocked';
export {
  isActiveDownload,
  isPrepared,
  remainingBytes,
  DownloadManager,
  MAX_PREPARING,
  PLAYED_FRACTION,
  STORAGE_RESERVE_BYTES,
} from './manager';
export {
  blockedBy,
  bytesOnDevice,
  downloadProgress,
  groupLibrary,
  spaceVerdict,
  volumeMissing,
  waitsForSignIn,
} from './library';
export { downloadErrorText, downloadStateLabel, downloadTitle } from './labels';
export { nextDownloadedEpisode, resolveLocalPlayTarget, resumeSecondsOf } from './local-play';
export {
  DownloadsProvider,
  getDownloadManager,
  notificationTitle,
  useOptionalDownloadsContext,
} from './provider';
export {
  useAccountDownloads,
  useActiveDownloadAccountKey,
  useActiveDownloadCount,
  useArtworkUri,
  useDownloadActions,
  useDownloadFor,
  useDownloads,
  useDownloadSettings,
  useDownloadsSnapshot,
  useOptionalDownloadsSnapshot,
  useDownloadStorage,
  useDownloadsSupported,
  useLocalPlayTarget,
  useSeasonDownloads,
  type AccountDownloadsSummary,
  type DownloadActions,
  type DownloadForWork,
  type DownloadSettingsApi,
  type SeasonDownloads,
} from './hooks';
export {
  useDownloadCandidates,
  useDownloadPlan,
  useDownloadSpace,
  useSeasonDownloadCandidates,
  type CandidateWithSpace,
  type DownloadCandidatesView,
  type DownloadPlanView,
  type PackWithSpace,
  type SeasonCandidatesView,
  type SpaceCheck,
} from './candidates';
