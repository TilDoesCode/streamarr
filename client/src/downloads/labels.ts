import type { TFunction } from 'i18next';

import { describeError, type ErrorText } from '@/api/error-text';
import { formatFileSize } from '@/i18n/format';

import type { OfflineDownload, OfflineDownloadError, OfflineDownloadState } from './types';

const CLIENT_CODES = [
  'disk_full',
  'validator_changed',
  'size_mismatch',
  'file_missing',
  'file_system',
  'network',
  'http',
  'server_unsupported',
  'signed_out',
  'unknown',
] as const;
type ClientCode = (typeof CLIENT_CODES)[number];
const isClientCode = (code: string): code is ClientCode =>
  (CLIENT_CODES as readonly string[]).includes(code);

export function downloadStateLabel(t: TFunction, state: OfflineDownloadState): string {
  return t(`downloads.state.${state}`);
}

/** Title + message of a failed or waiting download (client codes here, server codes via the error catalogue). */
export function downloadErrorText(
  t: TFunction,
  error: OfflineDownloadError,
  lang: string
): ErrorText {
  const code = error.code;
  if (!isClientCode(code)) return describeError(t, error);
  const size = (value: string | undefined) =>
    value && Number.isFinite(Number(value)) ? formatFileSize(Number(value), lang, t) : '–';
  const params = {
    ...error.params,
    needed: size(error.params?.needed),
    available: size(error.params?.available),
    status: error.params?.status ?? String(error.status ?? 0),
  };
  return {
    title: t(`downloads.error.${code}.title`),
    message: t(`downloads.error.${code}.message`, params),
  };
}

/** "S2, E3 · Title" for episodes, the title for movies (falls back when the snapshot is missing). */
export function downloadTitle(t: TFunction, download: OfflineDownload): string {
  if (download.kind === 'movie') return download.meta.title;
  const code = t('media.episodeCode', {
    season: download.seasonNumber ?? 0,
    episode: download.episodeNumber ?? 0,
  });
  return download.meta.title ? `${code} · ${download.meta.title}` : code;
}
