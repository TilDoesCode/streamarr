import type { TFunction } from 'i18next';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { Account } from '@/accounts/types';
import { unwrap, type ApiClient } from '@/api/client';
import { useOptionalDownloadsSnapshot } from '@/downloads/hooks';
import { downloadAccountKey } from '@/downloads/keys';
import { lockOf } from '@/downloads/library';
import {
  nextDownloadedEpisode,
  resolveLocalPlayTarget,
  resumeSecondsOf,
} from '@/downloads/local-play';
import type { DownloadEngine } from '@/downloads/engine';
import type { DownloadManager } from '@/downloads/manager';
import {
  getDownloadEngine,
  getDownloadManager,
  useOptionalDownloadsContext,
} from '@/downloads/provider';
import type { OfflineDownload } from '@/downloads/types';
import type { LocalSource } from '@/player/controller-types';
import { TICKS_PER_SECOND } from '@/player/playback-api';

import type { NextEpisode } from './up-next';

/** The server's position of a work and when it was saved (null when it cannot be asked within `timeoutMs`). */
async function serverPosition(
  client: ApiClient,
  workId: string,
  timeoutMs = 2_500
): Promise<{ seconds: number; at: number | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [state] = await unwrap(
      client.POST('/api/v1/viewer/watch/state', {
        body: { workIds: [workId] },
        signal: controller.signal,
      })
    );
    if (!state) return null;
    const at = state.lastPlayedAt ? Date.parse(state.lastPlayedAt) : NaN;
    return {
      seconds: state.played ? 0 : (state.positionTicks ?? 0) / TICKS_PER_SECOND,
      at: Number.isFinite(at) ? at : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What a start plays: the download, a stream (no usable download, online), or a card (offline, missing or locked). */
export type LocalStart =
  | { kind: 'local'; source: LocalSource }
  | { kind: 'stream'; notice?: 'downloadMissing' }
  | { kind: 'missing' | 'locked'; downloadId: string };

/** A finished download is the default start of its work (also online); an explicitly picked other version streams. */
export async function prepareLocalSource(input: {
  workId: string;
  releaseId?: string;
  account: Account;
  client: ApiClient;
  offline: () => boolean;
  manager?: DownloadManager | null;
  engine?: DownloadEngine;
}): Promise<LocalStart> {
  const manager = input.manager ?? getDownloadManager();
  const accountKey = downloadAccountKey(input.account);
  const offline = input.offline();
  const releaseId = offline ? undefined : input.releaseId;
  const download = manager?.store
    .forAccount(accountKey)
    .find(
      (item) =>
        item.workId === input.workId &&
        item.state === 'done' &&
        (!releaseId || releaseId === item.releaseId || releaseId === item.sourceReleaseId)
    );
  if (!manager || !download) return { kind: 'stream' };
  if (lockOf(download, manager.store.policy(accountKey)))
    return offline ? { kind: 'locked', downloadId: download.id } : { kind: 'stream' };
  if (!(await manager.verifyLocalFile(download.id)))
    return offline
      ? { kind: 'missing', downloadId: download.id }
      : { kind: 'stream', notice: 'downloadMissing' };
  const target = resolveLocalPlayTarget(
    input.workId,
    accountKey,
    manager,
    input.engine ?? getDownloadEngine(),
    releaseId
  );
  if (!target) return { kind: 'stream' };
  const server = offline ? null : await serverPosition(input.client, input.workId);
  return {
    kind: 'local',
    source: {
      downloadId: target.download.id,
      uri: target.uri,
      engine: target.engine,
      mediaInfo: target.mediaInfo,
      version: target.download.version,
      releaseId: target.download.sourceReleaseId ?? target.download.releaseId,
      resumeSeconds: resumeSecondsOf(target.position, server),
      offline: input.offline,
      release: manager.holdFile(target.download.id),
    },
  };
}

/** Saves the position of a work this profile downloaded (the local position store, also for streamed plays). */
export function recordDownloadedPosition(
  account: Account,
  workId: string,
  seconds: number,
  durationSeconds: number
): void {
  const manager = getDownloadManager();
  const accountKey = downloadAccountKey(account);
  if (!manager?.store.forAccount(accountKey).some((download) => download.workId === workId)) return;
  manager.recordPosition(accountKey, workId, seconds, durationSeconds || null);
}

function nextOf(t: TFunction, download: OfflineDownload): NextEpisode {
  const code: string = t('media.episodeCode', {
    season: download.seasonNumber ?? 0,
    episode: download.episodeNumber ?? 0,
  });
  const title =
    download.meta.title || t('media.episodeNumber', { episode: download.episodeNumber ?? 0 });
  return {
    workId: download.workId,
    title: download.meta.title ? `${code} · ${download.meta.title}` : code,
    playTitle: t('detail.episodeTitle', { series: download.meta.seriesTitle ?? '', code, title }),
  };
}

/** Offline up-next: the next finished download of the series, following the downloads as they change. */
export function useOfflineNextEpisode(workId: string, account: Account): NextEpisode | null {
  const { t } = useTranslation();
  const downloads = useOptionalDownloadsContext();
  const all = useOptionalDownloadsSnapshot();
  return useMemo(() => {
    if (!downloads || !all.length) return null;
    const next = nextDownloadedEpisode(workId, downloadAccountKey(account), downloads.manager);
    return next ? nextOf(t, next) : null;
  }, [downloads, all, workId, account, t]);
}
