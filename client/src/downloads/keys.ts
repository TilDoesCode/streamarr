import type { Account } from '@/accounts/types';
import { serverKey } from '@/api/server-url';
import { parseWorkId } from '@/lib/work-id';

import type { OfflineDownloadKind } from './types';

/** Owner of a download: server + viewer, so a profile signed out and in again finds its downloads. */
export function downloadAccountKey(account: Pick<Account, 'serverUrl' | 'viewerId'>): string {
  return `${serverKey(account.serverUrl)}#${account.viewerId}`;
}

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1)
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

/** Folder of an account's files under the volume root (path-safe, stable). */
export function accountFolder(accountKey: string): string {
  return `a${fnv(accountKey)}${fnv(`${accountKey}~`)}`;
}

/** Local download id: engine task id and server `clientRef` (≤ 64 printable characters). */
export function newDownloadId(now: number = Date.now()): string {
  const random = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `d${now.toString(36)}${random}`;
}

/** File names as the server sent them, minus anything a file system or path could trip over. */
export function safeFileName(name: string | null | undefined, fallback: string): string {
  const cleaned = (name ?? '')
    .replace(/[/\\?%*:|"<>\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(-120);
  return cleaned || fallback;
}

export function downloadFolder(accountKey: string, id: string): string {
  return `${accountFolder(accountKey)}/${id}`;
}

export function filePathOf(accountKey: string, id: string, fileName: string | null | undefined) {
  return `${downloadFolder(accountKey, id)}/${safeFileName(fileName, `${id}.bin`)}`;
}

export type WorkParts = {
  kind: OfflineDownloadKind;
  seriesId: string | null;
  seasonId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
};

const pad = (value: number) => String(value).padStart(2, '0');

/** Series/season ids and numbers of a movie or episode work id; null for anything else. */
export function workPartsOf(workId: string): WorkParts | null {
  const ref = parseWorkId(workId);
  if (ref?.kind === 'movie')
    return {
      kind: 'movie',
      seriesId: null,
      seasonId: null,
      seasonNumber: null,
      episodeNumber: null,
    };
  if (ref?.kind !== 'episode') return null;
  return {
    kind: 'episode',
    seriesId: `tmdb-tv-${ref.tmdbId}`,
    seasonId: `tmdb-tv-${ref.tmdbId}-s${pad(ref.season)}`,
    seasonNumber: ref.season,
    episodeNumber: ref.episode,
  };
}

/** `tmdb-tv-1396-s02` for any spelling of the season (`-s2`, `-s02`). */
export function normalizeSeasonId(seasonId: string): string {
  const ref = parseWorkId(seasonId);
  return ref?.kind === 'season' ? `tmdb-tv-${ref.tmdbId}-s${pad(ref.season)}` : seasonId;
}
